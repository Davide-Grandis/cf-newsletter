import { useEffect, useMemo, useState } from 'react';
import type { Newsletter } from '../api';
import {
  MAIL_MERGE_HTML_MAX,
  MAIL_MERGE_TEXT_MAX,
  renderMailMerge,
  sanitizeMailMergeHtml,
} from '../../../shared/mail-merge';

export interface MailMergeUpdate {
  mail_merge_enabled: boolean;
  mail_merge_incoming: boolean;
  mail_merge_html: string | null;
  mail_merge_text: string | null;
}

const inputCls =
  'w-full border border-slate-300 rounded px-2 py-1.5 text-sm bg-white text-slate-900 disabled:opacity-60 dark:bg-slate-900 dark:border-slate-700 dark:text-slate-100';

const DEFAULT_HTML = '<p>Hello {{subscriber_name}},</p>';
const DEFAULT_TEXT = 'Hello {{subscriber_name}},';

export function MailMergeEditor({
  n,
  canEdit,
  onSave,
  saving,
}: {
  n: Newsletter;
  canEdit: boolean;
  onSave: (body: MailMergeUpdate) => Promise<unknown>;
  saving: boolean;
}) {
  const baselineEnabled = n.mail_merge_enabled === 1;
  const baselineIncoming = (n.mail_merge_incoming ?? 1) === 1;
  const baselineHtml = n.mail_merge_html ?? '';
  const baselineText = n.mail_merge_text ?? '';
  const [enabled, setEnabled] = useState(baselineEnabled);
  const [incoming, setIncoming] = useState(baselineIncoming);
  const [html, setHtml] = useState(baselineHtml);
  const [text, setText] = useState(baselineText);
  const [sampleName, setSampleName] = useState('Jane Doe');
  const [error, setError] = useState<string | null>(null);

  function reset() {
    setEnabled(baselineEnabled);
    setIncoming(baselineIncoming);
    setHtml(baselineHtml);
    setText(baselineText);
    setError(null);
  }

  // Saved values replace local edits only when the stored configuration changes.
  useEffect(reset, [baselineEnabled, baselineIncoming, baselineHtml, baselineText]);

  function fillDefaults() {
    setHtml((value) => value.trim() ? value : DEFAULT_HTML);
    setText((value) => value.trim() ? value : DEFAULT_TEXT);
  }

  const locked = !canEdit || saving;
  const dirty = enabled !== baselineEnabled || incoming !== baselineIncoming || html !== baselineHtml || text !== baselineText;
  const previewDoc = useMemo(() => (
    '<!doctype html><html><head><meta charset="utf-8">' +
    '<style>body{font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;' +
    'font-size:14px;color:#0f172a;margin:12px;background:#fff}a{color:#2563eb}</style></head>' +
    `<body>${renderMailMerge(sanitizeMailMergeHtml(html), sampleName, true)}</body></html>`
  ), [html, sampleName]);

  async function save() {
    setError(null);
    try {
      await onSave({
        mail_merge_enabled: enabled,
        mail_merge_incoming: incoming,
        mail_merge_html: html.trim() ? html : null,
        mail_merge_text: text.trim() ? text : null,
      });
    } catch (e) {
      setError((e as Error).message);
    }
  }

  const optionCls = (selected: boolean) =>
    `flex items-start gap-3 rounded-md border p-3 text-sm ${locked ? '' : 'cursor-pointer'} ${selected ? 'border-sky-500 bg-white dark:border-sky-500 dark:bg-slate-900' : 'border-slate-200 dark:border-slate-700'}`;

  return (
    <section className="bg-white border border-slate-200 rounded p-4 space-y-4 dark:bg-slate-900 dark:border-slate-800">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 id="mail-merge-label" className="text-sm font-medium text-slate-900 dark:text-slate-100">Enable Mail Merge</h2>
          <p id="mail-merge-help" className="mt-1 text-xs text-slate-500 dark:text-slate-400">
            Address each subscriber by name with{' '}
            <code className="bg-slate-100 px-1 rounded dark:bg-slate-800">{'{{subscriber_name}}'}</code>.
            It&apos;s left blank when no name is known.
          </p>
        </div>
        <button
          type="button"
          role="switch"
          aria-labelledby="mail-merge-label"
          aria-describedby="mail-merge-help"
          aria-checked={enabled}
          disabled={locked}
          onClick={() => {
            setEnabled(!enabled);
            if (!enabled && !incoming) fillDefaults();
          }}
          className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-600 disabled:opacity-50 ${enabled ? 'bg-emerald-500' : 'bg-slate-300 dark:bg-slate-600'}`}
        >
          <span className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform ${enabled ? 'translate-x-4' : 'translate-x-0.5'}`} />
        </button>
      </div>

      {enabled && (
        <fieldset className="rounded-lg border border-slate-200 bg-slate-50 p-3 dark:border-slate-700 dark:bg-slate-800/50">
          <legend className="sr-only">Mail merge mode</legend>
          <div className="grid gap-3 md:grid-cols-2">
            <label className={optionCls(!incoming)}>
              <input
                type="radio"
                name="mail-merge-mode"
                className="mt-0.5"
                checked={!incoming}
                disabled={locked}
                onChange={() => { setIncoming(false); fillDefaults(); }}
              />
              <span>
                <span className="block font-medium text-slate-900 dark:text-slate-100">Add header</span>
                <span className="mt-0.5 block text-xs text-slate-500 dark:text-slate-400">A personalized header is added to the top of outgoing emails.</span>
              </span>
            </label>
            <label className={optionCls(incoming)}>
              <input
                type="radio"
                name="mail-merge-mode"
                className="mt-0.5"
                checked={incoming}
                disabled={locked}
                onChange={() => setIncoming(true)}
              />
              <span>
                <span className="block font-medium text-slate-900 dark:text-slate-100">Header is included in the incoming email</span>
                <span className="mt-0.5 block text-xs text-slate-500 dark:text-slate-400">
                  Place <code>{'{{subscriber_name}}'}</code> in the incoming email&apos;s HTML and/or plain-text body. Its formatting is retained.
                </span>
              </span>
            </label>
          </div>
        </fieldset>
      )}

      {enabled && !incoming && (
        <div className="grid gap-4 lg:grid-cols-2">
          <div className="min-w-0">
            <label htmlFor="mail-merge-html" className="block text-xs uppercase tracking-wide text-slate-500 dark:text-slate-400">
              HTML header
            </label>
            <textarea
              id="mail-merge-html"
              value={html}
              disabled={locked}
              onChange={(e) => setHtml(e.target.value)}
              rows={8}
              maxLength={MAIL_MERGE_HTML_MAX}
              spellCheck={false}
              placeholder={DEFAULT_HTML}
              className={`${inputCls} mt-0.5 block h-44 font-mono text-xs leading-relaxed`}
            />
          </div>
          <div className="min-w-0">
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs uppercase tracking-wide text-slate-500 dark:text-slate-400">HTML preview</span>
              <label className="flex items-center gap-1.5 text-xs text-slate-500 dark:text-slate-400">
                Preview as
                <input
                  id="mail-merge-sample-name"
                  value={sampleName}
                  onChange={(e) => setSampleName(e.target.value)}
                  placeholder="Missing name"
                  className="w-32 border border-slate-300 rounded px-1.5 py-0.5 text-xs bg-white text-slate-900 dark:bg-slate-900 dark:border-slate-700 dark:text-slate-100"
                />
              </label>
            </div>
            <iframe
              title="Mail merge header preview"
              sandbox=""
              srcDoc={previewDoc}
              className="mt-0.5 block w-full h-44 border border-slate-200 rounded bg-white dark:border-slate-700"
            />
          </div>
          <div className="min-w-0">
            <label htmlFor="mail-merge-text" className="block text-xs uppercase tracking-wide text-slate-500 dark:text-slate-400">
              Plain-text header
            </label>
            <textarea
              id="mail-merge-text"
              value={text}
              disabled={locked}
              onChange={(e) => setText(e.target.value)}
              rows={4}
              maxLength={MAIL_MERGE_TEXT_MAX}
              spellCheck={false}
              placeholder={DEFAULT_TEXT}
              className={`${inputCls} mt-0.5 block h-[90px] font-mono text-xs leading-relaxed`}
            />
          </div>
          <div className="min-w-0">
            <span className="block text-xs uppercase tracking-wide text-slate-500 dark:text-slate-400">Text preview</span>
            <pre className="mt-0.5 w-full h-[90px] overflow-auto border border-slate-200 rounded bg-slate-50 p-2 text-xs whitespace-pre-wrap font-mono text-slate-700 dark:border-slate-700 dark:bg-slate-800/40 dark:text-slate-200">
              {renderMailMerge(text, sampleName, false)}
            </pre>
          </div>
        </div>
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
            onClick={reset}
            className="text-sm rounded px-3 py-1.5 border border-slate-300 text-slate-600 hover:bg-slate-100 disabled:opacity-50 dark:border-slate-600 dark:text-slate-300 dark:hover:bg-slate-800"
          >
            Cancel
          </button>
        </div>
      )}
    </section>
  );
}
