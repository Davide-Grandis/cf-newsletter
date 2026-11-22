import { WorkerEntrypoint, WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import {
  UPDATER_VERSION, PRODUCT_WORKERS, compareVersions, githubRelease,
  releaseDigest, verifiedArtifact, type GitHubRelease, type ReleaseArtifact, type ReleaseSource,
} from '../../../shared/update-release';
import {
  bindingQuery, decryptCredential, finishJob, jobById, updateEvent, updateIntentId, UPDATE_INTENT_TTL_MS, type Query,
} from '../../../shared/update-state';
import {
  deployUpdateWorker, installedVersion, loadCheckpoint, prepareUpdate, saveCheckpoint, migrateUpdate, verifyUpdate,
} from '../../../shared/update-engine';

type JobParams = { jobId: string };
type IntentInput = { releaseId: number; digest: string };
const INSTALLER_ORIGIN = 'https://installer.cf-newsletter.com';
export interface UpdateStatus {
  installed: string;
  updaterVersion: string;
  release: { id: number; version: string; digest: string; publishedAt: string | null; notes: string; url: string; newer: boolean } | null;
  checkedAt: number | null;
  checkError: string | null;
  activeJob: Record<string, unknown> | null;
  jobs: Array<Record<string, unknown>>;
}

async function publicJob(query: Query, id: string): Promise<Record<string, unknown>> {
  const rows = await query('SELECT id,source,actor,state,phase,installed_version,created_at,finished_at,error,digest,release_json FROM update_jobs WHERE id=?', [id]);
  const events = await query('SELECT phase,message,created_at FROM update_events WHERE job_id=? ORDER BY id DESC LIMIT 80', [id]);
  const { release_json: releaseJson, ...job } = rows[0] ?? {};
  let releaseId: number | undefined;
  try { releaseId = (JSON.parse(String(releaseJson)) as { id?: number }).id; } catch { /* Recovery stays available through the hosted installer. */ }
  return { ...job, release_id: releaseId, events: events.reverse() };
}

async function selected(id: number, digest: string, source: ReleaseSource): Promise<{ release: GitHubRelease; artifact: ReleaseArtifact }> {
  if (!Number.isSafeInteger(id) || !/^[a-f0-9]{64}$/.test(digest)) throw new Error('The update job has no pinned release.');
  const release = await githubRelease(`/${id}`, source);
  if (release.prerelease || releaseDigest(release) !== digest) throw new Error('The selected release changed or is not stable. Check for updates again.');
  const verified = await verifiedArtifact(release);
  if (!release.published_at || !Number.isFinite(Date.parse(release.published_at))) throw new Error('Release publication date is unavailable.');
  return { release, artifact: verified.artifact };
}

function installerOrigin(configured?: string): string {
  if (!configured) return INSTALLER_ORIGIN;
  const url = new URL(configured);
  if (url.protocol !== 'https:' || url.origin !== configured.replace(/\/$/, '')) throw new Error('The configured installer origin is invalid.');
  return url.origin;
}

// An optional GITHUB_TOKEN calls GitHub directly; otherwise release metadata is
// read through the hosted installer (see githubRelease).
function releaseSource(env: { GITHUB_TOKEN?: string; INSTALLER_ORIGIN?: string }): ReleaseSource {
  return { token: env.GITHUB_TOKEN || undefined, installerOrigin: installerOrigin(env.INSTALLER_ORIGIN) };
}

function nonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export class Updater extends WorkerEntrypoint<UpdaterBindings> {
  async status(force = false): Promise<UpdateStatus> {
    const query = bindingQuery(this.env.DB);
    const installed = await installedVersion(query);
    const cached = (await query("SELECT value,checked_at FROM update_cache WHERE key='release'"))[0];
    let data = cached ? JSON.parse(String(cached.value)) as { release?: GitHubRelease; error?: string } : {};
    let checkedAt = cached ? Number(cached.checked_at) : null;
    const age = Date.now() - (checkedAt ?? 0);
    if (age > (force ? 60_000 : 6 * 60 * 60_000)) {
      // Claim the refresh before network I/O to avoid a per-browser GitHub stampede.
      const claim = await query(`INSERT INTO update_cache(key,value,checked_at) VALUES('release','{}',?)
        ON CONFLICT(key) DO UPDATE SET checked_at=excluded.checked_at WHERE update_cache.checked_at<? RETURNING checked_at`, [Date.now(), Date.now() - (force ? 60_000 : 6 * 60 * 60_000)]);
      if (claim.length) {
        checkedAt = Number(claim[0]!.checked_at);
        try {
          const release = await githubRelease('/latest', releaseSource(this.env));
          if (release.prerelease) throw new Error('No stable release is available.');
          releaseDigest(release);
          data = { release };
        } catch (error) { data = { ...data, error: safeError(error) }; }
        await query("UPDATE update_cache SET value=? WHERE key='release'", [JSON.stringify(data)]);
      }
    }
    const release = data.release;
    const locked = (await query('SELECT job_id FROM update_lock WHERE id=1'))[0]?.job_id;
    return {
      installed, updaterVersion: UPDATER_VERSION,
      release: release ? {
        id: release.id, version: release.tag_name.replace(/^v/, ''), digest: releaseDigest(release),
        publishedAt: release.published_at, notes: (release.body ?? '').slice(0, 30_000),
        url: `https://github.com/Davide-Grandis/cf-newsletter/releases/tag/${release.tag_name}`,
        newer: compareVersions(release.tag_name, installed) > 0,
      } : null,
      checkedAt, checkError: data.error ?? null,
      activeJob: typeof locked === 'string' ? await publicJob(query, locked) : null,
      jobs: await query('SELECT id,source,actor,state,phase,created_at,finished_at,error FROM update_jobs ORDER BY created_at DESC LIMIT 15'),
    };
  }

  // Records a single-use request that the hosted installer redeems only after
  // the operator authorizes this account through Cloudflare OAuth. The console
  // never receives, stores or forwards a Cloudflare credential.
  async intent(input: IntentInput, actor: string): Promise<{ url: string; expiresAt: number; recovery: boolean }> {
    if (!Number.isSafeInteger(input?.releaseId) || input.releaseId <= 0 || !/^[a-f0-9]{64}$/.test(String(input?.digest ?? ''))) {
      throw new Error('Check for updates again before continuing.');
    }
    if (typeof actor !== 'string' || !actor || actor.length > 320) throw new Error('The console administrator could not be identified.');
    const query = bindingQuery(this.env.DB);
    const installed = await installedVersion(query);
    const locked = (await query('SELECT j.state,j.release_json,j.digest FROM update_lock l JOIN update_jobs j ON j.id=l.job_id WHERE l.id=1'))[0];
    let release: { id: number; digest: string; version: string };
    if (locked) {
      if (locked.state !== 'failed') throw new Error('An update is already in progress. Follow its progress on this page.');
      const pinned = JSON.parse(String(locked.release_json)) as GitHubRelease;
      release = { id: pinned.id, digest: String(locked.digest), version: pinned.tag_name.replace(/^v/, '') };
    } else {
      const cached = (await query("SELECT value FROM update_cache WHERE key='release'"))[0];
      const latest = cached ? (JSON.parse(String(cached.value)) as { release?: GitHubRelease }).release : undefined;
      if (!latest || latest.prerelease) throw new Error('Check for updates again before continuing.');
      release = { id: latest.id, digest: releaseDigest(latest), version: latest.tag_name.replace(/^v/, '') };
      if (compareVersions(release.version, installed) <= 0) throw new Error(`cf-newsletter ${installed} is already up to date.`);
    }
    if (release.id !== input.releaseId || release.digest !== input.digest) throw new Error('The available release changed. Review it again before updating.');
    const origin = installerOrigin(this.env.INSTALLER_ORIGIN);
    const value = nonce(), now = Date.now(), expiresAt = now + UPDATE_INTENT_TTL_MS;
    // A new request supersedes every unredeemed link; redeemed rows are kept briefly for audit.
    await query('DELETE FROM update_intents WHERE used_at IS NULL OR created_at<?', [now - 30 * 24 * 60 * 60_000]);
    await query('INSERT INTO update_intents(id,release_id,digest,version,actor,created_at,expires_at) VALUES(?,?,?,?,?,?,?)', [
      await updateIntentId(value), release.id, release.digest, release.version, actor, now, expiresAt,
    ]);
    const url = new URL('/', origin);
    url.searchParams.set('update', value);
    return { url: url.toString(), expiresAt, recovery: Boolean(locked) };
  }

  // Operator escape hatch: abandons a failed job and releases the lock without
  // touching deployed Workers. It needs no Cloudflare credential.
  async abandon(id: string, actor: string): Promise<{ jobId: string }> {
    const query = bindingQuery(this.env.DB);
    const job = await jobById(query, id);
    if (job.state !== 'failed') throw new Error('Only a failed update can be abandoned.');
    if ((await query('SELECT job_id FROM update_lock WHERE id=1'))[0]?.job_id !== id) throw new Error('This job no longer owns the deployment lock.');
    // Never release a lock while an instance could still be retrying a deployment in the background.
    const previousInstance = String((await query('SELECT value FROM deployment_metadata WHERE key=?', [`update_instance_${id}`]))[0]?.value ?? id);
    try { await (await this.env.UPDATE_WORKFLOW.get(previousInstance)).terminate(); }
    catch { throw new Error('Could not verify that the old Workflow stopped. Use the hosted updater for recovery.'); }
    await updateEvent(query, id, 'abandoned', `Abandoned by ${actor}; deployed Workers were left unchanged.`);
    await query("UPDATE update_jobs SET state='abandoned',credential=NULL WHERE id=?", [id]);
    await query('DELETE FROM update_lock WHERE id=1 AND job_id=?', [id]);
    return { jobId: id };
  }
}

function safeError(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 700) : 'Update failed. Inspect the deployment state before recovery.';
}

export class UpdateWorkflow extends WorkflowEntrypoint<UpdaterBindings, JobParams> {
  async run(event: WorkflowEvent<JobParams>, step: WorkflowStep): Promise<void> {
    const id = event.payload.jobId;
    const query = bindingQuery(this.env.DB);
    const execute = async (name: string, action: (token: string, artifact: ReleaseArtifact, release: GitHubRelease) => Promise<void>) => {
      await step.do(name, { retries: { limit: 2, delay: '10 seconds', backoff: 'exponential' }, timeout: '5 minutes' }, async () => {
        const job = await jobById(query, id);
        if ((await query('SELECT job_id FROM update_lock WHERE id=1'))[0]?.job_id !== id) throw new Error('Deployment lock no longer belongs to this job.');
        const token = await decryptCredential(job, this.env.UPDATE_PRIVATE_KEY);
        const release = JSON.parse(job.release_json) as GitHubRelease;
        const object = await this.env.ARCHIVE.get(`_updates/${id}/artifact.json`);
        const artifact = object ? await object.json<ReleaseArtifact>() : (await selected(release.id, job.digest, releaseSource(this.env))).artifact;
        if (!object) await this.env.ARCHIVE.put(`_updates/${id}/artifact.json`, JSON.stringify(artifact));
        await action(token, artifact, release);
      });
    };
    try {
      await execute('preflight', (token, artifact) => prepareUpdate(query, id, token, this.env.ACCOUNT_ID, this.env.DATABASE_ID, artifact));
      await execute('migrations', (_token, artifact) => migrateUpdate(query, id, artifact));
      for (const worker of PRODUCT_WORKERS) {
        await execute(`deploy-${worker}`, (token, artifact, release) => deployUpdateWorker(query, id, token, this.env.ACCOUNT_ID, worker, artifact, release.published_at!));
      }
      await execute('verify', (token, artifact, release) => verifyUpdate(query, id, token, this.env.ACCOUNT_ID, artifact, release.published_at!));
      await step.do('complete', async () => {
        await finishJob(query, id);
        await this.env.ARCHIVE.delete(`_updates/${id}/artifact.json`);
      });
    } catch (error) {
      await step.do('record-failure', async () => {
        const checkpoint = await loadCheckpoint(query, id);
        delete checkpoint.assetsJwt;
        await saveCheckpoint(query, id, checkpoint);
        await finishJob(query, id, safeError(error));
      });
      throw new Error('Update failed. Inspect the persisted update history before recovery.');
    }
  }
}

export default {
  fetch(): Response { return new Response('Not found', { status: 404 }); },
  async scheduled(_event: ScheduledController, env: UpdaterBindings): Promise<void> {
    const query = bindingQuery(env.DB);
    const expired = await query("SELECT id FROM update_jobs WHERE credential IS NOT NULL AND expires_at<?", [Date.now()]);
    for (const row of expired) {
      const id = String(row.id);
      const instance = String((await query('SELECT value FROM deployment_metadata WHERE key=?', [`update_instance_${id}`]))[0]?.value ?? id);
      try { await (await env.UPDATE_WORKFLOW.get(instance)).terminate(); } catch { /* The lock remains held for operator recovery. */ }
      await finishJob(query, id, 'Cloudflare authorization expired. Resume with Cloudflare from Settings > Updates.');
      await env.ARCHIVE.delete(`_updates/${id}/artifact.json`);
    }
    // The table appears with migration 0006, which runs after this engine is bootstrapped.
    try { await query('DELETE FROM update_intents WHERE (used_at IS NULL AND expires_at<?) OR created_at<?', [Date.now(), Date.now() - 30 * 24 * 60 * 60_000]); }
    catch { /* Retried on the next schedule after migrations apply. */ }
  },
} satisfies ExportedHandler<UpdaterBindings>;
