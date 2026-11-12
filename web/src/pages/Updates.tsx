import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { useIdentity } from '../auth';

interface Job {
  id: string; source: string; actor: string; state: string; phase: string;
  created_at: number; error?: string; events?: Array<{ phase: string; message: string; created_at: number }>;
}
interface Status {
  installed: string; updaterVersion: string; tokenSaved: boolean;
  release: { id: number; version: string; digest: string; newer: boolean; notes: string; url: string } | null;
  checkedAt: number | null; checkError: string | null; activeJob: Job | null; jobs: Job[];
}
interface Preflight { version: string; workers: number; migrations: string[] }
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
  const [token, setToken] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [preflight, setPreflight] = useState<Preflight | null>(null);
  const [message, setMessage] = useState('');
  const query = useQuery({
    queryKey: ['updates'], queryFn: () => api<Status>('/api/updates'),
    refetchInterval: (q) => q.state.data?.activeJob ? 3_000 : false, retry: false,
  });
  const status = query.data;
  const release = status?.release;
  const active = status?.activeJob;
  const action = useMutation({
    mutationFn: async ({ path, method = 'POST', body = {} }: { path: string; method?: string; body?: Record<string, unknown> }) => {
      return api<unknown>(`/api/updates/${path}`, { method, body: JSON.stringify(body) });
    },
    onSuccess: async (_data, variables) => {
      if (variables.path !== 'preflight') { setToken(''); setPreflight(null); }
      await qc.invalidateQueries({ queryKey: ['updates'] });
      if (variables.path === 'token') setMessage(variables.method === 'DELETE' ? 'Saved update token removed.' : 'Update token saved. Future updates still require your approval.');
      if (variables.path === 'start') setMessage('Update started. You can close this page; progress is saved.');
    },
  });
  const input = { token, releaseId: release?.id, digest: release?.digest, recoveryConfirmed: confirmed };
  function changeToken(value: string) { setToken(value); setPreflight(null); setMessage(''); action.reset(); }
  async function checkPreflight() {
    const result = await action.mutateAsync({ path: 'preflight', body: input }).catch(() => null);
    if (result) setPreflight(result as Preflight);
  }

  return <div className="space-y-5">
    <section className={card}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div><h2 className="text-base font-medium">Application updates</h2><p className="text-sm text-slate-500 dark:text-slate-400">Installed release {status?.installed ?? '...'} · Update engine {status?.updaterVersion ?? '...'}</p></div>
        <button className={button} disabled={action.isPending} onClick={() => { setPreflight(null); action.mutate({ path: 'check' }); }}>Check for updates</button>
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

    <section className={card}>
      <h2 className="text-base font-medium">Deployment credential</h2>
      <p className="text-sm text-slate-600 dark:text-slate-300">{status?.tokenSaved ? 'An update token is saved on the updater Worker. Leave the field empty to use it, or enter another token for this update.' : 'No update token is saved. Enter a Cloudflare token for this update; you do not need to save it.'}</p>
      <label className="block text-sm" htmlFor="update-token">Update API token</label>
      <input id="update-token" type="password" autoComplete="off" value={token} onChange={(event) => changeToken(event.target.value)} disabled={Boolean(active) || action.isPending} className="w-full rounded border border-slate-300 bg-transparent px-3 py-2 text-sm dark:border-slate-600" />
      <p className="text-xs leading-relaxed text-slate-500 dark:text-slate-400">Requires Workers Scripts Edit on this account. This permission can modify other Workers in the account. Per-update tokens are encrypted temporarily for at most one hour, removed when the job finishes, and never included in update history. Revoke temporary tokens after use.</p>
      <div className="flex flex-wrap gap-2">
        <button className={button} disabled={!token || Boolean(active) || action.isPending} onClick={() => action.mutate({ path: 'token', method: 'PUT', body: { token } })}>Save for future updates</button>
        {status?.tokenSaved && <button className={button} disabled={Boolean(active) || action.isPending} onClick={() => action.mutate({ path: 'token', method: 'DELETE', body: { token } })}>Remove saved token</button>}
      </div>
    </section>

    {!active && release?.newer && <section className={card}>
      <h2 className="text-base font-medium">Install release {release.version}</h2>
      <p className="text-sm text-slate-600 dark:text-slate-300">Updates preserve your data, settings, resource locations and signing keys. Database changes cannot be undone by rolling back Worker code.</p>
      <button className={button} disabled={action.isPending || (!token && !status?.tokenSaved) || Boolean(status?.checkError)} onClick={() => void checkPreflight()}>Run preflight</button>
      {preflight && <div className="space-y-3 text-sm">
        <p>Preflight passed for {preflight.workers} Workers.</p>
        {preflight.migrations.length > 0 && <ul className="list-disc space-y-1 pl-5">{preflight.migrations.map((item) => <li key={item}>{item}</li>)}</ul>}
        <label className="flex items-start gap-2"><input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} className="mt-1" /><span>I have a current database backup or a verified recovery point. I approve this deployment.</span></label>
        <button className={primary} disabled={!confirmed || action.isPending} onClick={() => action.mutate({ path: 'start', body: input })}>Update now</button>
      </div>}
    </section>}

    {active && <section className={card} aria-live="polite">
      <h2 className="text-base font-medium">Update {active.state === 'failed' ? 'needs recovery' : 'in progress'}</h2>
      <p className="text-sm">Started from {active.source} by {active.actor}. Current phase: {active.phase}.</p>
      {active.error && <p role="alert" className="text-sm text-red-600 dark:text-red-400">{active.error}</p>}
      <ol className="space-y-2 text-sm">{active.events?.map((event, index) => <li key={index}><span className="text-xs text-slate-500">{new Date(event.created_at).toLocaleTimeString()}</span> {event.message}</li>)}</ol>
      {active.state === 'failed' && <div className="space-y-3">
        <label className="block text-sm" htmlFor="recovery-token">Fresh token for recovery (leave empty to use the saved token)</label>
        <input id="recovery-token" type="password" autoComplete="off" value={token} onChange={(event) => changeToken(event.target.value)} className="w-full rounded border bg-transparent px-3 py-2 text-sm dark:border-slate-600" />
        <button className={primary} disabled={action.isPending || (!token && !status?.tokenSaved)} onClick={() => action.mutate({ path: 'recover', body: { jobId: active.id, token } })}>Resume from checkpoint</button>
        <p className="text-xs text-slate-500">The hosted updater remains available for recovery if the console cannot finish this operation.</p>
      </div>}
    </section>}

    {action.error && <p role="alert" className="text-sm text-red-600 dark:text-red-400">{action.error.message}</p>}
    {message && <p role="status" className="text-sm text-emerald-700 dark:text-emerald-300">{message}</p>}
    {!!status?.jobs.length && <section className={card}><h2 className="text-base font-medium">Recent updates</h2><ul className="divide-y divide-slate-200 text-sm dark:divide-slate-700">{status.jobs.map((job) => <li key={job.id} className="py-2"><span className="font-medium">{job.state}</span> · {job.source} · {new Date(job.created_at).toLocaleString()}{job.error && <p className="mt-1 text-red-600 dark:text-red-400">{job.error}</p>}</li>)}</ul></section>}
    <p className="text-sm text-slate-500 dark:text-slate-400">The <a className="underline" href="https://installer.cf-newsletter.com/" target="_blank" rel="noreferrer">hosted installer/updater</a> always remains an alternative for updates and recovery. It does not require a saved update token.</p>
  </div>;
}
