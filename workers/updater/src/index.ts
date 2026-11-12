import { WorkerEntrypoint, WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import {
  UPDATER_VERSION, PRODUCT_WORKERS, assertUpdateCompatible, compareVersions, githubRelease,
  releaseDigest, verifiedArtifact, type GitHubRelease, type ReleaseArtifact,
} from '../../../shared/update-release';
import {
  acquireJob, bindingQuery, decryptCredential, encryptCredential, finishJob, jobById,
  UPDATE_TTL_MS, updateEvent, type Query,
} from '../../../shared/update-state';
import {
  captureWorkers, cloudflare, deployUpdateWorker, installedVersion, loadCheckpoint,
  prepareUpdate, saveCheckpoint, migrateUpdate, verifyUpdate, UPDATER_NAME,
} from '../../../shared/update-engine';

type JobParams = { jobId: string };
type StartInput = { releaseId: number; digest: string; token?: string; recoveryConfirmed: boolean };
export interface UpdateStatus {
  installed: string;
  updaterVersion: string;
  tokenSaved: boolean;
  release: { id: number; version: string; digest: string; publishedAt: string | null; notes: string; url: string; newer: boolean } | null;
  checkedAt: number | null;
  checkError: string | null;
  activeJob: Record<string, unknown> | null;
  jobs: Array<Record<string, unknown>>;
}

async function publicJob(query: Query, id: string): Promise<Record<string, unknown>> {
  const rows = await query('SELECT id,source,actor,state,phase,installed_version,created_at,finished_at,error FROM update_jobs WHERE id=?', [id]);
  const events = await query('SELECT phase,message,created_at FROM update_events WHERE job_id=? ORDER BY id DESC LIMIT 80', [id]);
  return { ...rows[0], events: events.reverse() };
}

async function selected(id: number, digest: string, githubToken?: string): Promise<{ release: GitHubRelease; artifact: ReleaseArtifact }> {
  if (!Number.isSafeInteger(id) || !/^[a-f0-9]{64}$/.test(digest)) throw new Error('Run update preflight before deploying.');
  const release = await githubRelease(`/${id}`, githubToken);
  if (release.prerelease || releaseDigest(release) !== digest) throw new Error('The selected release changed or is not stable. Check for updates again.');
  const verified = await verifiedArtifact(release);
  if (!release.published_at || !Number.isFinite(Date.parse(release.published_at))) throw new Error('Release publication date is unavailable.');
  return { release, artifact: verified.artifact };
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
          const release = await githubRelease('/latest', this.env.GITHUB_TOKEN);
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
      installed, updaterVersion: UPDATER_VERSION, tokenSaved: Boolean(this.env.CF_UPDATE_TOKEN),
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

  async preflight(input: StartInput): Promise<{ version: string; migrations: string[]; workers: number; recoveryRequired: boolean }> {
    const query = bindingQuery(this.env.DB);
    if ((await query('SELECT job_id FROM update_lock WHERE id=1')).length) throw new Error('An update is active or requires recovery.');
    const { artifact } = await selected(input.releaseId, input.digest, this.env.GITHUB_TOKEN);
    const installed = await installedVersion(query);
    assertUpdateCompatible(artifact, installed);
    const token = input.token?.trim() || this.env.CF_UPDATE_TOKEN;
    if (!token) throw new Error('Enter an update token to continue.');
    await captureWorkers(token, this.env.ACCOUNT_ID, this.env.DATABASE_ID, artifact, installed);
    const applied = new Set((await query('SELECT version FROM schema_migrations')).map((row) => row.version));
    return { version: artifact.manifest.version, migrations: artifact.migrations.filter((item) => !applied.has(item.id)).map((item) => item.description), workers: PRODUCT_WORKERS.length, recoveryRequired: true };
  }

  async start(input: StartInput, actor: string): Promise<{ jobId: string }> {
    if (input.recoveryConfirmed !== true) throw new Error('Confirm that a database backup/recovery point is available.');
    const { release, artifact } = await selected(input.releaseId, input.digest, this.env.GITHUB_TOKEN);
    const query = bindingQuery(this.env.DB);
    const installed = await installedVersion(query);
    assertUpdateCompatible(artifact, installed);
    const token = input.token?.trim() || this.env.CF_UPDATE_TOKEN;
    if (!token) throw new Error('Enter an update token to continue.');
    const key = String((await query("SELECT value FROM deployment_metadata WHERE key='updater_public_key'"))[0]?.value ?? '');
    const jobId = crypto.randomUUID();
    const credential = await encryptCredential(token, key, jobId);
    await acquireJob(query, { id: jobId, source: 'console', actor, release, digest: input.digest, installedVersion: installed, credential });
    await saveCheckpoint(query, jobId, { recoveryConfirmed: true });
    try { await this.env.UPDATE_WORKFLOW.create({ id: jobId, params: { jobId } }); }
    catch { await finishJob(query, jobId, 'Could not start the Workflow. Resume the update after checking its status.'); throw new Error('Could not start the update. Check update history before retrying.'); }
    return { jobId };
  }

  async credential(token: string, remove = false): Promise<{ saved: boolean }> {
    const query = bindingQuery(this.env.DB);
    if ((await query('SELECT job_id FROM update_lock WHERE id=1')).length) throw new Error('Finish or recover the active update before changing credentials.');
    const value = token.trim() || this.env.CF_UPDATE_TOKEN;
    if (!value) throw new Error('Enter a token with Workers Scripts Edit permission.');
    if (!remove) {
      await cloudflare(value, `/accounts/${this.env.ACCOUNT_ID}/workers/scripts/${UPDATER_NAME}/settings`);
      await cloudflare(value, `/accounts/${this.env.ACCOUNT_ID}/workers/scripts/${UPDATER_NAME}/secrets`, {
        method: 'PUT', body: JSON.stringify({ name: 'CF_UPDATE_TOKEN', type: 'secret_text', text: value }),
      });
    } else {
      await cloudflare(value, `/accounts/${this.env.ACCOUNT_ID}/workers/scripts/${UPDATER_NAME}/secrets/CF_UPDATE_TOKEN`, { method: 'DELETE' });
    }
    return { saved: !remove };
  }

  async recover(id: string, token: string, actor: string, releaseLock = false): Promise<{ jobId: string }> {
    const query = bindingQuery(this.env.DB);
    const job = await jobById(query, id);
    if (job.state !== 'failed') throw new Error('Only a failed update can be recovered.');
    if ((await query('SELECT job_id FROM update_lock WHERE id=1'))[0]?.job_id !== id) throw new Error('This job no longer owns the deployment lock.');
    // Terminate the old instance first; never release a lock while an instance
    // could still be retrying a deployment in the background.
    const previousInstance = String((await query('SELECT value FROM deployment_metadata WHERE key=?', [`update_instance_${id}`]))[0]?.value ?? id);
    try { await (await this.env.UPDATE_WORKFLOW.get(previousInstance)).terminate(); }
    catch { throw new Error('Could not verify that the old Workflow stopped. Use the hosted updater for recovery.'); }
    if (releaseLock) {
      await query("UPDATE update_jobs SET state='abandoned',credential=NULL WHERE id=?", [id]);
      await query('DELETE FROM update_lock WHERE id=1 AND job_id=?', [id]);
      return { jobId: id };
    }
    const value = token.trim() || this.env.CF_UPDATE_TOKEN;
    if (!value) throw new Error('Enter a fresh update token.');
    const key = String((await query("SELECT value FROM deployment_metadata WHERE key='updater_public_key'"))[0]?.value ?? '');
    // Workflow IDs are immutable. A recovery instance has a fresh ID, but
    // operates on the original durable job/checkpoint.
    await query("UPDATE update_jobs SET state='queued',error=NULL,credential=?,expires_at=? WHERE id=?", [await encryptCredential(value, key, id), Date.now() + UPDATE_TTL_MS, id]);
    const instanceId = `${id}-r-${crypto.randomUUID().slice(0, 8)}`;
    await query("INSERT INTO deployment_metadata(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", [`update_instance_${id}`, instanceId]);
    await updateEvent(query, id, 'recovering', `Recovery requested by ${actor}.`);
    try { await this.env.UPDATE_WORKFLOW.create({ id: instanceId, params: { jobId: id } }); }
    catch { await finishJob(query, id, 'Could not start recovery. Retry with a fresh token.'); throw new Error('Could not start update recovery.'); }
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
        const artifact = object ? await object.json<ReleaseArtifact>() : (await selected(release.id, job.digest, this.env.GITHUB_TOKEN)).artifact;
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
      await finishJob(query, id, 'Temporary credential expired. Resume with a fresh token.');
      await env.ARCHIVE.delete(`_updates/${id}/artifact.json`);
    }
  },
} satisfies ExportedHandler<UpdaterBindings>;
