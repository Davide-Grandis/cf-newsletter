import { FormEvent, useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api, Newsletter } from '../api';
import { useIdentity } from '../auth';
import { Tooltip } from '../components/Tooltip';
import { PAGE_SIZE, Pagination } from '../components/Pagination';

type SortKey = 'name' | 'inbound_address' | 'subscriber_count' | 'author_count' | 'enabled';
type NewsletterList = {
  items: Newsletter[];
  total: number;
  enabledTotal: number;
  filteredTotal: number;
  nextCursor: number | null;
};

export default function Newsletters() {
  const qc = useQueryClient();
  const [err, setErr] = useState<string | null>(null);
  const [warn, setWarn] = useState<string | null>(null);
  const [sort, setSort] = useState<{ key: SortKey; dir: 'asc' | 'desc' }>({ key: 'name', dir: 'asc' });
  const [showSearch, setShowSearch] = useState(false);
  const [query, setQuery] = useState('');
  const [search, setSearch] = useState('');

  const [inboundLocal, setInboundLocal] = useState('');
  const [senderLocal, setSenderLocal] = useState('');
  const [replyToAuthor, setReplyToAuthor] = useState(false);
  const [showCreateForm, setShowCreateForm] = useState(false);

  const [page, setPage] = useState(0);
  useEffect(() => {
    const timeout = window.setTimeout(() => {
      setSearch(query.trim());
      setPage(0);
    }, 250);
    return () => window.clearTimeout(timeout);
  }, [query]);
  const list = useQuery({
    queryKey: ['newsletters', page, search, sort.key, sort.dir],
    queryFn: () => {
      const params = new URLSearchParams({
        limit: String(PAGE_SIZE),
        cursor: String(page * PAGE_SIZE),
        q: search,
        sort: sort.key,
        direction: sort.dir,
      });
      return api<NewsletterList>(`/api/newsletters?${params}`);
    },
  });
  const items = list.data?.items ?? [];

  // Sending domain and default sender come from the identity payload — admins
  // cannot read the super_admin-only settings endpoint. The address inputs
  // only take the local part and the domain is appended. `canCreate` mirrors
  // the server rule: super admins always; otherwise an edit-capable admin with
  // the global create/delete toggle on (read-only admins never create).
  const me = useIdentity();
  const domain = me.data?.base_domain ?? '';
  const defaultSenderLocal = localPart(me.data?.from_address ?? '');
  const isEditAdmin = (me.data?.newsletters ?? []).some((n) => n.capability === 'edit');
  const canCreate =
    me.data?.role === 'super_admin' || (!!me.data?.allow_admin_newsletter_crud && isEditAdmin);

  function toggleSort(key: SortKey) {
    setPage(0);
    setSort((s) => (s.key === key ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'asc' }));
  }

  const create = useMutation({
    mutationFn: (body: { name: string; inbound_address: string; from_address?: string; reply_to_address?: string; reply_to_author: boolean }) =>
      api<{ routing_warning?: string }>('/api/newsletters', { method: 'POST', body: JSON.stringify(body) }),
    onSuccess: (res) => {
      setWarn(res.routing_warning ?? null);
      qc.invalidateQueries({ queryKey: ['newsletters'] });
    },
  });

  const toggle = useMutation({
    mutationFn: (vars: { id: string; enabled: boolean }) =>
      api<{ routing_warning?: string }>(`/api/newsletters/${vars.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ enabled: vars.enabled }),
      }),
    onSuccess: (res) => {
      setWarn(res.routing_warning ?? null);
      qc.invalidateQueries({ queryKey: ['newsletters'] });
    },
  });

  function onCreate(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setErr(null);
    const fd = new FormData(e.currentTarget);
    const name = String(fd.get('name') ?? '').trim();
    const inbound = inboundLocal.trim();
    const sender = senderLocal.trim();
    const replyTo = String(fd.get('reply_to_address') ?? '').trim();
    const useAuthorReplyTo = fd.get('reply_to_author') === 'on';
    if (!name || !inbound) return;
    const form = e.currentTarget;
    create.mutate(
      {
        name,
        inbound_address: `${inbound}@${domain}`,
        from_address: sender ? `${sender}@${domain}` : undefined,
        reply_to_address: replyTo || undefined,
        reply_to_author: useAuthorReplyTo,
      },
      {
        onSuccess: () => {
          form.reset();
          setInboundLocal('');
          setSenderLocal('');
          setReplyToAuthor(false);
          setShowCreateForm(false);
        },
        onError: (e) => setErr((e as Error).message),
      },
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold">
          Newsletters
          {list.data && (
            <span className="ml-2 text-xl font-normal text-slate-500 dark:text-slate-400">
              (total {list.data.total}, enabled {list.data.enabledTotal})
            </span>
          )}
        </h1>
        <p className="text-sm text-slate-500 mt-2 dark:text-slate-400">
          Each newsletter is an independent mailing list with its own inbound address, authors and
          subscribers.
        </p>
      </div>

      {warn && (
        <div className="flex items-start gap-2 text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded p-2 dark:text-amber-300 dark:bg-amber-900/30 dark:border-amber-800/60">
          <span className="flex-1">{warn}</span>
          <button onClick={() => setWarn(null)} className="text-amber-600 hover:underline dark:text-amber-400">dismiss</button>
        </div>
      )}

      {canCreate && (
        <div
          className={`rounded border p-3 bg-white dark:bg-slate-900 ${
            showCreateForm ? 'border-orange-500 dark:border-orange-400' : 'border-slate-200 dark:border-slate-800'
          }`}
        >
          {showCreateForm ? (
            <form onSubmit={onCreate} className="flex flex-col gap-3 md:flex-row md:items-start">
              <div className="min-w-0 flex-1 flex flex-col gap-2">
                <div className="grid grid-cols-1 md:grid-cols-2 gap-2 items-end">
                  <div className="min-w-0">
                    <label className="text-xs uppercase tracking-wide text-slate-500 dark:text-slate-400">Name</label>
                    <input name="name" required placeholder="Weekly digest" className={inputCls} />
                  </div>
                  <div className="min-w-0">
                    <label className="text-xs uppercase tracking-wide text-slate-500 dark:text-slate-400">
                      Sender <span className="normal-case tracking-normal text-slate-400">(defaults to "newsletter")</span>
                    </label>
                    <LocalPartInput
                      value={senderLocal}
                      onChange={setSenderLocal}
                      domain={domain}
                      placeholder={defaultSenderLocal || 'default'}
                    />
                  </div>
                </div>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-2 items-end">
                  <div className="min-w-0">
                    <label className="text-xs uppercase tracking-wide text-slate-500 dark:text-slate-400">Inbound address</label>
                    <LocalPartInput value={inboundLocal} onChange={setInboundLocal} domain={domain} placeholder="digest" />
                  </div>
                  <div className="min-w-0 flex flex-col gap-2">
                    <div>
                      <label className="text-xs uppercase tracking-wide text-slate-500 dark:text-slate-400">
                        Reply-To address <span className="normal-case tracking-normal text-slate-400">(optional)</span>
                      </label>
                      <input
                        type="email"
                        name="reply_to_address"
                        disabled={replyToAuthor}
                        placeholder={replyToAuthor ? 'Using campaign author' : 'replies@example.com'}
                        className={inputCls}
                      />
                    </div>
                    <label className="flex items-center gap-2 text-sm text-slate-600 dark:text-slate-300">
                      <input
                        type="checkbox"
                        name="reply_to_author"
                        checked={replyToAuthor}
                        onChange={(e) => setReplyToAuthor(e.target.checked)}
                      />
                      Use campaign author’s email for replies
                    </label>
                  </div>
                </div>
                {err && <div className="text-xs text-red-600">{err}</div>}
              </div>
              <div className="flex flex-col gap-2 md:w-28">
                <button
                  type="button"
                  disabled={create.isPending}
                  onClick={() => {
                    setErr(null);
                    setInboundLocal('');
                    setSenderLocal('');
                    setReplyToAuthor(false);
                    setShowCreateForm(false);
                  }}
                  className="w-full text-sm rounded px-3 py-1.5 border border-slate-300 text-slate-600 hover:bg-slate-100 disabled:opacity-50 dark:border-slate-600 dark:text-slate-300 dark:hover:bg-slate-800"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={create.isPending}
                  className="w-full bg-slate-900 text-white text-sm rounded px-3 py-1.5 disabled:opacity-50 dark:bg-slate-100 dark:text-slate-900"
                >
                  {create.isPending ? 'Saving…' : 'Save'}
                </button>
              </div>
            </form>
          ) : (
            <div className="flex justify-end">
              <button
                type="button"
                onClick={() => {
                  setErr(null);
                  setShowCreateForm(true);
                }}
                className="bg-slate-900 text-white text-sm rounded px-3 py-1.5 dark:bg-slate-100 dark:text-slate-900"
              >
                Add newsletter
              </button>
            </div>
          )}
        </div>
      )}

      <div className="flex items-center justify-end gap-2">
        {showSearch && (
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search name or address…"
            className="w-56 border border-slate-300 rounded px-2 py-1 text-sm bg-white text-slate-900 dark:bg-slate-800 dark:border-slate-700 dark:text-slate-100"
          />
        )}
        <button
          type="button"
          aria-label="Search"
          onClick={() => {
            if (showSearch) {
              setQuery('');
              setPage(0);
            }
            setShowSearch(!showSearch);
          }}
          className={`inline-flex items-center justify-center rounded border p-1.5 ${
            showSearch
              ? 'border-slate-300 bg-slate-100 text-slate-900 dark:border-slate-600 dark:bg-slate-700 dark:text-slate-100'
              : 'border-slate-200 bg-white text-slate-500 hover:text-slate-900 dark:bg-slate-800 dark:border-slate-700 dark:text-slate-300 dark:hover:text-slate-100'
          }`}
        >
          <SearchIcon />
        </button>
      </div>

      <div className="bg-white border border-slate-200 rounded overflow-hidden dark:bg-slate-900 dark:border-slate-800">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-slate-600 dark:bg-slate-800/60 dark:text-slate-300">
            <tr>
              <Th label="Name" hint="(click to edit)" title="Newsletter name. Click a row's name to edit it." sortKey="name" sort={sort} onSort={toggleSort} className="w-1/4" />
              <Th label="Inbound address" title="Email address that authors send issues to. Mail here is routed to the ingest worker." sortKey="inbound_address" sort={sort} onSort={toggleSort} className="w-1/4" />
              <Th label="Subscribers" title="Shown as “active / total”: the first number is active subscribers (who receive sends), the second is the total number of subscribers." sortKey="subscriber_count" sort={sort} onSort={toggleSort} align="right" />
              <Th label="Authors" title="Number of authorized sender addresses for this newsletter." sortKey="author_count" sort={sort} onSort={toggleSort} align="right" />
              <Th label="Enabled" title="Whether the newsletter accepts inbound mail. Disabled newsletters reject incoming email." sortKey="enabled" sort={sort} onSort={toggleSort} align="right" />
            </tr>
          </thead>
          <tbody>
            {list.isLoading && (
              <tr><td colSpan={5} className="p-4 text-center text-slate-500 dark:text-slate-400">Loading…</td></tr>
            )}
            {items.map((n) => (
              <tr key={n.id} className="border-t border-slate-100 dark:border-slate-800">
                <td className="p-2">
                  <Link to={`/newsletters/${n.id}`} className="font-medium text-slate-900 hover:underline dark:text-slate-100">
                    {n.name}
                  </Link>
                </td>
                <td className="p-2 font-mono text-xs truncate">{n.inbound_address}</td>
                <td className="p-2 text-right">
                  <Tooltip text="Active subscribers / total subscribers (first = active, second = total)">
                    <span>
                      {n.active_count ?? 0}
                      <span className="text-slate-400 dark:text-slate-500"> / {n.subscriber_count ?? 0}</span>
                    </span>
                  </Tooltip>
                </td>
                <td className="p-2 text-right">{n.author_count ?? 0}</td>
                <td className="p-2 text-right">
                  <Toggle
                    on={n.enabled === 1}
                    busy={toggle.isPending}
                    onChange={(enabled) => toggle.mutate({ id: n.id, enabled })}
                  />
                </td>
              </tr>
            ))}
            {list.data && items.length === 0 && (
              <tr><td colSpan={5} className="p-4 text-center text-slate-500 dark:text-slate-400">{search ? 'No matches.' : 'No newsletters yet.'}</td></tr>
            )}
          </tbody>
        </table>
      </div>

      <Pagination
        page={page}
        total={list.data?.filteredTotal ?? 0}
        itemCount={items.length}
        busy={list.isFetching}
        onPage={setPage}
      />
    </div>
  );
}

function Th({
  label,
  hint,
  title,
  sortKey,
  sort,
  onSort,
  align = 'left',
  className = '',
}: {
  label: string;
  hint?: string;
  title?: string;
  sortKey: SortKey;
  sort: { key: SortKey; dir: 'asc' | 'desc' };
  onSort: (key: SortKey) => void;
  align?: 'left' | 'right';
  className?: string;
}) {
  const active = sort.key === sortKey;
  const button = (
    <button
      type="button"
      onClick={() => onSort(sortKey)}
      className={`inline-flex items-center gap-1 select-none hover:text-slate-900 dark:hover:text-slate-100 ${
        active ? 'text-slate-900 dark:text-slate-100' : ''
      }`}
    >
      {label}
      <SortIcon state={active ? sort.dir : 'none'} />
    </button>
  );
  return (
    <th className={`p-2 ${align === 'right' ? 'text-right' : 'text-left'} ${className}`}>
      <span className={`inline-flex items-center gap-1.5 ${align === 'right' ? 'flex-row-reverse' : ''}`}>
        {title ? <Tooltip text={title}>{button}</Tooltip> : button}
        {hint && <span className="font-normal normal-case tracking-normal text-slate-400 dark:text-slate-500">{hint}</span>}
      </span>
    </th>
  );
}

export function SortIcon({ state }: { state: 'asc' | 'desc' | 'none' }) {
  if (state === 'none') {
    return (
      <svg width="8" height="11" viewBox="0 0 8 11" className="text-slate-400 dark:text-slate-500" aria-hidden>
        <path d="M4 0 L7 4 L1 4 Z" fill="currentColor" />
        <path d="M4 11 L7 7 L1 7 Z" fill="currentColor" />
      </svg>
    );
  }
  return (
    <svg width="8" height="11" viewBox="0 0 8 11" className="text-orange-500" aria-hidden>
      {state === 'asc' ? (
        <path d="M4 1 L7.5 6 L0.5 6 Z" fill="currentColor" />
      ) : (
        <path d="M4 10 L7.5 5 L0.5 5 Z" fill="currentColor" />
      )}
    </svg>
  );
}

function SearchIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <circle cx="11" cy="11" r="8" />
      <path d="m21 21-4.3-4.3" />
    </svg>
  );
}

export function Toggle({ on, busy, onChange }: { on: boolean; busy?: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      disabled={busy}
      onClick={() => onChange(!on)}
      className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors disabled:opacity-50 ${
        on ? 'bg-emerald-500' : 'bg-slate-300 dark:bg-slate-600'
      }`}
    >
      <span
        className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
          on ? 'translate-x-4' : 'translate-x-1'
        }`}
      />
    </button>
  );
}

const inputCls =
  'block w-full border border-slate-300 rounded px-2 py-1 text-sm mt-0.5 bg-white text-slate-900 dark:bg-slate-800 dark:border-slate-700 dark:text-slate-100';

// Extracts the local part (before @) from an address, ignoring any display
// name, e.g. 'News <news@example.com>' -> 'news'.
export function localPart(addr: string): string {
  if (!addr) return '';
  const m = /<([^>]+)>/.exec(addr);
  const email = (m ? m[1]! : addr).trim();
  const at = email.indexOf('@');
  return at >= 0 ? email.slice(0, at) : email;
}

// Address input that only accepts the local part; the fixed sending domain is
// shown as a non-editable suffix. Typing an '@' (and anything after) is
// stripped automatically.
export function LocalPartInput({
  value,
  onChange,
  domain,
  placeholder,
  disabled,
}: {
  value: string;
  onChange: (v: string) => void;
  domain: string;
  placeholder?: string;
  disabled?: boolean;
}) {
  return (
    <div
      className={`flex items-stretch rounded border overflow-hidden mt-0.5 ${
        disabled
          ? 'border-slate-200 bg-slate-50 dark:border-slate-700 dark:bg-slate-800/40'
          : 'border-slate-300 bg-white dark:border-slate-700 dark:bg-slate-800'
      }`}
    >
      <input
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value.replace(/@.*$/, '').trimStart())}
        placeholder={placeholder}
        className="flex-[3] min-w-0 px-2 py-1 text-sm bg-transparent text-slate-900 outline-none disabled:cursor-not-allowed disabled:text-slate-500 dark:text-slate-100 dark:disabled:text-slate-400"
      />
      {domain && (
        <span className="flex-[4] min-w-0 flex items-center px-2 text-sm text-slate-400 bg-slate-50 border-l border-slate-200 select-none dark:bg-slate-800/60 dark:border-slate-700 dark:text-slate-500">
          @{domain}
        </span>
      )}
    </div>
  );
}
