import { useEffect, useState } from 'react';
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
  const [saving, setSaving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  useEffect(() => { if (status.data) setSiteKey(status.data.siteKey); }, [status.data?.siteKey]);

  async function change(enabled: boolean) {
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
  const needsSetup = !data.enabled || !data.ready;
  const validKey = /^[A-Za-z0-9_-]{20,32}$/.test(siteKey.trim());
  const configuredHostname = data.hostname && data.hostname !== 'track.yourdomain.com';

  return (
    <section className="overflow-hidden rounded-lg border border-slate-200 dark:border-slate-700">
      <div className="border-b border-slate-200 bg-slate-50 px-4 py-3 dark:border-slate-700 dark:bg-slate-800/60">
        <h2 className="text-base font-medium">Public signup bot protection</h2>
        <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
          New installations configure Turnstile automatically. Use this page to enable it on an existing installation, complete a failed setup, or remove it.
          Public signup is enabled separately on each newsletter&apos;s Signup tab.
        </p>
      </div>
      <div className="space-y-4 p-4">
        <p className="text-sm">
          Status: <strong>{data.enabled ? (data.ready ? 'Enabled' : 'Setup incomplete') : 'Disabled'}</strong>
        </p>
        {data.enabled && !data.ready && (
          <p role="alert" className="text-sm text-amber-700 dark:text-amber-400">
            Protection is enabled but the tracker keys are not verified. Complete setup to restore protected signup, or remove Turnstile.
          </p>
        )}
        {data.checkError && <p className="text-xs text-amber-700 dark:text-amber-400">{data.checkError}</p>}
        {needsSetup && (
          <p className="text-sm text-slate-600 dark:text-slate-300">
            {data.siteKey ? 'Complete setup for the saved widget, or remove it before choosing another one. In ' : 'Create a managed widget in '}
            <a href="https://dash.cloudflare.com/?to=/:account/turnstile" target="_blank" rel="noreferrer" className="text-blue-600 underline dark:text-blue-400">Cloudflare Turnstile</a>,
            allow {configuredHostname ? <code>{data.hostname}</code> : 'your tracking hostname (configure it in Tracking & bounce first)'}.
            Enter its public site key below. The app validates the widget, retrieves its matching secret securely, and installs both keys on the tracker before enabling protection.
          </p>
        )}
        <label className="block text-sm font-medium">
          Turnstile site key
          <input
            value={siteKey}
            onChange={(event) => { setSiteKey(event.target.value); setError(null); }}
            readOnly={Boolean(data.siteKey)}
            disabled={saving}
            spellCheck={false}
            autoComplete="off"
            maxLength={32}
            placeholder="Public site key from your Cloudflare widget"
            className={inputClass}
          />
        </label>
        {siteKey && !validKey && <p className="text-xs text-red-600">Enter a valid Turnstile site key before enabling protection.</p>}
        <div className="flex flex-wrap gap-2">
          {needsSetup && (
            <button type="button" disabled={saving || !validKey || !configuredHostname} onClick={() => void change(true)}
              className="rounded bg-slate-900 px-3 py-2 text-sm text-white disabled:opacity-40 dark:bg-slate-100 dark:text-slate-900">
              {saving ? 'Configuring...' : data.siteKey ? 'Complete setup and enable' : 'Validate and enable Turnstile'}
            </button>
          )}
          {(data.enabled || data.siteKey) && (
            <button type="button" disabled={saving} onClick={() => setConfirmDelete(true)}
              className="rounded border border-red-300 px-3 py-2 text-sm text-red-700 disabled:opacity-40 dark:border-red-800 dark:text-red-400">
              Disable and delete widget
            </button>
          )}
        </div>
        {saving && <p role="status" className="text-sm text-slate-500">Waiting for Cloudflare to verify the configuration...</p>}
        {error && <p role="alert" className="text-sm text-red-600">{error}</p>}
        {message && <p role="status" className="text-sm text-emerald-700 dark:text-emerald-400">{message}</p>}
      </div>
      <ConfirmDialog open={confirmDelete} danger title="Delete Turnstile protection?" confirmLabel="Delete widget and disable"
        message={<>This permanently deletes widget <code>{data.siteKey || '(no saved site key)'}</code> from the Cloudflare account and removes its site key and secret from the tracker. Any other application using this widget will stop working. Public signup will remain available without bot protection.</>}
        onCancel={() => setConfirmDelete(false)} onConfirm={() => void change(false)} />
    </section>
  );
}
