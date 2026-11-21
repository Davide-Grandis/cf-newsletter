import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { useIdentity } from '../auth';

interface Job {
  id: string; source: string; actor: string; state: string; phase: string; release_id?: number; digest?: string;
  created_at: number; error?: string; events?: Array<{ phase: string; message: string; created_at: number }>;
}
interface Status {
  installed: string; updaterVersion: string;
  release: { id: number; version: string; digest: string; newer: boolean; notes: string; url: string } | null;
  checkedAt: number | null; checkError: string | null; activeJob: Job | null; jobs: Job[];
}
interface Intent { url: string; expiresAt: number; recovery: boolean }
const button = 'rounded border border-slate-300 px-3 py-2 text-sm disabled:opacity-40 dark:border-slate-600';
const primary = 'rounded bg-slate-900 px-4 py-2 text-sm text-white disabled:opacity-40 dark:bg-slate-100 dark:text-slate-900';
const card = 'rounded-lg border border-slate-200 p-4 space-y-4 dark:border-slate-700';

export function UpdateNotice() {
  const me = useIdentity();
  const query = useQuery({
    queryKey: ['updates'], queryFn: () => api<Status>('/api/updates'),
    enabled: me.data?.role === 'super_admin', staleTime: 5 * 60_000, retry: false,
  });
  if (!query.data?.release?.newer && !query.data?.activeJob) return null;
  return <div className="border-b border-amber-200 bg-amber-50 px-4 py-2 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-100">
    <Link to="/settings?tab=updates" className="underline underline-offset-2">
      {query.data.activeJob ? 'An application update is active or needs attention.' : `cf-newsletter ${query.data.release?.version} is available.`} View updates
    </Link>
  </div>;
}

export default function Updates() {
  const qc = useQueryClient();
  const query = useQuery({
    queryKey: ['updates'], queryFn: () => api<Status>('/api/updates'),
    refetchInterval: (q) => q.state.data?.activeJob ? 3_000 : false, retry: false,
  });
  const status = query.data;
  const release = status?.release;
  const active = status?.activeJob;
  const check = useMutation({
    mutationFn: () => api<Status>('/api/updates/check', { method: 'POST', body: '{}' }),
    onSuccess: async () => { await qc.invalidateQueries({ queryKey: ['updates'] }); },
  });
  // The hosted installer completes Cloudflare OAuth and starts the durable job;
  // this page only records the request and then follows progress.
  const handoff = useMutation({
    mutationFn: (target: { releaseId: number; digest: string }) => api<Intent>('/api/updates/intent', { method: 'POST', body: JSON.stringify(target) }),
    onSuccess: (intent) => { window.location.assign(intent.url); },
  });
  const failedTarget = active?.state === 'failed' && active.release_id && active.digest ? { releaseId: active.release_id, digest: active.digest } : null;
  const pending = check.isPending || handoff.isPending;

  return <div className="space-y-5">
    <section className={card}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div><h2 className="text-base font-medium">Application updates</h2><p className="text-sm text-slate-500 dark:text-slate-400">Installed release {status?.installed ?? '...'} · Update engine {status?.updaterVersion ?? '...'}</p></div>
        <button className={button} disabled={pending} onClick={() => check.mutate()}>Check for updates</button>
      </div>
      {query.error && <p role="alert" className="text-sm text-red-600">{query.error.message}</p>}
      {status?.checkError && <p role="alert" className="text-sm text-amber-700 dark:text-amber-300">{status.checkError} The latest release could not be confirmed.</p>}
      {release && <div className="space-y-3">
        <p className="text-sm">{release.newer ? `Release ${release.version} is available.` : `Latest published release: ${release.version}. No newer release is available.`}</p>
        <a className="text-sm underline" href={release.url} target="_blank" rel="noreferrer">View release on GitHub</a>
        <details className="text-sm"><summary className="cursor-pointer">Release notes</summary><pre className="mt-3 whitespace-pre-wrap break-words font-sans text-slate-600 dark:text-slate-300">{release.notes}</pre></details>
      </div>}
      {status?.checkedAt && <p className="text-xs text-slate-500">Last check: {new Date(status.checkedAt).toLocaleString()}</p>}
    </section>

    {!active && release?.newer && <section className={card}>
      <h2 className="text-base font-medium">Install release {release.version}</h2>
      <p className="text-sm text-slate-600 dark:text-slate-300">Updates preserve your data, settings, resource locations and signing keys. Database changes cannot be undone by rolling back Worker code.</p>
      <p className="text-sm text-slate-600 dark:text-slate-300">You will continue on the hosted installer and sign in to Cloudflare as an Administrator or Super Administrator of this account. It checks compatibility, asks for your final confirmation and starts the update. No API token is entered or stored.</p>
      <button className={primary} disabled={pending || Boolean(status?.checkError)} onClick={() => handoff.mutate({ releaseId: release.id, digest: release.digest })}>{handoff.isPending ? 'Opening Cloudflare...' : 'Update with Cloudflare'}</button>
    </section>}

    {active && <section className={card} aria-live="polite">
      <h2 className="text-base font-medium">Update {active.state === 'failed' ? 'needs recovery' : 'in progress'}</h2>
      <p className="text-sm">Started from {active.source} by {active.actor}. Current phase: {active.phase}.</p>
      {active.error && <p role="alert" className="text-sm text-red-600 dark:text-red-400">{active.error}</p>}
      <ol className="space-y-2 text-sm">{active.events?.map((event, index) => <li key={index}><span className="text-xs text-slate-500">{new Date(event.created_at).toLocaleTimeString()}</span> {event.message}</li>)}</ol>
      {active.state === 'failed' && <div className="space-y-3">
        <p className="text-sm text-slate-600 dark:text-slate-300">Fix the reported cause, then resume. The update continues from its checkpoint with the same release after you sign in to Cloudflare.</p>
        <button className={primary} disabled={pending || !failedTarget} onClick={() => failedTarget && handoff.mutate(failedTarget)}>{handoff.isPending ? 'Opening Cloudflare...' : 'Resume with Cloudflare'}</button>
      </div>}
    </section>}

    {(check.error || handoff.error) && <p role="alert" className="text-sm text-red-600 dark:text-red-400">{(handoff.error ?? check.error)!.message}</p>}
    {!!status?.jobs.length && <section className={card}><h2 className="text-base font-medium">Recent updates</h2><ul className="divide-y divide-slate-200 text-sm dark:divide-slate-700">{status.jobs.map((job) => <li key={job.id} className="py-2"><span className="font-medium">{job.state}</span> · {job.source} · {new Date(job.created_at).toLocaleString()}{job.error && <p className="mt-1 text-red-600 dark:text-red-400">{job.error}</p>}</li>)}</ul></section>}
    <p className="text-sm text-slate-500 dark:text-slate-400">The <a className="underline" href="https://installer.cf-newsletter.com/" target="_blank" rel="noreferrer">hosted installer/updater</a> also handles updates and recovery when opened directly.</p>
  </div>;
}
