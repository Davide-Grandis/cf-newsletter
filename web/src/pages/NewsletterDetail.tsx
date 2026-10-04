import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { api, Newsletter } from '../api';
import { useIdentity, canEditNewsletter } from '../auth';
import Subscribers from './Subscribers';
import Authors from './Authors';
import NewsletterAdmins from './NewsletterAdmins';
import { LocalPartInput, localPart } from './Newsletters';

type Tab = 'subscribers' | 'authors' | 'admins' | 'footer' | 'signup';

export default function NewsletterDetail() {
  const { id = '' } = useParams();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [tab, setTab] = useState<Tab>('admins');
  const [warn, setWarn] = useState<string | null>(null);
  const [editingSettings, setEditingSettings] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const detail = useQuery({
    queryKey: ['newsletter', id],
    queryFn: () => api<Newsletter>(`/api/newsletters/${id}`),
  });

  // Fixed sending domain + default sender come from the identity payload
  // (admins cannot read the super_admin-only settings endpoint).
  const me = useIdentity();
  const domain = me.data?.base_domain ?? '';
  const defaultSenderLocal = localPart(me.data?.from_address ?? '');
  // Read-only admins may view but not change the newsletter; super admins and
  // edit-admins may edit.
  const canEdit = canEditNewsletter(me.data, id);
  const canDelete = canEdit && (me.data?.role === 'super_admin' || !!me.data?.allow_admin_newsletter_crud);

  // Admin count for the tab label. Shares the same query key that
  // NewsletterAdmins invalidates on add/remove, so it updates immediately.
  const adminsList = useQuery({
    queryKey: ['newsletter-admins', id],
    queryFn: () => api<{ items: { email: string; capability: string }[] }>(`/api/newsletters/${id}/admins`),
    enabled: !!id,
  });
  const adminCount = adminsList.data?.items.length;

  const patch = useMutation({
    mutationFn: (
      body: Partial<
        Pick<Newsletter, 'name' | 'inbound_address' | 'from_address' | 'reply_to_address' | 'footer_html' | 'footer_text' | 'slug'>
      > & { enabled?: boolean; allow_public_signup?: boolean; reply_to_author?: boolean },
    ) => api<{ routing_warning?: string }>(`/api/newsletters/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
    onSuccess: async (res) => {
      setWarn(res.routing_warning ?? null);
      await Promise.all([
        qc.invalidateQueries({ queryKey: ['newsletter', id] }),
        qc.invalidateQueries({ queryKey: ['newsletters'] }),
      ]);
    },
  });
  const saveSettings = (body: {
    name?: string;
    inbound_address?: string;
    from_address?: string | null;
    reply_to_address?: string | null;
    reply_to_author?: boolean;
  }) =>
    patch.mutateAsync(body);
  const saveFooter = (body: { footer_html?: string | null; footer_text?: string | null }) =>
    patch.mutateAsync(body);
  const saveSignup = (body: { slug?: string; allow_public_signup?: boolean }) => patch.mutateAsync(body);
  const deleteNewsletter = useMutation({
    mutationFn: () => api<{ routing_warning?: string }>(`/api/newsletters/${id}`, { method: 'DELETE' }),
    onSuccess: async (res) => {
      await qc.invalidateQueries({ queryKey: ['newsletters'] });
      navigate('/newsletters', {
        state: { newsletter_deleted: true, routing_warning: res.routing_warning ?? null },
      });
    },
    onError: async (e) => {
      setDeleteError((e as Error).message);
      await qc.invalidateQueries({ queryKey: ['newsletter', id] });
    },
  });

  if (detail.isLoading) return <div className="text-sm text-slate-500 dark:text-slate-400">Loading…</div>;
  if (detail.error) return <div className="text-sm text-red-600">{(detail.error as Error).message}</div>;
  if (!detail.data) return null;
  const n = detail.data;
  const campaignCount = n.campaign_count;
  const deleteDisabled = typeof campaignCount !== 'number' || campaignCount > 0 || deleteNewsletter.isPending;
  const deleteTooltip = typeof campaignCount !== 'number'
    ? 'Campaign count unavailable'
    : campaignCount > 0
      ? 'Cannot delete, the newsletter has campaigns'
      : 'Delete newsletter';

  return (
    <div className="space-y-6">
      <div className="-mb-5">
        <Link to="/newsletters" className="text-sm text-slate-500 hover:underline dark:text-slate-400">← Newsletters</Link>
        <div className="flex items-center gap-2 mt-1 pt-1 pb-[0.35rem]">
          <h1 className="text-xl font-semibold">{n.name}</h1>
          {canEdit && !editingSettings && (
            <>
              <button
                type="button"
                aria-label="Edit newsletter"
                title="Edit newsletter"
                onClick={() => setEditingSettings(true)}
                className="inline-flex h-7 w-7 items-center justify-center rounded border border-slate-300 text-slate-600 hover:bg-slate-100 dark:border-slate-600 dark:text-slate-300 dark:hover:bg-slate-800"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M12 20h9" />
                  <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L8 18l-4 1 1-4Z" />
                </svg>
              </button>
              {canDelete && (
                <span className="inline-flex" title={deleteTooltip}>
                  <button
                    type="button"
                    aria-label="Delete newsletter"
                    disabled={deleteDisabled}
                    onClick={() => {
                      setDeleteError(null);
                      setConfirmDelete(true);
                    }}
                    className="inline-flex h-7 w-7 items-center justify-center rounded border border-slate-300 text-red-500 disabled:cursor-not-allowed disabled:opacity-50 dark:border-slate-600 dark:text-red-400"
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <path d="M3 6h18" />
                      <path d="M8 6V4h8v2" />
                      <path d="m19 6-1 14H6L5 6" />
                      <path d="M10 11v6M14 11v6" />
                    </svg>
                  </button>
                </span>
              )}
            </>
          )}
        </div>
      </div>

      {warn && (
        <div className="flex items-start gap-2 text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded p-2 dark:text-amber-300 dark:bg-amber-900/30 dark:border-amber-800/60">
          <span className="flex-1">{warn}</span>
          <button onClick={() => setWarn(null)} className="text-amber-600 hover:underline dark:text-amber-400">dismiss</button>
        </div>
      )}

      <Settings
        n={n}
        domain={domain}
        defaultSenderLocal={defaultSenderLocal}
        canEdit={canEdit}
        editing={editingSettings}
        onCancel={() => setEditingSettings(false)}
        onSaved={() => setEditingSettings(false)}
        onSave={saveSettings}
        saving={patch.isPending}
      />

      {confirmDelete && (
        <ConfirmDialog
          open={confirmDelete}
          title="Delete newsletter?"
          message={deleteError ?? `This permanently deletes ${n.name}, its subscribers, authors, and admin assignments. It cannot be undone.`}
          confirmLabel="Delete"
          cancelLabel="Cancel"
          danger
          busy={deleteNewsletter.isPending}
          onConfirm={() => {
            setDeleteError(null);
            deleteNewsletter.mutate();
          }}
          onCancel={() => {
            setConfirmDelete(false);
            setDeleteError(null);
          }}
        />
      )}

      <div>
        <div className="flex gap-1 border-b border-slate-200 dark:border-slate-800 mb-4">
          <TabButton active={tab === 'admins'} onClick={() => setTab('admins')}>
            Admins {typeof adminCount === 'number' ? `(${adminCount})` : ''}
          </TabButton>
          <TabButton active={tab === 'authors'} onClick={() => setTab('authors')}>
            Authors {typeof n.author_count === 'number' ? `(${n.author_count})` : ''}
          </TabButton>
          <TabButton active={tab === 'subscribers'} onClick={() => setTab('subscribers')}>
            Subscribers {typeof n.subscriber_count === 'number' ? `(${n.subscriber_count})` : ''}
          </TabButton>
          <TabButton active={tab === 'footer'} onClick={() => setTab('footer')}>
            Footer
          </TabButton>
          <TabButton active={tab === 'signup'} onClick={() => setTab('signup')}>
            Signup
          </TabButton>
        </div>
        {tab === 'subscribers' ? (
          <Subscribers newsletterId={id} canEdit={canEdit} />
        ) : tab === 'authors' ? (
          <Authors newsletterId={id} canEdit={canEdit} />
        ) : tab === 'footer' ? (
          <FooterEditor
            n={n}
            canEdit={canEdit}
            onSave={saveFooter}
            saving={patch.isPending}
            defaultHtml={me.data?.default_footer_html ?? ''}
            defaultText={me.data?.default_footer_text ?? ''}
          />
        ) : tab === 'signup' ? (
          <SignupEditor
            n={n}
            canEdit={canEdit}
            onSave={saveSignup}
            saving={patch.isPending}
            subscribeBase={me.data?.tracking_base_url ?? ''}
            baseDomain={me.data?.base_domain ?? ''}
          />
        ) : (
          <NewsletterAdmins newsletterId={id} canManage={canEdit} />
        )}
      </div>
    </div>
  );
}

function Settings({
  n,
  domain,
  defaultSenderLocal,
  canEdit,
  editing,
  onCancel,
  onSaved,
  onSave,
  saving,
}: {
  n: Newsletter;
  domain: string;
  defaultSenderLocal: string;
  canEdit: boolean;
  editing: boolean;
  onCancel: () => void;
  onSaved: () => void;
  onSave: (body: {
    name?: string;
    inbound_address?: string;
    from_address?: string | null;
    reply_to_address?: string | null;
    reply_to_author?: boolean;
  }) => Promise<unknown>;
  saving: boolean;
}) {
  const [name, setName] = useState(n.name);
  const [inbound, setInbound] = useState(localPart(n.inbound_address));
  const [sender, setSender] = useState(localPart(n.from_address ?? ''));
  const [replyToAddress, setReplyToAddress] = useState(n.reply_to_address ?? '');
  const [replyToAuthor, setReplyToAuthor] = useState(n.reply_to_author === 1);
  const [error, setError] = useState<string | null>(null);
  const nameInputRef = useRef<HTMLInputElement>(null);
  const senderInputRef = useRef<HTMLInputElement>(null);
  const inboundInputRef = useRef<HTMLInputElement>(null);
  const replyToInputRef = useRef<HTMLInputElement>(null);

  useLayoutEffect(() => {
    if (!editing) return;
    setName(n.name);
    setInbound(localPart(n.inbound_address));
    setSender(localPart(n.from_address ?? ''));
    setReplyToAddress(n.reply_to_address ?? '');
    setReplyToAuthor(n.reply_to_author === 1);
    setError(null);
    nameInputRef.current?.setCustomValidity('');
  }, [editing, n.name, n.inbound_address, n.from_address, n.reply_to_address, n.reply_to_author]);

  function reset() {
    setName(n.name);
    setInbound(localPart(n.inbound_address));
    setSender(localPart(n.from_address ?? ''));
    setReplyToAddress(n.reply_to_address ?? '');
    setReplyToAuthor(n.reply_to_author === 1);
    setError(null);
  }

  function showInputError(input: HTMLInputElement | null, message: string) {
    setError(message);
    if (!input) return;
    input.setCustomValidity(message);
    input.focus();
    input.reportValidity();
  }

  const dirty =
    name.trim() !== n.name ||
    inbound.trim() !== localPart(n.inbound_address) ||
    sender.trim() !== localPart(n.from_address ?? '') ||
    replyToAddress.trim() !== (n.reply_to_address ?? '') ||
    replyToAuthor !== (n.reply_to_author === 1);

  async function save() {
    if (!dirty) {
      onSaved();
      return;
    }
    setError(null);
    const trimmedName = name.trim();
    if (trimmedName !== n.name) {
      if (!trimmedName) {
        showInputError(nameInputRef.current, 'Please add a name.');
        return;
      }
      if (trimmedName.length < 3) {
        showInputError(nameInputRef.current, 'Invalid name, too short. Min lenght is 3 characters.');
        return;
      }
    }
    if (sender && !/^[^\s@]+$/.test(sender)) {
      showInputError(senderInputRef.current, 'Sender must be a valid email prefix with no spaces.');
      return;
    }
    const trimmedInbound = inbound.trim();
    if (!trimmedInbound) {
      showInputError(inboundInputRef.current, 'Inbound address is required.');
      return;
    }
    if (!/^[^\s@]+$/.test(inbound)) {
      showInputError(inboundInputRef.current, 'Inbound address must be a valid email prefix with no spaces.');
      return;
    }
    const replyTo = replyToAddress.trim();
    if (!replyToAuthor && replyTo && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(replyTo)) {
      showInputError(replyToInputRef.current, 'Invalid input, please add a valid email address.');
      return;
    }
    try {
      await onSave({
        name: trimmedName === n.name ? undefined : trimmedName,
        inbound_address: `${trimmedInbound}@${domain}`,
        from_address: sender.trim() ? `${sender.trim()}@${domain}` : '',
        reply_to_address: replyTo,
        reply_to_author: replyToAuthor,
      });
      setName(trimmedName);
      setInbound(trimmedInbound.toLowerCase());
      setSender(sender.trim().toLowerCase());
      setReplyToAddress(replyTo.toLowerCase());
      onSaved();
    } catch (e) {
      const message = (e as Error).message;
      if (/inbound[_ ]address/i.test(message)) showInputError(inboundInputRef.current, message);
      else if (/from_address|sender/i.test(message)) showInputError(senderInputRef.current, message);
      else if (/reply[_ -]?to|email address/i.test(message)) showInputError(replyToInputRef.current, message);
      else if (/name/i.test(message)) showInputError(nameInputRef.current, message);
      else setError(message);
    }
  }

  return (
    <section
      className={`rounded border p-3 bg-white dark:bg-slate-900 ${
        editing ? 'border-orange-500 dark:border-orange-400' : 'border-slate-200 dark:border-slate-800'
      }`}
    >
      {editing ? (
        <form
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
          className="flex flex-col gap-3 md:flex-row md:items-start"
        >
          <div className="min-w-0 flex-1 flex flex-col gap-4">
            <div className="grid grid-cols-1 md:grid-cols-[45%_45%] gap-2 items-end">
              <div className="min-w-0">
                <label className="text-xs uppercase tracking-wide text-slate-500 dark:text-slate-400">Name</label>
                <input
                  ref={nameInputRef}
                  name="name"
                  value={name}
                  required
                  minLength={3}
                  onInvalid={(e) => {
                    const message = e.currentTarget.value.trim()
                      ? 'Invalid name, too short. Min lenght is 3 characters.'
                      : 'Please add a name.';
                    e.currentTarget.setCustomValidity(message);
                    setError(message);
                  }}
                  onChange={(e) => setName(e.target.value)}
                  onInput={(e) => {
                    const value = e.currentTarget.value.trim();
                    e.currentTarget.setCustomValidity(
                      !value
                        ? 'Please add a name.'
                        : value.length < 3
                          ? 'Invalid name, too short. Min lenght is 3 characters.'
                          : '',
                    );
                    setError((current) =>
                      current === 'Please add a name.' || current === 'Invalid name, too short. Min lenght is 3 characters.'
                        ? null
                        : current,
                    );
                  }}
                  placeholder="Weekly digest"
                  className={inputCls}
                />
              </div>
              <div className="min-w-0">
                <label className="text-xs uppercase tracking-wide text-slate-500 dark:text-slate-400">
                  Sender <span className="normal-case tracking-normal text-slate-400">(defaults to "newsletter")</span>
                </label>
                <LocalPartInput
                  value={sender}
                  onChange={(value) => {
                    setSender(value);
                    senderInputRef.current?.setCustomValidity('');
                    setError((current) => /sender|from_address/i.test(current ?? '') ? null : current);
                  }}
                  domain={domain}
                  placeholder={defaultSenderLocal || 'default'}
                  inputRef={senderInputRef}
                />
              </div>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-[45%_45%] gap-2 items-start">
              <div className="min-w-0">
                <label className="text-xs uppercase tracking-wide text-slate-500 dark:text-slate-400">Inbound address</label>
                <LocalPartInput
                  value={inbound}
                  onChange={(value) => {
                    setInbound(value);
                    inboundInputRef.current?.setCustomValidity('');
                    setError((current) => /inbound[_ ]address/i.test(current ?? '') ? null : current);
                  }}
                  domain={domain}
                  placeholder="digest"
                  inputRef={inboundInputRef}
                />
              </div>
              <div className="min-w-0 flex flex-col gap-2">
                <div>
                  <label className="text-xs uppercase tracking-wide text-slate-500 dark:text-slate-400">
                    Reply-To address <span className="normal-case tracking-normal text-slate-400">(optional)</span>
                  </label>
                  <input
                    ref={replyToInputRef}
                    type="text"
                    inputMode="email"
                    name="reply_to_address"
                    value={replyToAddress}
                    disabled={replyToAuthor}
                    onChange={(e) => {
                      setReplyToAddress(e.target.value);
                      replyToInputRef.current?.setCustomValidity('');
                      setError((current) => /reply[_ -]?to|email address/i.test(current ?? '') ? null : current);
                    }}
                    placeholder={replyToAuthor ? 'Using campaign author' : 'replies@example.com'}
                    className={inputCls}
                  />
                </div>
                <label className="flex items-center gap-2 text-sm text-slate-600 dark:text-slate-300">
                  <input
                    type="checkbox"
                    name="reply_to_author"
                    checked={replyToAuthor}
                    onChange={(e) => {
                      setReplyToAuthor(e.target.checked);
                      if (e.target.checked) {
                        setReplyToAddress('');
                        replyToInputRef.current?.setCustomValidity('');
                        setError((current) => /reply[_ -]?to|email address/i.test(current ?? '') ? null : current);
                      }
                    }}
                  />
                  Use campaign author’s email for replies
                </label>
              </div>
            </div>
            {error && <div className="text-xs text-red-600">{error}</div>}
          </div>
          <div className="flex flex-col gap-2 md:w-28">
            <button
              type="button"
              disabled={saving}
              onClick={() => {
                reset();
                onCancel();
              }}
              className="w-full text-sm rounded px-3 py-1.5 border border-slate-300 text-slate-600 hover:bg-slate-100 disabled:opacity-50 dark:border-slate-600 dark:text-slate-300 dark:hover:bg-slate-800"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={saving}
              className="w-full bg-slate-900 text-white text-sm rounded px-3 py-1.5 disabled:opacity-50 dark:bg-slate-100 dark:text-slate-900"
            >
              {saving ? 'Saving…' : 'Save'}
            </button>
          </div>
        </form>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div className="min-w-0">
            <label className="text-xs uppercase tracking-wide text-slate-500 dark:text-slate-400">Inbound address</label>
            <LocalPartInput value={localPart(n.inbound_address)} onChange={() => {}} domain={domain} disabled />
          </div>
          <div className="min-w-0">
            <label className="text-xs uppercase tracking-wide text-slate-500 dark:text-slate-400">
              Sender <span className="normal-case tracking-normal text-slate-400">(optional)</span>
            </label>
            <LocalPartInput
              value={localPart(n.from_address ?? '')}
              onChange={() => {}}
              domain={domain}
              disabled
              placeholder={defaultSenderLocal || 'default'}
            />
          </div>
          <div className="min-w-0 flex flex-col gap-2">
            <div>
              <label className="text-xs uppercase tracking-wide text-slate-500 dark:text-slate-400">
                Reply-To address <span className="normal-case tracking-normal text-slate-400">(optional)</span>
              </label>
              <input
                type="text"
                value={n.reply_to_address ?? ''}
                disabled
                placeholder={n.reply_to_author ? 'Using campaign author' : 'replies@example.com'}
                className={inputCls}
              />
            </div>
            <label className="flex items-center gap-2 text-sm text-slate-600 dark:text-slate-300">
              <input type="checkbox" checked={n.reply_to_author === 1} disabled />
              Use campaign author’s email for replies
            </label>
          </div>
        </div>
      )}
    </section>
  );
}

// Builds the live-preview HTML for the footer editor. Mirrors the consumer's
// render: substitute tokens with sample values and, if {{unsubscribe_url}} is
// absent, append an unsubscribe line so the preview matches what recipients
// get. No sanitization is needed here because the preview is shown in a
// sandboxed iframe (no scripts); the server sanitizes on save.
const SAMPLE_VARS: Record<string, string> = {
  unsubscribe_url: 'https://track.example.com/u/123?t=sample-token',
  newsletter_name: '',
  email: 'subscriber@example.com',
};
const FOOTER_TOKEN_RE = /\{\{\s*(unsubscribe_url|newsletter_name|email)\s*\}\}/g;

function buildFooterPreview(template: string, newsletterName: string): string {
  const vars: Record<string, string> = { ...SAMPLE_VARS, newsletter_name: newsletterName };
  const hadUnsub = /\{\{\s*unsubscribe_url\s*\}\}/.test(template);
  let body = template.replace(FOOTER_TOKEN_RE, (_m, k: string) => vars[k] ?? '');
  if (!hadUnsub) {
    body +=
      `\n<p style="font-size:12px;line-height:1.5;color:#64748b;margin:8px 0 0">` +
      `<a href="${vars.unsubscribe_url}" style="color:#64748b">Unsubscribe</a></p>`;
  }
  return (
    `<!doctype html><html><head><meta charset="utf-8">` +
    `<style>body{font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;` +
    `font-size:14px;color:#0f172a;margin:12px;background:#fff}a{color:#2563eb}</style></head>` +
    `<body>${body}</body></html>`
  );
}

// Plain-text counterpart of buildFooterPreview: substitute tokens and ensure
// an unsubscribe line is present, matching the consumer's text renderer.
function buildTextPreview(template: string, newsletterName: string): string {
  const vars: Record<string, string> = { ...SAMPLE_VARS, newsletter_name: newsletterName };
  const hadUnsub = /\{\{\s*unsubscribe_url\s*\}\}/.test(template);
  let body = template.replace(FOOTER_TOKEN_RE, (_m, k: string) => vars[k] ?? '');
  if (!hadUnsub) body += `\nUnsubscribe: ${vars.unsubscribe_url}`;
  return body;
}

function FooterEditor({
  n,
  canEdit,
  onSave,
  saving,
  defaultHtml,
  defaultText,
}: {
  n: Newsletter;
  canEdit: boolean;
  onSave: (body: { footer_html?: string | null; footer_text?: string | null }) => Promise<unknown>;
  saving: boolean;
  defaultHtml: string;
  defaultText: string;
}) {
  // The editor is pre-filled with the resolved value (the newsletter's own
  // override, or the global default when it has none) so operators customize an
  // existing footer instead of starting from a blank box. Clearing a field and
  // saving re-inherits the global default.
  const baselineHtml = n.footer_html && n.footer_html.trim() !== '' ? n.footer_html : defaultHtml;
  const baselineText = n.footer_text && n.footer_text.trim() !== '' ? n.footer_text : defaultText;
  const [editing, setEditing] = useState(false);
  const [html, setHtml] = useState(baselineHtml);
  const [text, setText] = useState(baselineText);
  const [error, setError] = useState<string | null>(null);

  // Keep the (read-only) view synced with the latest props until the user
  // starts editing. Needed because the global default arrives asynchronously
  // from /api/me and may not be present on first render.
  useEffect(() => {
    if (!editing) {
      setHtml(baselineHtml);
      setText(baselineText);
    }
  }, [editing, baselineHtml, baselineText]);

  function reset() {
    setHtml(baselineHtml);
    setText(baselineText);
    setError(null);
  }

  const dirty = html !== baselineHtml || text !== baselineText;
  const effectiveHtml = html.trim() === '' ? defaultHtml : html;
  const effectiveText = text.trim() === '' ? defaultText : text;
  const previewDoc = useMemo(() => buildFooterPreview(effectiveHtml, n.name), [effectiveHtml, n.name]);

  async function save() {
    if (!dirty) {
      setEditing(false);
      return;
    }
    setError(null);
    try {
      // Empty string clears the override so the newsletter inherits the global
      // default footer.
      await onSave({ footer_html: html.trim() ? html : '', footer_text: text.trim() ? text : '' });
      setEditing(false);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <section className="bg-white border border-slate-200 rounded p-3 dark:bg-slate-900 dark:border-slate-800">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">Email footer</h2>
        {!editing &&
          canEdit && (
            <button
              type="button"
              onClick={() => {
                reset();
                setEditing(true);
              }}
              className="text-sm rounded px-3 py-1.5 border border-slate-300 text-slate-700 hover:bg-slate-100 dark:border-slate-600 dark:text-slate-200 dark:hover:bg-slate-800"
            >
              Edit
            </button>
          )}
      </div>

      <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
        Appended to every email for this newsletter. Pre-filled with the global default so you can
        customize it; clear both fields to inherit the global default again. Tokens:{' '}
        <code className="bg-slate-100 px-1 rounded dark:bg-slate-800">{'{{unsubscribe_url}}'}</code>{' '}
        <code className="bg-slate-100 px-1 rounded dark:bg-slate-800">{'{{newsletter_name}}'}</code>{' '}
        <code className="bg-slate-100 px-1 rounded dark:bg-slate-800">{'{{email}}'}</code>. An
        unsubscribe link is always added even if you omit the token.
      </p>

      <div className="mt-3 grid gap-4 lg:grid-cols-2">
        <div>
          <label className="text-xs uppercase tracking-wide text-slate-500 dark:text-slate-400">
            HTML footer
          </label>
          <textarea
            value={html}
            disabled={!editing}
            onChange={(e) => setHtml(e.target.value)}
            rows={8}
            spellCheck={false}
            placeholder={defaultHtml || 'Inherits the global default footer when empty.'}
            className={`${inputCls} font-mono text-xs leading-relaxed`}
          />
          <label className="text-xs uppercase tracking-wide text-slate-500 dark:text-slate-400 mt-3 block">
            Plain-text footer
          </label>
          <textarea
            value={text}
            disabled={!editing}
            onChange={(e) => setText(e.target.value)}
            rows={4}
            spellCheck={false}
            placeholder={defaultText || 'Inherits the global default footer when empty.'}
            className={`${inputCls} font-mono text-xs leading-relaxed`}
          />
        </div>
        <div>
          <span className="text-xs uppercase tracking-wide text-slate-500 dark:text-slate-400">
            HTML preview
          </span>
          <iframe
            title="Footer preview"
            sandbox=""
            srcDoc={previewDoc}
            className="mt-0.5 w-full h-[160px] border border-slate-200 rounded bg-white dark:border-slate-700"
          />
          <label className="text-xs uppercase tracking-wide text-slate-500 dark:text-slate-400 mt-3 block">
            Text preview
          </label>
          <pre className="mt-0.5 w-full h-[90px] overflow-auto border border-slate-200 rounded bg-slate-50 p-2 text-xs whitespace-pre-wrap font-mono text-slate-700 dark:border-slate-700 dark:bg-slate-800/40 dark:text-slate-200">
            {buildTextPreview(effectiveText, n.name)}
          </pre>
          <p className="text-[11px] text-slate-400 dark:text-slate-500 mt-1">
            Preview uses sample values; links are not click-tracked in the actual footer.
          </p>
        </div>
      </div>

      {error && <p className="text-xs text-red-600 mt-2">{error}</p>}

      {editing && (
        <div className="mt-3 flex gap-2">
          <button
            type="button"
            disabled={!dirty || saving}
            onClick={save}
            className="bg-slate-900 text-white text-sm rounded px-3 py-1.5 disabled:opacity-50 dark:bg-slate-100 dark:text-slate-900"
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
          <button
            type="button"
            disabled={saving}
            onClick={() => {
              reset();
              setEditing(false);
            }}
            className="text-sm rounded px-3 py-1.5 border border-slate-300 text-slate-600 hover:bg-slate-100 disabled:opacity-50 dark:border-slate-600 dark:text-slate-300 dark:hover:bg-slate-800"
          >
            Cancel
          </button>
        </div>
      )}
    </section>
  );
}

function SignupEditor({
  n,
  canEdit,
  onSave,
  saving,
  subscribeBase,
  baseDomain,
}: {
  n: Newsletter;
  canEdit: boolean;
  onSave: (body: { slug?: string; allow_public_signup?: boolean }) => Promise<unknown>;
  saving: boolean;
  subscribeBase: string;
  baseDomain: string;
}) {
  const [editing, setEditing] = useState(false);
  const [slug, setSlug] = useState(n.slug ?? '');
  const [allow, setAllow] = useState((n.allow_public_signup ?? 0) === 1);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<'url' | 'embed' | null>(null);

  useEffect(() => {
    if (!editing) {
      setSlug(n.slug ?? '');
      setAllow((n.allow_public_signup ?? 0) === 1);
    }
  }, [editing, n.slug, n.allow_public_signup]);

  const dirty = slug.trim() !== (n.slug ?? '') || allow !== ((n.allow_public_signup ?? 0) === 1);
  // If tracking_base_url is still the placeholder default or empty, fall back
  // to constructing the URL from the actual sending domain.
  const resolvedBase =
    !subscribeBase || subscribeBase.includes('yourdomain.com')
      ? baseDomain ? `https://track.${baseDomain}` : ''
      : subscribeBase;
  const base = resolvedBase.replace(/\/+$/, '');
  // Use the saved slug for the live URL/snippet (the draft isn't public yet).
  const effectiveSlug = n.slug ?? '';
  const subscribeUrl = base && effectiveSlug ? `${base}/subscribe/${effectiveSlug}` : '';
  const embedSnippet = subscribeUrl
    ? `<iframe src="${subscribeUrl}" title="Subscribe to ${n.name}" ` +
      `style="width:100%;max-width:420px;height:340px;border:0" loading="lazy"></iframe>`
    : '';
  const slugValid = slug.trim() === '' || /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug.trim());

  function reset() {
    setSlug(n.slug ?? '');
    setAllow((n.allow_public_signup ?? 0) === 1);
    setError(null);
  }

  async function copy(kind: 'url' | 'embed', text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(kind);
      setTimeout(() => setCopied(null), 1500);
    } catch {
      /* clipboard unavailable; ignore */
    }
  }

  async function save() {
    if (!dirty) {
      setEditing(false);
      return;
    }
    if (!slugValid) {
      setError('Slug must be lowercase letters, numbers and single hyphens.');
      return;
    }
    setError(null);
    try {
      await onSave({ slug: slug.trim(), allow_public_signup: allow });
      setEditing(false);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <section className="bg-white border border-slate-200 rounded p-3 dark:bg-slate-900 dark:border-slate-800">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">Public signup</h2>
        {!editing && canEdit && (
          <button
            type="button"
            onClick={() => {
              reset();
              setEditing(true);
            }}
            className="text-sm rounded px-3 py-1.5 border border-slate-300 text-slate-700 hover:bg-slate-100 dark:border-slate-600 dark:text-slate-200 dark:hover:bg-slate-800"
          >
            Edit
          </button>
        )}
      </div>

      <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
        Let anyone subscribe from a hosted form using double opt-in (a confirmation email is sent
        before they are added). Bot protection is handled by Cloudflare Turnstile.
      </p>

      <div className="mt-3 space-y-3">
        <label className="flex items-center gap-2 text-sm text-slate-700 dark:text-slate-200">
          <input
            type="checkbox"
            checked={allow}
            disabled={!editing}
            onChange={(e) => setAllow(e.target.checked)}
            className="h-4 w-4"
          />
          Enable the public subscribe page for this newsletter
        </label>

        <div>
          <label className="text-xs uppercase tracking-wide text-slate-500 dark:text-slate-400">
            URL slug
          </label>
          <div className="flex items-center gap-2">
            <span className="text-xs text-slate-400 dark:text-slate-500 font-mono">
              {base ? `${base}/subscribe/` : '/subscribe/'}
            </span>
            <input
              value={slug}
              disabled={!editing}
              onChange={(e) => setSlug(e.target.value)}
              placeholder={editing ? 'leave empty to auto-generate from the name' : ''}
              spellCheck={false}
              className={`${inputCls} font-mono text-xs flex-1`}
            />
          </div>
          {editing && !slugValid && (
            <p className="text-xs text-red-600 mt-1">
              Use lowercase letters, numbers and single hyphens (e.g. <code>weekly-digest</code>).
            </p>
          )}
        </div>

        {!editing && (
          <div className="space-y-2">
            <div>
              <span className="text-xs uppercase tracking-wide text-slate-500 dark:text-slate-400">
                Public subscribe URL
              </span>
              {subscribeUrl ? (
                <div className="flex items-center gap-2 mt-0.5">
                  <a
                    href={subscribeUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="text-sm text-blue-600 hover:underline break-all dark:text-blue-400"
                  >
                    {subscribeUrl}
                  </a>
                  <button
                    type="button"
                    onClick={() => copy('url', subscribeUrl)}
                    className="text-xs rounded px-2 py-1 border border-slate-300 text-slate-600 hover:bg-slate-100 dark:border-slate-600 dark:text-slate-300 dark:hover:bg-slate-800 shrink-0"
                  >
                    {copied === 'url' ? 'Copied' : 'Copy'}
                  </button>
                </div>
              ) : (
                <p className="text-xs text-slate-400 dark:text-slate-500 mt-0.5 italic">
                  Set a slug to get a public URL.
                </p>
              )}
            </div>

            {embedSnippet && (
              <div>
                <span className="text-xs uppercase tracking-wide text-slate-500 dark:text-slate-400">
                  Embed snippet
                </span>
                <pre className="mt-0.5 w-full overflow-auto border border-slate-200 rounded bg-slate-50 p-2 text-xs whitespace-pre-wrap font-mono text-slate-700 dark:border-slate-700 dark:bg-slate-800/40 dark:text-slate-200">
                  {embedSnippet}
                </pre>
                <button
                  type="button"
                  onClick={() => copy('embed', embedSnippet)}
                  className="mt-1 text-xs rounded px-2 py-1 border border-slate-300 text-slate-600 hover:bg-slate-100 dark:border-slate-600 dark:text-slate-300 dark:hover:bg-slate-800"
                >
                  {copied === 'embed' ? 'Copied' : 'Copy embed code'}
                </button>
              </div>
            )}

            {!allow && (
              <p className="text-xs text-amber-700 dark:text-amber-400 italic">
                Public signup is currently disabled — the URL above returns “not found” until you
                enable it.
              </p>
            )}
          </div>
        )}
      </div>

      {error && <p className="text-xs text-red-600 mt-2">{error}</p>}

      {editing && (
        <div className="mt-3 flex gap-2">
          <button
            type="button"
            disabled={!dirty || saving || !slugValid}
            onClick={save}
            className="bg-slate-900 text-white text-sm rounded px-3 py-1.5 disabled:opacity-50 dark:bg-slate-100 dark:text-slate-900"
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
          <button
            type="button"
            disabled={saving}
            onClick={() => {
              reset();
              setEditing(false);
            }}
            className="text-sm rounded px-3 py-1.5 border border-slate-300 text-slate-600 hover:bg-slate-100 disabled:opacity-50 dark:border-slate-600 dark:text-slate-300 dark:hover:bg-slate-800"
          >
            Cancel
          </button>
        </div>
      )}
    </section>
  );
}

function TabButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`px-3 py-2 text-sm -mb-px border-b-2 ${
        active
          ? 'border-slate-900 text-slate-900 font-medium dark:border-slate-100 dark:text-slate-100'
          : 'border-transparent text-slate-500 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-100'
      }`}
    >
      {children}
    </button>
  );
}

const inputCls =
  'block w-full border border-slate-300 rounded px-2 py-1 text-sm mt-0.5 bg-white text-slate-900 dark:bg-slate-800 dark:border-slate-700 dark:text-slate-100 disabled:bg-slate-50 disabled:text-slate-500 disabled:cursor-not-allowed disabled:border-slate-200 dark:disabled:bg-slate-800/40 dark:disabled:text-slate-400 dark:disabled:border-slate-700';
