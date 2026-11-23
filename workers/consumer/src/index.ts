import { EmailMessage } from 'cloudflare:email';
import { buildEmail, estimateRawSize, formatListId, textToHtml, type AttachmentPart } from '../../../shared/mime';
import { getAttachmentBytes } from '../../../shared/attachments';
import {
  getCampaign,
  getCampaignAttachments,
  markCampaignCompleteIfDone,
  writeLog,
  countSentSince,
  computeDemand,
  getTrackingConsents,
  loadWarmupState,
  advanceWarmupState,
  saveDailyCap,
} from '../../../shared/db';
import {
  RETRY_DELAYS_MS,
  adoptLegacyBatch,
  claimedSends,
  classifySendError,
  completeSend,
  dispatch,
  dropSend,
  isDispatchMessage,
  isLegacyMessage,
  isSendMessage,
  pauseDispatch,
  releaseBatch,
  retrySendLater,
  scheduleDispatch,
  suppressSubscriber,
  tickReceived,
  type ClaimedSend,
} from '../../../shared/dispatch';
import { instrumentHtml, unsubscribeUrl, signDownloadUrl, mailtoUnsubscribeAddress } from '../../../shared/tracking';
import {
  prepareIncomingFooterHtml,
  renderFooterHtml,
  renderFooterText,
  renderIncomingFooterHtml,
  renderIncomingFooterText,
  resolveFooter,
} from '../../../shared/footer';
import { applyMailMerge, fullName } from '../../../shared/mail-merge';
import type { QueueMessage } from '../../../shared/types';
import {
  readWarmupConfig,
  progressWarmup,
  appliedDailyCap,
  normalizeDailyCap,
  dayStartSql,
  type WarmupConfig,
  type WarmupState,
} from '../../../shared/warmup';
import { fetchAccountSendingQuota } from '../../../shared/quota';
import { defaultSender, loadSettings, resolveTrackingBaseUrl, trackingEnabledGlobally } from '../../../shared/settings';

export interface Env {
  DB: D1Database;
  ARCHIVE: R2Bucket;
  SEND_EMAIL: SendEmail;
  QUEUE: Queue<QueueMessage>;
  TRACKING_BASE_URL: string;
  TRACKING_ENABLED: string;
  // Global default email footer (used when a newsletter has no footer of its
  // own). Already sanitized when stored via the Settings page.
  DEFAULT_FOOTER_HTML: string;
  DEFAULT_FOOTER_TEXT: string;
  // Unsubscribe-by-email and Message-IDs use the sending domain.
  BASE_DOMAIN: string;
  MAX_RAW_BYTES: string;
  // Recipients per dispatched batch.
  BATCH_SIZE: string;
  LINK_SIGNING_KEY: string;
  ATTACHMENT_SIGNING_KEY: string;
  // Warmup settings (with built-in defaults). Warmup is always on;
  // target weekly is derived from the last schedule element.
  WARMUP_SCHEDULE?: string;
  DAILY_CAP_FALLBACK?: string;
  // Used to read the account's daily sending quota from the Cloudflare API
  // once per UTC day. ACCESS_ACCOUNT_ID is a setting (resolved from D1);
  // CF_READ_API_TOKEN is a Worker secret. If either is missing, the warmup
  // daily cap falls back to the hardwired default.
  ACCESS_ACCOUNT_ID?: string;
  CF_READ_API_TOKEN?: string;
}

type CampaignEntry = { campaign: NonNullable<Awaited<ReturnType<typeof getCampaign>>>; parts: AttachmentPart[]; allAtts: Awaited<ReturnType<typeof getCampaignAttachments>> };

export default {
  async queue(batch: MessageBatch<QueueMessage>, rawEnv: Env, _ctx: ExecutionContext): Promise<void> {
    // Resolve tunables (sending identity, size cap, warmup) against the D1
    // `settings` table once per invocation; env vars / defaults are the
    // fallback. Bindings and secrets on `rawEnv` are preserved.
    const env = await loadSettings(rawEnv.DB, rawEnv);
    env.TRACKING_BASE_URL = resolveTrackingBaseUrl(env.TRACKING_BASE_URL, env.BASE_DOMAIN ?? '');

    // Cache campaign + attachments per batch lifetime.
    const cache = new Map<string, CampaignEntry>();
    // Any message keeps the dispatcher moving: it runs once at the end.
    let runDispatch = false;

    for (const msg of batch.messages) {
      const body: unknown = msg.body;
      try {
        if (isDispatchMessage(body)) {
          await tickReceived(env.DB, body.at);
          runDispatch = true;
        } else if (isSendMessage(body)) {
          await sendBatch(env, cache, body.campaignId, body.batchId);
          runDispatch = true;
        } else if (isLegacyMessage(body)) {
          const adopted = await adoptLegacyBatch(env.DB, body.campaignId, body.batch);
          await writeLog(env.DB, {
            source: 'consumer',
            event: 'consumer.legacy_batch',
            campaignId: body.campaignId,
            message: `Batch queued by an earlier release: ${adopted} of ${body.batch.length} recipient(s) scheduled for dispatch`,
            detail: { recipients: body.batch.length, adopted },
          });
          runDispatch = true;
        } else {
          await writeLog(env.DB, { level: 'warn', source: 'consumer', event: 'consumer.unknown_message', message: 'Ignored an unrecognized queue message' });
        }
        msg.ack();
      } catch (err) {
        // Safe to redeliver: only rows still pending are sent (shared/dispatch.ts).
        console.error('queue message error', err);
        await writeLog(env.DB, {
          level: 'error',
          source: 'consumer',
          event: 'consumer.batch_error',
          campaignId: (body as { campaignId?: string })?.campaignId ?? null,
          message: `Queue message failed — retrying: ${(err as Error).message}`,
          detail: { error: (err as Error).message },
        });
        msg.retry();
      }
    }

    if (runDispatch) {
      try {
        await dispatchWithinBudget(env);
      } catch (err) {
        console.error('dispatch error', err);
        await writeLog(env.DB, {
          level: 'error',
          source: 'consumer',
          event: 'consumer.dispatch_error',
          message: `Dispatch failed — retrying in a minute: ${(err as Error).message}`,
          detail: { error: (err as Error).message },
        });
        await scheduleDispatch(env, Date.now() + 60_000).catch(console.error);
      }
    }
  },
};

/**
 * Run the dispatcher with today's remaining budget: the smaller of the warmup
 * ramp cap and the Cloudflare account quota, minus what was sent today.
 */
async function dispatchWithinBudget(env: Env): Promise<void> {
  const cfg = readWarmupConfig(env as unknown as Record<string, string | undefined>);
  const now = new Date();
  const todayStr = now.toISOString().slice(0, 10);

  // Daily cap: read the account quota from the Cloudflare API once per UTC
  // day (cached in warmup_state).
  let state = await loadWarmupState(env.DB);
  const dailyCap = await ensureDailyCap(env, state, todayStr, cfg);

  // Demand-driven progression: advance one warmup day per calendar day when
  // there is demand, staying put when nothing is waiting.
  const demand = await computeDemand(env.DB);
  const prog = progressWarmup(state, demand, now, cfg);
  if (prog.changed) {
    const won = await advanceWarmupState(env.DB, { day: prog.day, dayStartedAt: prog.dayStartedAt }, state.dayStartedAt);
    state = won ? { ...state, day: prog.day, dayStartedAt: prog.dayStartedAt } : await loadWarmupState(env.DB);
  }

  const warmupDailyCap = appliedDailyCap(state.day, cfg);
  const sentToday = await countSentSince(env.DB, dayStartSql(now));
  const effectiveDailyCap = Math.min(warmupDailyCap, dailyCap);
  const result = await dispatch(env, {
    capacity: Math.max(0, effectiveDailyCap - sentToday),
    batchSize: Number(env.BATCH_SIZE) || 100,
    nextWindowMs: nextWindowMs(now),
  }, now.getTime());
  if (result.batches > 0 || result.reason === 'paused' || (result.nextTickAt !== null && result.claimed === 0)) {
    await writeLog(env.DB, {
      level: result.reason === 'paused' ? 'warn' : 'info',
      source: 'consumer',
      event: 'consumer.dispatch',
      message: result.reason === 'paused'
        ? 'Sending paused after an account-level error; dispatch resumes automatically'
        : result.batches > 0
          ? `Dispatched ${result.claimed} recipient(s) in ${result.batches} batch(es)`
          : 'Daily sending budget reached — the remaining recipients continue in the next window',
      detail: {
        ...result, warmupDailyCap, dailyCap, sentToday, day: state.day,
        nextTickAt: result.nextTickAt === null ? null : new Date(result.nextTickAt).toISOString(),
      },
    });
  }
}

function nextWindowMs(now: Date): number {
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
}

async function campaignEntry(env: Env, cache: Map<string, CampaignEntry>, campaignId: string): Promise<CampaignEntry | null> {
  const cached = cache.get(campaignId);
  if (cached) return cached;
  const campaign = await getCampaign(env.DB, campaignId);
  if (!campaign) return null;
  const allAtts = await getCampaignAttachments(env.DB, campaignId);
  const parts: AttachmentPart[] = [];
  // Skip attaching files in link mode; only inline images stay attached.
  for (const a of allAtts) {
    if (campaign.link_mode && a.disposition === 'attachment') continue;
    const bytes = await getAttachmentBytes(env.ARCHIVE, a.r2_key);
    parts.push({
      filename: a.filename,
      contentType: a.content_type,
      bytes,
      contentId: a.content_id ?? undefined,
      disposition: a.disposition,
    });
  }
  const entry = { campaign, parts, allAtts };
  cache.set(campaignId, entry);
  return entry;
}

/** Send one dispatched batch: exactly its rows that are still pending. */
async function sendBatch(env: Env, cache: Map<string, CampaignEntry>, campaignId: string, batchId: string): Promise<void> {
  const rows = await claimedSends(env.DB, campaignId, batchId);
  if (!rows.length) return; // Already processed, or released and re-dispatched.
  const entry = await campaignEntry(env, cache, campaignId);
  if (!entry) return; // Campaign deleted; its sends went with it.
  const { campaign, parts, allAtts } = entry;
  await writeLog(env.DB, {
    source: 'consumer',
    event: 'consumer.batch_received',
    campaignId,
    message: `Processing batch of ${rows.length} recipient(s)`,
    detail: { recipients: rows.length, batchId },
  });

  // Pre-flight size guard (estimate; per-recipient adds tracking). Oversize is a
  // permanent, campaign-level condition (normally caught at ingest).
  const estimate = estimateRawSize((campaign.text ?? '').length, (campaign.html ?? '').length, parts);
  if (estimate > Number(env.MAX_RAW_BYTES)) {
    const reason = `message too large (${estimate} bytes; limit ${env.MAX_RAW_BYTES})`;
    for (const r of rows) await completeSend(env.DB, r.send_id, campaignId, 'failed', { error: reason });
    await writeLog(env.DB, {
      level: 'error',
      source: 'consumer',
      event: 'consumer.batch_too_large',
      campaignId,
      message: `Batch dropped — ${reason}`,
      detail: { estimate, limit: Number(env.MAX_RAW_BYTES), recipients: rows.length },
    });
    await markCampaignCompleteIfDone(env.DB, campaignId);
    return;
  }

  // Subscribers who unsubscribed, bounced or became unconfirmed since ingest
  // are not sent to; they leave the campaign's total.
  const active: ClaimedSend[] = [];
  for (const r of rows) {
    if (r.subscriber_status === 'active' && r.confirm_token === null) active.push(r);
    else await dropSend(env.DB, r.send_id, campaignId);
  }

  const consents = trackingEnabledGlobally(env) && campaign.newsletter_tracking_enabled === 1
    ? await getTrackingConsents(env.DB, active.map((r) => r.subscriber_id))
    : new Set<number>();
  const now = Date.now();
  let sentInBatch = 0;
  let failedInBatch = 0;
  let retriedInBatch = 0;
  for (const r of active) {
    try {
      const mergeIncoming = campaign.mail_merge_incoming === 1;
      const vars = { first_name: r.first_name ?? undefined, last_name: r.last_name ?? undefined };
      // Campaigns authored in plain text get an HTML body derived from the
      // text, so HTML-preferring clients don't show an empty message.
      const sourceHtml = campaign.html?.trim() ? campaign.html : textToHtml(campaign.text ?? '');
      let body = { html: sourceHtml, text: campaign.text ?? '' };
      const footerIncoming = campaign.footer_incoming === 1;
      if (mergeIncoming) body = applyMailMerge(campaign, vars, body.html, body.text);
      if (footerIncoming) body.html = prepareIncomingFooterHtml(body.html);
      let html = await renderRecipientHtml(env, { ...campaign, html: body.html }, allAtts, r.subscriber_id, consents.has(r.subscriber_id));
      let text = body.text;
      // Incoming placeholders are resolved before tracking; the separate
      // header stays outside tracking, matching the existing prepend mode.
      if (!mergeIncoming) ({ html, text } = applyMailMerge(campaign, vars, html, text));
      const unsubUrl = unsubscribeUrl(env.TRACKING_BASE_URL, r.subscriber_id, r.token, campaignId);
      // Append the footer AFTER tracking instrumentation so its
      // unsubscribe/author links are never click-rewritten. The footer is
      // per-newsletter, falling back to the global default; the renderers
      // guarantee an unsubscribe link even if the {{unsubscribe_url}}
      // token is omitted. Stored footers are already sanitized.
      const footerVars = {
        unsubscribe_url: unsubUrl,
        newsletter_name: campaign.newsletter_name ?? '',
        email: r.email,
      };
      if (footerIncoming) {
        html = renderIncomingFooterHtml(html, footerVars);
        text = renderIncomingFooterText(text, footerVars);
      } else {
        html += '\n' + renderFooterHtml(resolveFooter(campaign.footer_html, env.DEFAULT_FOOTER_HTML), footerVars);
        const footerText = renderFooterText(resolveFooter(campaign.footer_text, env.DEFAULT_FOOTER_TEXT), footerVars);
        text += (text && !text.endsWith('\n') ? '\n\n' : '') + footerText.replace(/^\n/, '');
      }
      const messageId = `${crypto.randomUUID()}@${env.BASE_DOMAIN}`;
      // Per-newsletter sender if set, otherwise the global default.
      const fromHeader = campaign.from_address || defaultSender(env.BASE_DOMAIN);
      const fromAddr = extractAddr(fromHeader);

      const raw = buildEmail({
        from: fromHeader,
        to: { name: fullName(r.first_name ?? undefined, r.last_name ?? undefined), email: r.email },
        subject: campaign.subject,
        messageId,
        replyTo: campaign.reply_to_address ?? undefined,
        text,
        html,
        attachments: parts,
        headers: {
          'List-Unsubscribe': `<${unsubUrl}>, <mailto:${mailtoUnsubscribeAddress(r.subscriber_id, r.token, env.BASE_DOMAIN)}>`,
          'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
          'List-Id': formatListId(campaign.newsletter_name, campaign.newsletter_id, env.BASE_DOMAIN),
          'X-Campaign-ID': campaignId,
        },
      });

      const email = new EmailMessage(fromAddr, r.email, raw);
      await env.SEND_EMAIL.send(email);
      await completeSend(env.DB, r.send_id, campaignId, 'sent', { messageId });
      sentInBatch++;
      await writeLog(env.DB, {
        source: 'consumer',
        event: 'consumer.send_success',
        campaignId,
        message: `Sent to ${r.email}`,
        detail: { email: r.email, subscriberId: r.subscriber_id, messageId },
      });
    } catch (err) {
      const message = (err as Error).message;
      const action = classifySendError(err, now, nextWindowMs(new Date(now)));
      if (action.kind === 'pause') {
        // Account-level: nobody in this batch is at fault. Pause all dispatching
        // and return the unsent rows (this one included) to the backlog.
        await pauseDispatch(env.DB, action.untilMs, `${action.code}: ${message}`);
        await releaseBatch(env.DB, batchId);
        await scheduleDispatch(env, action.untilMs);
        await writeLog(env.DB, {
          level: 'warn',
          source: 'consumer',
          event: 'consumer.send_paused',
          campaignId,
          message: `Sending paused until ${new Date(action.untilMs).toISOString()} (${action.code}): ${message}`,
          detail: { code: action.code, error: message, until: new Date(action.untilMs).toISOString(), batchId },
        });
        break;
      }
      if (action.kind === 'retry' && r.attempts < RETRY_DELAYS_MS.length) {
        const at = Math.ceil((now + RETRY_DELAYS_MS[r.attempts]!) / 1000) * 1000;
        await retrySendLater(env.DB, r.send_id, r.attempts + 1, at, message);
        await scheduleDispatch(env, at);
        retriedInBatch++;
        await writeLog(env.DB, {
          level: 'warn',
          source: 'consumer',
          event: 'consumer.send_retry',
          campaignId,
          message: `Temporary failure sending to ${r.email} — retrying at ${new Date(at).toISOString()}: ${message}`,
          detail: { email: r.email, subscriberId: r.subscriber_id, attempt: r.attempts + 1, error: message },
        });
        continue;
      }
      if (action.kind === 'suppressed') await suppressSubscriber(env.DB, campaignId, r.subscriber_id, action.code);
      await completeSend(env.DB, r.send_id, campaignId, 'failed', { error: action.code ? `${action.code}: ${message}` : message });
      failedInBatch++;
      await writeLog(env.DB, {
        level: 'error',
        source: 'consumer',
        event: 'consumer.send_failed',
        campaignId,
        message: `Failed to send to ${r.email}: ${message}`,
        detail: { email: r.email, subscriberId: r.subscriber_id, code: action.code, error: message, suppressed: action.kind === 'suppressed' },
      });
    }
  }
  await writeLog(env.DB, {
    level: failedInBatch > 0 ? 'warn' : 'info',
    source: 'consumer',
    event: 'consumer.batch_done',
    campaignId,
    message: `Batch complete: ${sentInBatch} sent, ${failedInBatch} failed${retriedInBatch ? `, ${retriedInBatch} retrying later` : ''}`,
    detail: { sent: sentInBatch, failed: failedInBatch, retrying: retriedInBatch },
  });
  // Once every recipient has been processed, mark the campaign sent.
  if (await markCampaignCompleteIfDone(env.DB, campaignId)) {
    await writeLog(env.DB, {
      source: 'consumer',
      event: 'consumer.campaign_complete',
      campaignId,
      message: 'All recipients processed — campaign marked done',
    });
  }
}

async function renderRecipientHtml(
  env: Env,
  campaign: { id: string; html: string | null; link_mode: number },
  attachments: Awaited<ReturnType<typeof getCampaignAttachments>>,
  subscriberId: number,
  trackingConsent: boolean,
): Promise<string> {
  let html = campaign.html ?? '';
  if (campaign.link_mode) {
    const links: string[] = [];
    for (const a of attachments) {
      if (a.disposition === 'inline') continue;
      const url = await signDownloadUrl(
        env.TRACKING_BASE_URL,
        env.ATTACHMENT_SIGNING_KEY,
        campaign.id,
        subscriberId,
        a.id,
      );
      links.push(`<li><a href="${url}">${escapeHtml(a.filename)}</a> (${a.size} bytes)</li>`);
    }
    if (links.length) {
      html += `<hr><p><strong>Attachments:</strong></p><ul>${links.join('')}</ul>`;
    }
  }
  // Open/click tracking is optional. When disabled, links are left pointing at
  // their original destinations and no open pixel is added. Link-mode download
  // links above are unaffected — they deliver the attachments themselves.
  if (!trackingConsent) return html;
  return await instrumentHtml(html, env.TRACKING_BASE_URL, env.LINK_SIGNING_KEY, campaign.id, subscriberId);
}

function extractAddr(header: string): string {
  const m = header.match(/<([^>]+)>/);
  return m?.[1] ?? header.trim();
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}

/**
 * Returns the warmup daily cap, reading the account's quota from the Cloudflare
 * API at most once per UTC day (cached in `warmup_state`). On a fresh read the
 * passed `state` is mutated so the rest of the invocation sees the new value.
 * Falls back to the last cached value or the configured fallback when the token
 * or account is missing, or the API call fails.
 */
async function ensureDailyCap(
  env: Env,
  state: WarmupState,
  todayStr: string,
  cfg: WarmupConfig,
): Promise<number> {
  if (state.dailyCap != null && state.dailyCapDate === todayStr) return state.dailyCap;
  const token = env.CF_READ_API_TOKEN;
  const account = env.ACCESS_ACCOUNT_ID;
  if (token && account) {
    try {
      const quota = await fetchAccountSendingQuota(token, account);
      const cap = normalizeDailyCap(quota, cfg.fallbackDailyCap);
      await saveDailyCap(env.DB, cap, todayStr);
      state.dailyCap = cap;
      state.dailyCapDate = todayStr;
      return cap;
    } catch (err) {
      await writeLog(env.DB, {
        level: 'warn',
        source: 'consumer',
        event: 'consumer.quota_fetch_failed',
        message: `Daily quota fetch failed: ${(err as Error).message}`,
        detail: { error: (err as Error).message },
      });
    }
  }
  return state.dailyCap ?? cfg.fallbackDailyCap;
}
