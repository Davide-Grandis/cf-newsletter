import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api';
import { ConfirmDialog } from '../components/ConfirmDialog';

interface Status {
  enabled: boolean;
  siteKey: string;
  hostname: string;
  ready: boolean;
  checkError: string | null;
}

export default function TurnstileSettings() {
  const qc = useQueryClient();
  const status = useQuery({ queryKey: ['turnstile-status'], queryFn: () => api<Status>('/api/settings/turnstile') });
  const [saving, setSaving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const configuredHostname = Boolean(status.data?.hostname && status.data.hostname !== 'track.yourdomain.com');

  async function change(enabled: boolean) {
    if (saving || (enabled && !configuredHostname)) return;
    setSaving(true);
    setConfirmDelete(false);
    setError(null);
    setMessage(null);
    try {
      await api('/api/settings/turnstile', {
        method: 'PUT',
        body: JSON.stringify(enabled
          ? { enabled: true }
          : { enabled: false, siteKey: status.data?.siteKey ?? '', confirmDelete: true }),
      });
      setMessage(enabled
        ? 'Turnstile enabled. The widget and tracker configuration have been verified.'
        : 'Turnstile disabled. The Cloudflare widget and tracker keys have been removed.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Turnstile configuration failed.');
    } finally {
      await Promise.all([status.refetch(), qc.invalidateQueries({ queryKey: ['settings'] })]);
      setSaving(false);
    }
  }

  if (status.isLoading) return <p className="text-sm text-slate-500">Checking Turnstile configuration...</p>;
  if (status.error) return <p role="alert" className="text-sm text-red-600">{status.error.message}</p>;
  const data = status.data!;
  const enabled = data.enabled && data.ready && !data.checkError;

  return (
    <section className="overflow-hidden rounded-lg border border-slate-200 dark:border-slate-700">
      <div className="border-b border-slate-200 bg-slate-50 px-4 py-3 dark:border-slate-700 dark:bg-slate-800/60">
        <h2 className="text-base font-medium">Public signup bot protection</h2>
        <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
          Enable Turnstile protection for the subscribe page.
        </p>
      </div>
      <div className="space-y-4 p-4">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h3 id="turnstile-label" className="text-sm font-medium">Turnstile bot protection</h3>
            <p id="turnstile-status" className="mt-1 text-xs text-slate-500 dark:text-slate-400">
              {enabled ? 'Enabled. Public signup requires Turnstile verification.' : data.enabled ? 'Disabled. Turnstile verification failed; enable it again to retry setup.' : 'Disabled. Public signup is available without bot protection.'}
            </p>
          </div>
          <button
            type="button"
            role="switch"
            aria-labelledby="turnstile-label"
            aria-describedby="turnstile-status"
            aria-checked={enabled}
            aria-busy={saving}
            disabled={saving || (!enabled && !configuredHostname)}
            onClick={() => {
              setError(null);
              setMessage(null);
              if (enabled) setConfirmDelete(true);
              else void change(true);
            }}
            className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-600 disabled:opacity-50 ${enabled ? 'bg-emerald-500' : 'bg-slate-300 dark:bg-slate-600'}`}
          >
            <span className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform ${enabled ? 'translate-x-4' : 'translate-x-0.5'}`} />
          </button>
        </div>
        {!saving && data.enabled && !enabled && !data.checkError && (
          <p role="alert" className="text-sm text-amber-700 dark:text-amber-400">
            The tracker keys could not be verified. Protected signup may be unavailable until Turnstile is successfully configured again.
          </p>
        )}
        {!saving && data.checkError && <p className="text-xs text-amber-700 dark:text-amber-400">{data.checkError}</p>}
        <p className="text-xs text-slate-500 dark:text-slate-400">
          {configuredHostname
            ? <>Enabling automatically creates or reuses the app&apos;s Turnstile widget for <code className="break-all">{data.hostname}</code> and securely configures its keys.</>
            : 'Configure the tracking hostname in Tracking & bounce before enabling Turnstile.'}
        </p>
        {saving && <p role="status" className="text-sm text-slate-500">Saving and verifying Turnstile configuration with Cloudflare...</p>}
        {error && <p role="alert" className="text-sm text-red-600">{error}</p>}
        {message && <p role="status" className="text-sm text-emerald-700 dark:text-emerald-400">{message}</p>}
      </div>
      <ConfirmDialog open={confirmDelete} danger title="Delete Turnstile protection?" confirmLabel="Delete widget and disable"
        message={<>This permanently deletes the configured Turnstile widget from the Cloudflare account and removes its site key and secret from the tracker. Any other application using this widget will stop working. Public signup will remain available without bot protection.</>}
        onCancel={() => setConfirmDelete(false)} onConfirm={() => void change(false)} />
    </section>
  );
}
