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
  const baselineHtml = n.mail_merge_html ?? '';
  const baselineText = n.mail_merge_text ?? '';
  const [editing, setEditing] = useState(false);
  const [enabled, setEnabled] = useState(baselineEnabled);
  const [html, setHtml] = useState(baselineHtml);
  const [text, setText] = useState(baselineText);
  const [sampleName, setSampleName] = useState('Jane Doe');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!editing) {
      setEnabled(baselineEnabled);
      setHtml(baselineHtml);
      setText(baselineText);
    }
  }, [editing, baselineEnabled, baselineHtml, baselineText]);

  function reset() {
    setEnabled(baselineEnabled);
    setHtml(baselineHtml);
    setText(baselineText);
    setError(null);
  }

  const dirty = enabled !== baselineEnabled || html !== baselineHtml || text !== baselineText;
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
        mail_merge_html: html.trim() ? html : null,
        mail_merge_text: text.trim() ? text : null,
      });
      setEditing(false);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <section className="bg-white border border-slate-200 rounded p-3 dark:bg-slate-900 dark:border-slate-800">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">Mail merge header</h2>
        {!editing && canEdit && (
          <button
            type="button"
            onClick={() => { reset(); setEditing(true); }}
            className="text-sm rounded px-3 py-1.5 border border-slate-300 text-slate-700 hover:bg-slate-100 dark:border-slate-600 dark:text-slate-200 dark:hover:bg-slate-800"
          >
            Edit
          </button>
        )}
      </div>
      <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
        Add a personalized header before the original email body. The only supported variable is{' '}
        <code className="bg-slate-100 px-1 rounded dark:bg-slate-800">{'{{subscriber_name}}'}</code>.
        Missing names render as empty text.
      </p>
      <label className="mt-3 flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={enabled}
          disabled={!editing || saving}
          onChange={(e) => {
            const checked = e.target.checked;
            setEnabled(checked);
            if (checked) {
              setHtml((value) => value.trim() ? value : DEFAULT_HTML);
              setText((value) => value.trim() ? value : DEFAULT_TEXT);
            }
          }}
        />
        Enable mail merge
      </label>
      <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
        {enabled ? 'The header is added to outgoing emails.' : 'Disabled: no header is added. Your templates are kept.'}
      </p>
      <div className="mt-3 grid gap-4 lg:grid-cols-2">
        <div className="min-w-0">
          <label htmlFor="mail-merge-html" className="text-xs uppercase tracking-wide text-slate-500 dark:text-slate-400">
            HTML header
          </label>
          <textarea
            id="mail-merge-html"
            value={html}
            disabled={!editing || saving}
            onChange={(e) => setHtml(e.target.value)}
            rows={8}
            maxLength={MAIL_MERGE_HTML_MAX}
            spellCheck={false}
            placeholder={DEFAULT_HTML}
            className={`${inputCls} font-mono text-xs leading-relaxed`}
          />
          <label htmlFor="mail-merge-text" className="text-xs uppercase tracking-wide text-slate-500 dark:text-slate-400 mt-3 block">
            Plain-text header
          </label>
          <textarea
            id="mail-merge-text"
            value={text}
            disabled={!editing || saving}
            onChange={(e) => setText(e.target.value)}
            rows={4}
            maxLength={MAIL_MERGE_TEXT_MAX}
            spellCheck={false}
            placeholder={DEFAULT_TEXT}
            className={`${inputCls} font-mono text-xs leading-relaxed`}
          />
        </div>
        <div className="min-w-0">
          <label htmlFor="mail-merge-sample-name" className="text-xs uppercase tracking-wide text-slate-500 dark:text-slate-400">
            Preview subscriber name
          </label>
          <input
            id="mail-merge-sample-name"
            value={sampleName}
            onChange={(e) => setSampleName(e.target.value)}
            placeholder="Leave empty to preview a missing name"
            className={`${inputCls} mt-0.5 mb-3`}
          />
          <span className="text-xs uppercase tracking-wide text-slate-500 dark:text-slate-400">HTML preview</span>
          <iframe
            title="Mail merge header preview"
            sandbox=""
            srcDoc={previewDoc}
            className="mt-0.5 w-full h-[130px] border border-slate-200 rounded bg-white dark:border-slate-700"
          />
          <span className="text-xs uppercase tracking-wide text-slate-500 dark:text-slate-400 mt-3 block">Text preview</span>
          <pre className="mt-0.5 w-full h-[90px] overflow-auto border border-slate-200 rounded bg-slate-50 p-2 text-xs whitespace-pre-wrap font-mono text-slate-700 dark:border-slate-700 dark:bg-slate-800/40 dark:text-slate-200">
            {renderMailMerge(text, sampleName, false)}
          </pre>
          <p className="text-[11px] text-slate-400 dark:text-slate-500 mt-1">
            Template previews use the sample name, even when mail merge is disabled. HTML is sanitized on save.
          </p>
        </div>
      </div>
      {error && <p role="alert" className="text-xs text-red-600 mt-2">{error}</p>}
      {editing && (
        <div className="mt-3 flex gap-2">
          <button
            type="button"
            disabled={!dirty || saving}
            onClick={save}
            className="bg-slate-900 text-white text-sm rounded px-3 py-1.5 disabled:opacity-50 dark:bg-slate-100 dark:text-slate-900"
          >
            {saving ? 'Saving...' : 'Save'}
          </button>
          <button
            type="button"
            disabled={saving}
            onClick={() => { reset(); setEditing(false); }}
            className="text-sm rounded px-3 py-1.5 border border-slate-300 text-slate-600 hover:bg-slate-100 disabled:opacity-50 dark:border-slate-600 dark:text-slate-300 dark:hover:bg-slate-800"
          >
            Cancel
          </button>
        </div>
      )}
    </section>
  );
}
