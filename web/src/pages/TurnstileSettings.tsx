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

const inputClass = 'mt-1 block w-full rounded border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 disabled:opacity-60 dark:border-slate-600 dark:bg-slate-900 dark:text-slate-100';

export default function TurnstileSettings() {
  const qc = useQueryClient();
  const status = useQuery({ queryKey: ['turnstile-status'], queryFn: () => api<Status>('/api/settings/turnstile') });
  const [siteKey, setSiteKey] = useState('');
  const [configuring, setConfiguring] = useState(false);
  const [saving, setSaving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const validKey = /^[A-Za-z0-9_-]{20,32}$/.test(siteKey.trim());
  const configuredHostname = Boolean(status.data?.hostname && status.data.hostname !== 'track.yourdomain.com');

  async function change(enabled: boolean) {
    if (saving || (enabled && (!validKey || !configuredHostname))) return;
    const key = enabled ? siteKey.trim() : status.data?.siteKey ?? '';
    setSaving(true);
    setConfirmDelete(false);
    setError(null);
    setMessage(null);
    try {
      await api('/api/settings/turnstile', {
        method: 'PUT',
        body: JSON.stringify({ enabled, siteKey: key, confirmDelete: !enabled }),
      });
      // Only reflect enabled protection after the server verifies and saves it.
      qc.setQueryData<Status>(['turnstile-status'], (current) => current && {
        ...current, enabled, ready: enabled, siteKey: enabled ? key : '', checkError: null,
      });
      setSiteKey('');
      setConfiguring(false);
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

  function cancelSetup() {
    setConfiguring(false);
    setSiteKey('');
    setError(null);
  }

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
            aria-expanded={configuring}
            disabled={saving}
            onClick={() => {
              setError(null);
              setMessage(null);
              if (enabled) setConfirmDelete(true);
              else if (configuring) cancelSetup();
              else setConfiguring(true);
            }}
            className={`relative inline-flex h-5 w-9 shrink-0 rounded-full transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-600 disabled:opacity-50 ${enabled ? 'bg-emerald-500' : 'bg-slate-300 dark:bg-slate-600'}`}
          >
            <span className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform ${enabled ? 'translate-x-4' : 'translate-x-0.5'}`} />
          </button>
        </div>
        {data.enabled && !enabled && !data.checkError && (
          <p role="alert" className="text-sm text-amber-700 dark:text-amber-400">
            The tracker keys could not be verified. Protected signup may be unavailable until Turnstile is successfully configured again.
          </p>
        )}
        {data.checkError && <p className="text-xs text-amber-700 dark:text-amber-400">{data.checkError}</p>}
        {configuring && !enabled && (
          <form
            className="space-y-4 rounded-md border border-slate-200 bg-slate-50 p-4 dark:border-slate-700 dark:bg-slate-800/40"
            onSubmit={(event) => { event.preventDefault(); void change(true); }}
          >
            <p className="text-sm text-slate-600 dark:text-slate-300">
              {data.siteKey ? 'Use the previously configured widget in ' : 'Create a managed widget in '}
              <a href="https://dash.cloudflare.com/?to=/:account/turnstile" target="_blank" rel="noreferrer" className="text-blue-600 underline dark:text-blue-400">Cloudflare Turnstile</a>,
              allow exactly {configuredHostname ? <code className="break-all font-semibold">{data.hostname}</code> : 'your tracking hostname (configure it in Tracking & bounce first)'}.
              Use only the hostname, without a scheme, port, or path, not the console or embedding website hostname.
            </p>
            <p id="turnstile-key-help" className="text-xs text-slate-500 dark:text-slate-400">
              Enter the widget&apos;s public site key. The app validates it, retrieves the matching secret securely, and saves both keys on the tracker before enabling protection. The input is hidden after saving.
            </p>
            <label className="block text-sm font-medium">
              Turnstile site key
              <input
                value={siteKey}
                onChange={(event) => { setSiteKey(event.target.value); setError(null); }}
                disabled={saving}
                autoFocus
                required
                aria-describedby="turnstile-key-help"
                aria-invalid={Boolean(siteKey && !validKey)}
                spellCheck={false}
                autoComplete="off"
                maxLength={32}
                placeholder="Public site key from your Cloudflare widget"
                className={inputClass}
              />
            </label>
            {siteKey && !validKey && <p className="text-xs text-red-600">Enter a valid Turnstile site key before enabling protection.</p>}
            <div className="flex flex-wrap gap-2">
              <button type="submit" disabled={saving || !validKey || !configuredHostname}
                className="rounded bg-slate-900 px-3 py-2 text-sm text-white disabled:opacity-40 dark:bg-slate-100 dark:text-slate-900">
                {saving ? 'Validating and saving...' : 'Validate and enable'}
              </button>
              <button type="button" disabled={saving} onClick={cancelSetup}
                className="rounded border border-slate-300 px-3 py-2 text-sm disabled:opacity-40 dark:border-slate-600">
                Cancel
              </button>
            </div>
          </form>
        )}
        {saving && <p role="status" className="text-sm text-slate-500">Waiting for Cloudflare to verify the configuration...</p>}
        {error && <p role="alert" className="text-sm text-red-600">{error}</p>}
        {message && <p role="status" className="text-sm text-emerald-700 dark:text-emerald-400">{message}</p>}
      </div>
      <ConfirmDialog open={confirmDelete} danger title="Delete Turnstile protection?" confirmLabel="Delete widget and disable"
        message={<>This permanently deletes the configured Turnstile widget from the Cloudflare account and removes its site key and secret from the tracker. Any other application using this widget will stop working. Public signup will remain available without bot protection.</>}
        onCancel={() => setConfirmDelete(false)} onConfirm={() => void change(false)} />
    </section>
  );
}
