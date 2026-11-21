import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import type { Newsletter } from '../api';

export function TrackingEditor({
  n,
  canEdit,
  globalEnabled,
  isSuperAdmin,
  onSave,
  saving,
}: {
  n: Newsletter;
  canEdit: boolean;
  globalEnabled: boolean;
  isSuperAdmin: boolean;
  onSave: (body: { tracking_enabled: boolean }) => Promise<unknown>;
  saving: boolean;
}) {
  const baseline = n.tracking_enabled === 1;
  const [enabled, setEnabled] = useState(baseline);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setEnabled(baseline);
    setError(null);
  }, [baseline]);

  const locked = !canEdit || saving || !globalEnabled;
  const on = globalEnabled && enabled;
  const dirty = globalEnabled && enabled !== baseline;

  async function save() {
    setError(null);
    try {
      await onSave({ tracking_enabled: enabled });
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <section className="bg-white border border-slate-200 rounded p-4 space-y-4 dark:bg-slate-900 dark:border-slate-800">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 id="tracking-label" className="text-sm font-medium text-slate-900 dark:text-slate-100">Enable open &amp; click tracking</h2>
          <p id="tracking-help" className="mt-1 text-xs text-slate-500 dark:text-slate-400">
            When on, links are rewritten through the tracker and an open pixel is added, but only for subscribers
            who consented to tracking. Everyone else receives the email unmodified. The public signup page asks for
            consent only while this is on.
          </p>
        </div>
        <button
          type="button"
          role="switch"
          aria-labelledby="tracking-label"
          aria-describedby="tracking-help"
          aria-checked={on}
          disabled={locked}
          onClick={() => setEnabled(!enabled)}
          className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-600 disabled:opacity-50 ${on ? 'bg-emerald-500' : 'bg-slate-300 dark:bg-slate-600'}`}
        >
          <span className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform ${on ? 'translate-x-4' : 'translate-x-0.5'}`} />
        </button>
      </div>

      {!globalEnabled && (
        <p className="rounded border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-800/60 dark:bg-amber-900/30 dark:text-amber-300">
          Tracking is disabled globally, so it can&apos;t be enabled for this newsletter.{' '}
          {isSuperAdmin
            ? <>Turn on <Link to="/settings?tab=tracking" className="underline">Settings → Tracking &amp; bounce</Link> first.</>
            : 'Ask a super admin to turn it on in Settings first.'}
        </p>
      )}

      {error && <p role="alert" className="text-xs text-red-600">{error}</p>}
      {canEdit && dirty && (
        <div className="flex gap-2">
          <button
            type="button"
            disabled={saving}
            onClick={save}
            className="bg-slate-900 text-white text-sm rounded px-3 py-1.5 disabled:opacity-50 dark:bg-slate-100 dark:text-slate-900"
          >
            {saving ? 'Saving...' : 'Save'}
          </button>
          <button
            type="button"
            disabled={saving}
            onClick={() => setEnabled(baseline)}
            className="text-sm rounded px-3 py-1.5 border border-slate-300 text-slate-600 hover:bg-slate-100 disabled:opacity-50 dark:border-slate-600 dark:text-slate-300 dark:hover:bg-slate-800"
          >
            Cancel
          </button>
        </div>
      )}
    </section>
  );
}
