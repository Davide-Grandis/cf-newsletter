import { Fragment, useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { api, ApiError, fetchApi, Setting } from '../api';
import { useIdentity, type Identity } from '../auth';
import SuperAdmins from './SuperAdmins';
import Updates from './Updates';
import TurnstileSettings from './TurnstileSettings';

type FieldType = 'text' | 'number' | 'textarea' | 'boolean';

interface FieldMeta {
  key: string;
  label: string;
  help: string;
  type?: FieldType;
  // Hide the default/overridden/editing source badge (e.g. settings that have
  // no built-in default, like the Access IDs).
  hideSource?: boolean;
  // Render the source badge below the input instead of beside the label.
  sourceBelow?: boolean;
  // Populate the field from a dynamic option source (a pick-list) rather than
  // free text. 'access-lists' = the account's Zero Trust Emails lists (shown
  // by name, stored by ID).
  optionsFrom?: 'access-lists';
  // Display a value resolved from the stored one instead of the raw value.
  // 'account-name' = the Cloudflare account name (falls back to the ID).
  displayFrom?: 'account-name';
  // Hide the raw setting key shown under the help text (user-facing settings
  // where the internal variable name is just noise).
  hideKey?: boolean;
  // Rows for a 'textarea' field (defaults to 2).
  rows?: number;
  // Render the input one step smaller (text-xs instead of text-sm).
  compact?: boolean;
  // Display-only: hides Edit and Reset buttons so the value cannot be changed
  // from the UI. Useful for limits derived from platform constraints.
  readOnly?: boolean;
  // Show DEFAULT badge when source is default, but hide the OVERRIDDEN badge, override text, and Reset.
  hideOverride?: boolean;
  // When set to another setting key, the Edit button is disabled when that key's effective value is 'false'.
  enabledBy?: string;
}

interface Section {
  title: string;
  description?: string;
  // Optional longer-form guidance rendered as a callout above the fields.
  // Newlines are preserved, so it can hold multi-step instructions.
  note?: string;
  fields: FieldMeta[];
}

interface Tab {
  id: string;
  label: string;
  topContent?: React.ReactNode;
  sections: Section[];
}

// Client-side presentation metadata. The server's allow-list (shared/settings.ts)
// remains the source of truth for which keys are valid and how they're validated.
// Sections are grouped into a small number of tabs to keep the page scannable.
const TABS: Tab[] = [
  {
    id: 'deployment',
    label: 'Deployment details',
    sections: [
  {
    title: 'Deployment',
    fields: [
      { key: 'ACCESS_ACCOUNT_ID', label: 'Cloudflare account', help: 'Account this console is deployed to.', readOnly: true, hideKey: true, hideSource: true, displayFrom: 'account-name' },
      { key: 'BASE_DOMAIN', label: 'Sending domain', help: 'Domain used for sending and receiving emails.', readOnly: true, hideKey: true, hideSource: true },
      { key: 'ACCESS_LIST_ID', label: 'Zero Trust Emails list', help: 'List referenced by the Access policy; console users are synced to it. Change it only if the list was recreated.', hideKey: true, hideSource: true, optionsFrom: 'access-lists' },
    ],
  },
    ],
  },
  {
    // Super admins management and admin permission.
    id: 'users',
    label: 'Users',
    topContent: (
      <div className="border border-slate-200 rounded-lg dark:border-slate-700 overflow-hidden">
        <SuperAdmins />
      </div>
    ),
    sections: [
  {
    title: 'Admin permissions',
    description:
      'Optional permission for newsletter admins (with edit capability) to be able to also create and delete newsletters. Off by default; only super admins can create and delete newsletters.',
    fields: [
      { key: 'ALLOW_ADMIN_NEWSLETTER_CRUD', label: 'Admins can create/delete newsletters', help: 'When on, edit-capable admins, in addition to super admins, may create and delete newsletters they are assigned to.', type: 'boolean', hideKey: true },
    ],
  },
    ],
  },
  {
    id: 'branding',
    label: 'App branding',
    sections: [],
  },
  {
    id: 'attachments',
    label: 'Email ingestion',
    sections: [
  {
    title: 'Max message size',
    description: 'Fan-out and message-size guards used by the ingest and consumer workers.',
    fields: [
      { key: 'MAX_RAW_BYTES', label: 'Max raw message (bytes)', help: 'Hard cap on the fully assembled MIME message sent via Cloudflare Email Sending. Set to the platform\u2019s 5 MiB limit. Emails exceeding this are rejected at ingest with an SMTP 5xx.', type: 'number', readOnly: true, hideKey: true, hideSource: true },
    ],
  },
  {
    title: 'Attachments',
    description: 'Limits enforced by the ingest worker when a campaign email arrives. Link mode: when total attachment size exceeds the threshold below, attachments are stored in R2 and replaced with signed download links in the email body instead of being embedded — keeping the message within the Cloudflare Email Sending 5 MiB limit. Exceeding any other limit causes the email to be rejected with an SMTP 5xx back to the author and the campaign is never created.',
    fields: [
      { key: 'MAX_ATTACHMENT_BYTES', label: 'Max attachment size (bytes)', help: 'Maximum size of a single attachment. Files above this are rejected at ingest.', type: 'number', readOnly: true, hideKey: true, hideSource: true },
      { key: 'MAX_TOTAL_ATTACHMENT_BYTES', label: 'Max total attachment size (bytes)', help: 'Maximum combined size of all attachments per campaign. This caps R2 storage per campaign; in link mode, attachments are stored in R2 and served as download links, so they do not count toward the 5 MiB email limit.', type: 'number', readOnly: true, hideKey: true, hideSource: true },
      { key: 'MAX_ATTACHMENT_COUNT', label: 'Max attachment count', help: 'Maximum number of attachments per campaign. Campaigns with more files are rejected at ingest.', type: 'number', readOnly: true, hideKey: true, hideSource: true },
      { key: 'ALLOWED_MIME', label: 'Allowed MIME types', help: 'Comma-separated allow-list of permitted MIME types. Globs supported (e.g. image/*). Attachments with a type not on this list are rejected.', readOnly: true, hideKey: true, hideSource: true },
      { key: 'BLOCKED_EXTENSIONS', label: 'Blocked extensions', help: 'Comma-separated file extensions always rejected regardless of MIME type (e.g. exe, js, bat). Checked after the MIME allow-list.', readOnly: true, hideKey: true, hideSource: true },
      { key: 'ATTACHMENT_LINK_THRESHOLD_BYTES', label: 'Link-mode threshold (bytes)', help: 'When total attachment size exceeds this, link mode activates: all attachments are stored in R2 and replaced with signed download links in the email body. This keeps the assembled message well within the Cloudflare Email Sending 5 MiB limit.', type: 'number', readOnly: true, hideKey: true, hideSource: true },
    ],
  },
    ],
  },
  {
    id: 'footer',
    label: 'Email footer',
    sections: [
  {
    title: 'Default footer (template)',
    description:
      'Appended to every outgoing email unless a newsletter defines its own footer (set on the newsletter’s page). The HTML is sanitized to a safe allow-list when saved.',
    note:
      'Tokens you can use: {{unsubscribe_url}}, {{newsletter_name}}, {{email}}. An unsubscribe link is always included even if you omit the token.',
    fields: [
      { key: 'DEFAULT_FOOTER_HTML', label: 'HTML footer', help: 'HTML appended to the end of every email body.', type: 'textarea', hideKey: true, rows: 6, compact: true },
      { key: 'DEFAULT_FOOTER_TEXT', label: 'Plain-text footer', help: 'Footer appended to the plain-text part of every email.', type: 'textarea', hideKey: true, rows: 6, compact: true },
    ],
  },
    ],
  },
  {
    id: 'tracking',
    label: 'Tracking & bounce',
    sections: [
  {
    title: 'Tracking',
    description:
      'Tracking transforms outgoing HTML. Disable to send the emails unmodified, no tracking analytics will be available.',
    fields: [
      { key: 'TRACKING_ENABLED', label: 'Open & click tracking', help: 'Master switch. When on, tracking can be enabled per newsletter (Tracking tab) and applies only to subscribers who consented.', type: 'boolean', hideKey: true, hideOverride: true },
    ],
  },
  {
    title: 'Bounce handling',
    description: 'When the bounce worker marks a subscriber as bounced.',
    fields: [
      { key: 'HARD_BOUNCE_THRESHOLD', label: 'Hard bounce threshold', help: 'Hard bounces (permanent, e.g. mailbox not found) before a subscriber is disabled. 1 = disable on first hard bounce.', type: 'number', hideKey: true },
      { key: 'SOFT_BOUNCE_THRESHOLD', label: 'Soft bounce threshold', help: 'Soft bounces (transient, e.g. full mailbox) within the window before a subscriber is disabled.', type: 'number', hideKey: true },
      { key: 'SOFT_BOUNCE_WINDOW_DAYS', label: 'Soft bounce window (days)', help: 'Soft bounces older than this no longer count, so transient failures self-heal.', type: 'number', hideKey: true },
    ],
  },
    ],
  },
  {
    id: 'delivery',
    label: 'Subscribe',
    sections: [],
  },
  {
    id: 'retention',
    label: 'Retention',
    sections: [
  {
    title: 'Retention',
    description:
      'A daily cron permanently deletes campaigns older than this, together with their stored attachments and archived raw email (from R2) and their send/engagement history (from the database). After deletion the data is gone: attachment download links return \u201cnot found\u201d, the campaign disappears from Analytics, and open/click redirects no longer record anything (the click redirect itself still forwards to the destination).',
    fields: [
      { key: 'RETENTION_DAYS', label: 'Retention (days)', help: 'Days to keep campaigns, attachments and raw archives before permanent deletion. Lower values free storage sooner but make older attachment links and analytics unavailable.', type: 'number', hideKey: true },
    ],
  },
    ],
  },
  { id: 'updates', label: 'Updates', topContent: <Updates />, sections: [] },
];

const inputCls =
  'block w-full border border-slate-300 rounded px-2 py-1 text-sm bg-white text-slate-900 dark:bg-slate-800 dark:border-slate-700 dark:text-slate-100';

function formatBytes(v: string): string | null {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 1024) return null;
  const mb = n / (1024 * 1024);
  if (mb >= 1) return `≈ ${mb.toFixed(mb < 10 ? 1 : 0)} MB`;
  return `≈ ${(n / 1024).toFixed(0)} KB`;
}

function Branding({ color }: { color: string }) {
  const qc = useQueryClient();
  const me = useIdentity();
  const [draftColor, setDraftColor] = useState(color);
  const [selected, setSelected] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  useEffect(() => setDraftColor(color), [color]);
  useEffect(() => {
    if (!selected) {
      setPreviewUrl(null);
      return;
    }
    const url = URL.createObjectURL(selected);
    setPreviewUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [selected]);

  const saveColor = useMutation({
    mutationFn: (value: string | null) => api('/api/settings', {
      method: 'PUT',
      body: JSON.stringify({ updates: { BRANDING_TEXT_COLOR: value } }),
    }),
    onSuccess: async () => {
      await Promise.all([
        qc.invalidateQueries({ queryKey: ['settings'] }),
        qc.invalidateQueries({ queryKey: ['me'] }),
      ]);
    },
  });

  const logo = useMutation({
    mutationFn: async (file: File | null) => {
      const res = await fetchApi('/api/branding/logo', file
        ? { method: 'PUT', body: file, headers: { 'Content-Type': file.type } }
        : { method: 'DELETE' });
      if (!res.ok) {
        const body = await res.json() as { error?: string };
        throw new Error(body.error ?? 'Could not save logo.');
      }
      const { logo_url } = await res.json() as { logo_url?: string };
      if (file && !logo_url) throw new Error('Could not load the saved logo.');
      return file ? logo_url! : null;
    },
    onSuccess: async (url) => {
      qc.setQueryData<Identity>(['me'], (current) => current && { ...current, branding_logo_url: url });
      setSelected(null);
      setFileError(null);
      await qc.invalidateQueries({ queryKey: ['me'] });
    },
    onError: () => setSelected(null),
  });

  const validColor = /^#[0-9a-fA-F]{6}$/.test(draftColor);
  const logoUrl = logo.variables === null && logo.isPending
    ? null
    : previewUrl ?? me.data?.branding_logo_url;
  return (
    <div className="space-y-6">
      <section className="border border-slate-200 rounded-lg dark:border-slate-700 overflow-hidden">
        <div className="px-4 py-3 bg-slate-50 border-b border-slate-200 dark:bg-slate-800/60 dark:border-slate-700">
          <h2 className="text-base font-medium">Header logo</h2>
          <p className="text-xs text-slate-500 dark:text-slate-400">Recommended: a transparent PNG or WebP around 256 × 256 px. Maximum file size: 256 KB. JPEG is also supported.</p>
        </div>
        <div className="p-4 space-y-3">
          <div className="h-24 flex items-center rounded border border-slate-200 bg-white px-4 dark:border-slate-700 dark:bg-slate-900">
            {logoUrl ? <img src={logoUrl} alt="Logo preview" className="max-h-20 max-w-48 object-contain" /> : <span className="text-sm text-slate-500">(no logo)</span>}
          </div>
          <div className="flex flex-wrap gap-2">
            <label className={`inline-flex w-32 shrink-0 items-center justify-center rounded border border-slate-300 px-3 py-1.5 text-sm focus-within:ring-2 focus-within:ring-slate-500 dark:border-slate-600 ${logo.isPending ? 'cursor-not-allowed opacity-40' : 'cursor-pointer'}`}>
              Choose file...
              <input
                type="file"
                accept="image/png,image/jpeg,image/webp"
                aria-label="Choose logo image"
                disabled={logo.isPending}
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  e.target.value = '';
                  if (!file) return;
                  if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) {
                    setSelected(null);
                    setFileError('Choose a PNG, JPEG, or WebP image.');
                    return;
                  }
                  if (file.size > 256 * 1024) {
                    setSelected(null);
                    setFileError('Logo must be 256 KB or smaller.');
                    return;
                  }
                  setFileError(null);
                  setSelected(file);
                  logo.mutate(file);
                }}
                className="sr-only"
              />
            </label>
            {me.data?.branding_logo_url && logoUrl && <button type="button" disabled={logo.isPending} onClick={() => logo.mutate(null)} className="w-32 shrink-0 rounded border border-slate-300 px-3 py-1.5 text-sm disabled:opacity-40 dark:border-slate-600">Remove logo</button>}
          </div>
          {logo.isPending && <p role="status" className="text-sm text-slate-500">Saving logo…</p>}
          {(fileError || logo.error) && <p role="alert" className="text-sm text-red-600">{fileError ?? (logo.error as Error).message}</p>}
          {logo.isSuccess && !selected && !fileError && <p className="text-sm text-emerald-600">Logo updated.</p>}
        </div>
      </section>
      <section className="border border-slate-200 rounded-lg dark:border-slate-700 overflow-hidden">
        <div className="px-4 py-3 bg-slate-50 border-b border-slate-200 dark:bg-slate-800/60 dark:border-slate-700">
          <h2 className="text-base font-medium">App name color</h2>
          <p className="text-xs text-slate-500 dark:text-slate-400">Choose a color that stays readable in both light and dark themes. Reset to use the theme default.</p>
        </div>
        <div className="p-4 space-y-3">
          <div className="flex items-center gap-3">
            <input aria-label="Pick app name color" type="color" value={validColor ? draftColor : '#0f172a'} onChange={(e) => setDraftColor(e.target.value)} className="h-10 w-12 cursor-pointer" />
            <input aria-label="App name hex color" type="text" value={draftColor} placeholder="#2563eb" onChange={(e) => setDraftColor(e.target.value)} className="w-32 rounded border border-slate-300 px-2 py-1.5 text-sm dark:border-slate-600 dark:bg-slate-900" />
            <span className="font-semibold text-slate-900 dark:text-slate-100" style={validColor ? { color: draftColor } : undefined}>Newsletter Console</span>
          </div>
          <div className="flex flex-wrap gap-2">
            <button type="button" disabled={!validColor || draftColor === color || saveColor.isPending} onClick={() => saveColor.mutate(draftColor)} className="w-32 shrink-0 rounded bg-slate-900 px-3 py-1.5 text-sm text-white disabled:opacity-40 dark:bg-slate-100 dark:text-slate-900">{saveColor.isPending ? 'Saving…' : 'Apply'}</button>
            {color && <button type="button" disabled={saveColor.isPending} onClick={() => saveColor.mutate(null)} className="w-32 shrink-0 rounded border border-slate-300 px-3 py-1.5 text-sm dark:border-slate-600">Reset</button>}
          </div>
          {draftColor && !validColor && <p role="alert" className="text-sm text-red-600">Enter a six-digit hex color (e.g. #2563eb).</p>}
          {saveColor.error && <p role="alert" className="text-sm text-red-600">{(saveColor.error as Error).message}</p>}
          {saveColor.isSuccess && <p className="text-sm text-emerald-600">Color updated.</p>}
        </div>
      </section>
    </div>
  );
}

export default function Settings() {
  const qc = useQueryClient();
  const [search, setSearch] = useSearchParams();
  // The single field currently unlocked for editing (one at a time keeps the
  // surface for accidental changes minimal). `draft` is its working value.
  const [editKey, setEditKey] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [savedKey, setSavedKey] = useState<string | null>(null);
  // Best-effort warning returned after saving the sending domain (e.g. the
  // bounce Email Routing rule could not be created automatically).
  const [saveWarn, setSaveWarn] = useState<string | null>(null);
  const tab = search.get('tab') ?? 'deployment';
  const setTab = (value: string) => setSearch({ tab: value });

  const activeTab = TABS.find((t) => t.id === tab) ?? TABS[0]!;

  const query = useQuery({
    queryKey: ['settings'],
    queryFn: () => api<{ settings: Setting[] }>('/api/settings'),
  });

  // Cloudflare account name shown on the Deployment details tab.
  const account = useQuery({
    queryKey: ['account'],
    queryFn: () => api<{ id: string; name: string | null; error?: string }>('/api/account'),
    staleTime: 30 * 60_000,
  });

  // Account Zero Trust Emails lists backing the Access list pick-list.
  const accessLists = useQuery({
    queryKey: ['access-lists'],
    queryFn: () => api<{ items: { id: string; name: string }[]; error?: string }>('/api/access-lists'),
    staleTime: 5 * 60_000,
  });

  // Pick-list state for an `optionsFrom` field: options as value/label pairs.
  const accessListPicks = {
    options: (accessLists.data?.items ?? []).map((l) => ({ value: l.id, label: l.name })),
    loading: accessLists.isLoading,
    error: accessLists.data?.error,
    noun: 'Emails lists',
    empty: 'No Zero Trust Emails lists found in this account.',
  };

  // Effective values keyed by setting key, from the server.
  const byKey = useMemo(() => {
    const m = new Map<string, Setting>();
    for (const s of query.data?.settings ?? []) m.set(s.key, s);
    return m;
  }, [query.data]);

  const effective = (key: string) => byKey.get(key)?.value ?? '';
  const changed =
    editKey !== null &&
    draft !== effective(editKey);

  const save = useMutation({
    mutationFn: (updates: Record<string, string | null>) =>
      api<{ routing_warning?: string }>('/api/settings', {
        method: 'PUT',
        body: JSON.stringify({ updates }),
      }),
    onSuccess: async (data, updates) => {
      const key = Object.keys(updates)[0] ?? null;
      setEditKey(null);
      setFieldError(null);
      setSavedKey(key);
      setSaveWarn(data?.routing_warning ?? null);
      setTimeout(() => setSavedKey((k) => (k === key ? null : k)), 2500);
      await qc.invalidateQueries({ queryKey: ['settings'] });
      // Warmup display depends on these settings; refresh it too.
      await qc.invalidateQueries({ queryKey: ['email-sending-stats'] });
      await qc.invalidateQueries({ queryKey: ['me'] });
    },
    onError: (e, updates) => {
      const key = Object.keys(updates)[0] ?? '';
      const apiErr = e as ApiError;
      setFieldError(apiErr.details?.[key] ?? apiErr.message);
    },
  });

  function startEdit(key: string) {
    setEditKey(key);
    setDraft(effective(key));
    setFieldError(null);
    setSavedKey(null);
  }

  function cancelEdit() {
    setEditKey(null);
    setFieldError(null);
  }

  function saveField(key: string) {
    if (!changed) return cancelEdit();
    // Selecting/typing the built-in default is not an override: clear the stored
    // value (same as Reset) so the source reverts to “default” instead of “db”.
    const fallback = byKey.get(key)?.fallback ?? '';
    save.mutate({ [key]: draft === fallback && fallback !== '' ? null : draft });
  }

  function resetField(key: string) {
    // Clear the stored override; value reverts to env/default.
    setFieldError(null);
    save.mutate({ [key]: null });
  }

  if (query.isLoading) return <div className="text-sm text-slate-500">Loading settings…</div>;
  if (query.error)
    return <div className="text-sm text-red-600">{(query.error as Error).message}</div>;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold">Settings</h1>
      </div>

      <div className="flex flex-wrap gap-1 border-b border-slate-200 dark:border-slate-800 mb-6">
        {TABS.map((t) => (
          <TabButton
            key={t.id}
            active={t.id === activeTab.id}
            onClick={() => {
              cancelEdit();
              setTab(t.id);
            }}
          >
            {t.label}
          </TabButton>
        ))}
      </div>


      {activeTab.topContent}
      {activeTab.id === 'branding' && <Branding color={effective('BRANDING_TEXT_COLOR')} />}
      {activeTab.id === 'delivery' && <TurnstileSettings />}

      {saveWarn && (
        <div className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-900/60 dark:bg-amber-900/20 dark:text-amber-200">
          <span className="flex-1">{saveWarn}</span>
          <button
            type="button"
            onClick={() => setSaveWarn(null)}
            className="text-amber-700 hover:text-amber-900 dark:text-amber-300 dark:hover:text-amber-100"
          >
            Dismiss
          </button>
        </div>
      )}

      {activeTab.sections.map((section) => (
        <section
          key={section.title}
          className="border border-slate-200 rounded-lg dark:border-slate-700 overflow-hidden"
        >
          <div className="px-4 py-3 bg-slate-50 border-b border-slate-200 dark:bg-slate-800/60 dark:border-slate-700">
            <h2 className="text-base font-medium">{section.title}</h2>
            {section.description && (
              <p className="text-xs text-slate-500 mt-0.5 dark:text-slate-400">{section.description}</p>
            )}
            {section.note && (
              <div className="mt-2 rounded border border-sky-200 bg-sky-50 p-2.5 text-xs leading-relaxed text-sky-900 whitespace-pre-line dark:border-sky-900/60 dark:bg-sky-900/20 dark:text-sky-200">
                {section.note}
              </div>
            )}
          </div>
          <div className="divide-y divide-slate-100 dark:divide-slate-800">
            {section.fields.map((f) => {
              const s = byKey.get(f.key);
              const editing = editKey === f.key;
              const picks = f.optionsFrom ? accessListPicks : null;
              // Wait for name lookups before falling back to the raw ID, so the
              // ID doesn't flash on load.
              const resolving = !editing && (f.displayFrom === 'account-name' ? account.isLoading : !!picks?.loading);
              const shownValue = editing
                ? draft
                : resolving
                  ? ''
                  : f.displayFrom === 'account-name'
                    ? account.data?.name ?? effective(f.key)
                    : picks?.options.find((o) => o.value === effective(f.key))?.label ?? effective(f.key);
              const bytes =
                f.type === 'number' && f.key.endsWith('_BYTES') ? formatBytes(shownValue) : null;
              const locked = !editing;
              const inputClass = `${f.compact ? inputCls.replace('text-sm', 'text-xs') : inputCls}${
                f.type === 'textarea' ? ' font-mono' : ''
              } ${
                locked
                  ? 'bg-slate-50 text-slate-500 cursor-not-allowed dark:bg-slate-800/40 dark:text-slate-400'
                  : ''
              }`;
              return (
                <Fragment key={f.key}>
                <div
                  className="px-4 py-3 grid grid-cols-1 sm:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)_6rem] gap-2 sm:gap-4 items-start"
                >
                  <div className="min-w-0">
                    <label htmlFor={f.key} className="text-sm font-medium flex items-center gap-2 flex-wrap">
                      {f.label}
                    </label>
                    <p className="text-xs text-slate-500 mt-0.5 dark:text-slate-400">{f.help}</p>
                    {!f.hideKey && (
                      <p className="text-[11px] text-slate-400 mt-0.5 font-mono dark:text-slate-500">{f.key}</p>
                    )}
                  </div>

                  <div className={f.type === 'boolean' ? 'sm:col-span-2 min-w-0' : 'min-w-0'}>
                    {f.type === 'boolean' ? (
                      <div className="flex items-center justify-end gap-3">
                        {!f.readOnly && s && s.source === 'db' && (
                          <button
                            type="button"
                            onClick={() => resetField(f.key)}
                            disabled={editKey !== null || save.isPending}
                            title="Clear the override and revert to the default value"
                            className="text-xs rounded px-3 py-1.5 text-slate-500 hover:text-red-600 disabled:opacity-40 dark:text-slate-400"
                          >
                            Reset
                          </button>
                        )}
                        <Toggle
                          checked={shownValue === 'true'}
                          disabled={save.isPending || editKey !== null}
                          onChange={(next) => save.mutate({ [f.key]: next ? 'true' : 'false' })}
                        />
                        {s && !f.hideSource && (!f.hideOverride || s.source === 'default') && <SourceBadge source={s.source} editing={false} />}
                      </div>
                    ) : f.type === 'textarea' ? (
                      <textarea
                        id={f.key}
                        rows={f.rows ?? 2}
                        value={shownValue}
                        readOnly={locked}
                        onChange={(e) => setDraft(e.target.value)}
                        className={inputClass}
                      />
                    ) : picks ? (
                      locked ? (
                        // When not editing, show the value as a read-only input so
                        // it matches every other setting (same font colour); a
                        // disabled <select> would render washed-out.
                        <input
                          id={f.key}
                          type="text"
                          value={shownValue}
                          placeholder={resolving ? 'Loading…' : undefined}
                          readOnly
                          className={inputClass}
                        />
                      ) : (
                        (() => {
                          const { options } = picks;
                          return (
                            <select
                              id={f.key}
                              value={shownValue}
                              onChange={(e) => {
                                setDraft(e.target.value);
                                setFieldError(null);
                              }}
                              className={inputClass}
                            >
                              {options.map((o) => (
                                <option key={o.value} value={o.value}>
                                  {o.label}
                                </option>
                              ))}
                              {/* Keep the current value selectable if it isn't in the
                                  fetched list (still loading, or no longer present). */}
                              {shownValue !== '' && !options.some((o) => o.value === shownValue) && (
                                <option value={shownValue}>{shownValue}</option>
                              )}
                            </select>
                          );
                        })()
                      )
                    ) : (
                      <input
                        id={f.key}
                        type={f.type === 'number' ? 'number' : 'text'}
                        value={shownValue}
                        placeholder={resolving ? 'Loading…' : undefined}
                        readOnly={locked}
                        onChange={(e) => setDraft(e.target.value)}
                        className={inputClass}
                      />
                    )}
                    <div className="flex items-center gap-3 mt-1 text-[11px] text-slate-400 dark:text-slate-500">
                      {bytes && <span>{bytes}</span>}
                      {s && !f.hideSource && f.type !== 'boolean' && (
                        <SourceBadge source={s.source} editing={editing} />
                      )}
                      {s && s.source === 'db' && f.type !== 'boolean' && !f.hideSource && !f.hideOverride && (
                        <span>overrides default “{s.fallback || '∅'}”</span>
                      )}
                      {(editing || f.type === 'boolean') && fieldError && (
                        <span className="text-red-600">{fieldError}</span>
                      )}
                      {savedKey === f.key && (
                        <span className="text-emerald-600 dark:text-emerald-400">Saved.</span>
                      )}
                    </div>
                    {editing &&
                      picks &&
                      (() => {
                        if (picks.loading) {
                          return (
                            <p className="mt-1.5 text-[11px] text-slate-500 dark:text-slate-400">
                              Loading {picks.noun}…
                            </p>
                          );
                        }
                        const msg = picks.options.length === 0
                          ? picks.error
                            ? `Couldn’t load ${picks.noun}: ${picks.error}.`
                            : picks.empty
                          : null;
                        return msg ? (
                          <p className="mt-1.5 text-[11px] leading-relaxed text-red-600 dark:text-red-400">
                            {msg}
                          </p>
                        ) : null;
                      })()}
                    {f.key === 'DEFAULT_FOOTER_HTML' && (
                      <div className="mt-2">
                        <span className="text-xs text-slate-500 dark:text-slate-400">Preview</span>
                        <iframe
                          title="Footer HTML preview"
                          sandbox=""
                          srcDoc={buildHtmlPreview(shownValue)}
                          className="mt-0.5 w-full h-[160px] border border-slate-200 rounded bg-white dark:border-slate-700"
                        />
                      </div>
                    )}
                    {f.key === 'DEFAULT_FOOTER_TEXT' && (
                      <div className="mt-2">
                        <span className="text-xs text-slate-500 dark:text-slate-400">Preview</span>
                        <pre className="mt-0.5 w-full h-[120px] overflow-auto border border-slate-200 rounded bg-slate-50 p-2 text-xs whitespace-pre-wrap font-mono text-slate-700 dark:border-slate-700 dark:bg-slate-800/40 dark:text-slate-200">
                          {buildPlainPreview(shownValue)}
                        </pre>
                      </div>
                    )}
                  </div>

                  {f.type !== 'boolean' && <div className="flex flex-col gap-1.5">
                    {f.readOnly ? null : editing ? (
                      <>
                        <button
                          type="button"
                          onClick={() => saveField(f.key)}
                          disabled={!changed || save.isPending}
                          className="w-full bg-slate-900 text-white text-xs rounded px-3 py-1.5 disabled:opacity-40 dark:bg-slate-100 dark:text-slate-900"
                        >
                          {save.isPending ? 'Saving…' : 'Save'}
                        </button>
                        <button
                          type="button"
                          onClick={cancelEdit}
                          disabled={save.isPending}
                          className="w-full text-xs rounded px-3 py-1.5 border border-slate-300 text-slate-600 hover:bg-slate-100 dark:border-slate-600 dark:text-slate-300 dark:hover:bg-slate-800"
                        >
                          Cancel
                        </button>
                      </>
                    ) : (
                      <>
                        <button
                          type="button"
                          onClick={() => startEdit(f.key)}
                          disabled={editKey !== null || (!!f.enabledBy && effective(f.enabledBy) === 'false')}
                          className="w-full text-xs rounded px-3 py-1.5 border border-slate-300 text-slate-700 hover:bg-slate-100 disabled:opacity-40 dark:border-slate-600 dark:text-slate-200 dark:hover:bg-slate-800"
                        >
                          Edit
                        </button>
                        {s && s.source === 'db' && !f.readOnly && !f.hideSource && !f.hideOverride && (
                          <button
                            type="button"
                            onClick={() => resetField(f.key)}
                            disabled={editKey !== null || save.isPending}
                            title="Clear the override and revert to the default value"
                            className="w-full text-xs rounded px-3 py-1.5 text-slate-500 hover:text-red-600 disabled:opacity-40 dark:text-slate-400"
                          >
                            Reset
                          </button>
                        )}
                      </>
                    )}
                  </div>}
                </div>
                </Fragment>
              );
            })}
          </div>
        </section>
      ))}

    </div>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`shrink-0 px-3 py-2 text-sm -mb-px border-b-2 ${
        active
          ? 'border-slate-900 text-slate-900 font-medium dark:border-slate-100 dark:text-slate-100'
          : 'border-transparent text-slate-500 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-100'
      }`}
    >
      {children}
    </button>
  );
}

function Toggle({
  checked,
  disabled,
  onChange,
}: {
  checked: boolean;
  disabled?: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors disabled:opacity-50 ${
        checked ? 'bg-emerald-500' : 'bg-slate-300 dark:bg-slate-600'
      }`}
    >
      <span
        className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform ${
          checked ? 'translate-x-4' : 'translate-x-0.5'
        }`}
      />
    </button>
  );
}

// ---------------------------------------------------------------------------
// Footer preview helpers (mirror the consumer's token substitution so what
// operators see in Settings matches what subscribers receive).
// ---------------------------------------------------------------------------

const FOOTER_SAMPLE_VARS: Record<string, string> = {
  unsubscribe_url: 'https://track.example.com/u/123?t=sample-token',
  newsletter_name: 'Newsletter name',
  email: 'subscriber@example.com',
};
const FOOTER_TOKEN_RE = /\{\{\s*(unsubscribe_url|newsletter_name|email)\s*\}\}/g;

function buildHtmlPreview(template: string): string {
  const hadUnsub = /\{\{\s*unsubscribe_url\s*\}\}/.test(template);
  let body = template.replace(FOOTER_TOKEN_RE, (_m, k: string) => FOOTER_SAMPLE_VARS[k] ?? '');
  if (!hadUnsub) {
    body +=
      `\n<p style="font-size:12px;line-height:1.5;color:#64748b;margin:8px 0 0">` +
      `<a href="${FOOTER_SAMPLE_VARS.unsubscribe_url}" style="color:#64748b">Unsubscribe</a></p>`;
  }
  return (
    `<!doctype html><html><head><meta charset="utf-8">` +
    `<style>body{font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;` +
    `font-size:14px;color:#0f172a;margin:12px;background:#fff}a{color:#2563eb}</style></head>` +
    `<body>${body}</body></html>`
  );
}

function buildPlainPreview(template: string): string {
  const hadUnsub = /\{\{\s*unsubscribe_url\s*\}\}/.test(template);
  let body = template.replace(FOOTER_TOKEN_RE, (_m, k: string) => FOOTER_SAMPLE_VARS[k] ?? '');
  if (!hadUnsub) body += `\nUnsubscribe: ${FOOTER_SAMPLE_VARS.unsubscribe_url}`;
  return body;
}

function SourceBadge({ source, editing }: { source: Setting['source']; editing: boolean }) {
  if (editing) {
    return (
      <span className="text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300">
        editing
      </span>
    );
  }
  if (source === 'db') {
    return (
      <span className="text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300">
        overridden
      </span>
    );
  }
  return (
    <span className="text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded bg-slate-100 text-slate-600 dark:bg-slate-700 dark:text-slate-300">
      default
    </span>
  );
}
