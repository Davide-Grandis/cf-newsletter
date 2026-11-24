import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { api, CampaignDetail as Detail, Page, Send, TimeseriesRow } from '../api';
import { StatusPill } from './Subscribers';
import { ACTIVE_CAMPAIGN_STATUSES, CampaignStatus } from './Campaigns';
import { PAGE_SIZE, Pagination } from '../components/Pagination';
import { useState, type ReactNode } from 'react';
import { RefreshIcon } from './Dashboard';
import { useIdentity } from '../auth';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { fmtDate } from '../utils/date';

export default function CampaignDetail() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const me = useIdentity();
  const isSuper = me.data?.role === 'super_admin';

  const detail = useQuery({
    queryKey: ['campaign', id],
    queryFn: () => api<Detail>(`/api/campaigns/${id}`),
    // Keep delivery progress current while the campaign is being sent.
    refetchInterval: (q) => (ACTIVE_CAMPAIGN_STATUSES.includes(q.state.data?.campaign.status ?? '') ? 30_000 : false),
  });
  const ts = useQuery({
    queryKey: ['campaign-ts', id],
    queryFn: () => api<{ items: TimeseriesRow[] }>(`/api/campaigns/${id}/timeseries?bucket=hour`),
  });

  const [confirmDelete, setConfirmDelete] = useState(false);
  const [tab, setTab] = useState<'events' | 'logs'>('events');
  const deleteMutation = useMutation({
    mutationFn: () => api(`/api/campaigns/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['campaigns'] });
      navigate('/campaigns');
    },
  });

  const evt = Object.fromEntries((detail.data?.events ?? []).map((e) => [e.type, e.n]));
  const tracking = trackingState(detail.data?.campaign);
  const linkMode = detail.data?.campaign.link_mode === 1;
  const chartData = pivotTimeseries(ts.data?.items ?? []);

  const refreshing = detail.isFetching || ts.isFetching;
  const status = detail.data?.campaign.status;
  function refresh() { detail.refetch(); ts.refetch(); }

  return (
    <div className="space-y-6">
      <div className="flex items-start gap-3">
        <div>
          <Link to="/campaigns" className="text-sm text-slate-500 hover:underline dark:text-slate-400">← Campaigns</Link>
          <h1 className="text-xl font-semibold mt-1">{detail.data?.campaign.subject ?? ''}</h1>
          {detail.data?.campaign.newsletter_name && (
            <div className="mt-2 text-base text-slate-600 dark:text-slate-300">{detail.data.campaign.newsletter_name}</div>
          )}
        </div>
        <div className="ml-auto mt-1 flex items-center gap-2">
          {isSuper && status && !ACTIVE_CAMPAIGN_STATUSES.includes(status) && (
            <button
              type="button"
              onClick={() => setConfirmDelete(true)}
              className="inline-flex items-center gap-1.5 text-sm border border-red-200 rounded px-3 py-1.5 text-red-600 bg-white hover:bg-red-50 dark:bg-slate-900 dark:border-red-800 dark:text-red-400 dark:hover:bg-red-900/20"
            >
              Delete
            </button>
          )}
          <button
            type="button"
            onClick={refresh}
            disabled={refreshing}
            className="inline-flex items-center gap-1.5 text-sm border border-slate-200 rounded px-3 py-1.5 bg-white hover:bg-slate-50 disabled:opacity-50 dark:bg-slate-900 dark:border-slate-700 dark:hover:bg-slate-800"
          >
            <RefreshIcon spinning={refreshing} />
            Refresh
          </button>
        </div>
      </div>

      <ConfirmDialog
        open={confirmDelete}
        title="Delete campaign"
        message={`Permanently delete "${detail.data?.campaign.subject ?? id}"? This removes all send records, events and logs for this campaign and cannot be undone.`}
        confirmLabel="Delete"
        danger
        busy={deleteMutation.isPending}
        onConfirm={() => deleteMutation.mutate()}
        onCancel={() => setConfirmDelete(false)}
      />

      {detail.data && (
        <>
          <StatRow title="Delivery">
            <StatGroup>
              <Stat label="Status" highlight value={<CampaignStatus status={detail.data.campaign.status} large />} />
            </StatGroup>
            <StatGroup>
              <Stat label="Subscribers" value={detail.data.campaign.total_recipients} />
              <Stat label="Dispatched" tip="Handed off for sending so far, on any day" value={detail.data.campaign.released_count ?? 0} ok />
              <Stat label="Paused" tip="Waiting for a later day's sending budget, or a retry" value={detail.data.campaign.paused_count ?? 0} />
            </StatGroup>
            <StatGroup>
              <Stat label="Sent" value={detail.data.campaign.sent_count} ok />
              <Stat label="Failed" value={detail.data.campaign.failed_count} bad />
              <Stat label="Bounces" value={evt.bounce ?? 0} />
            </StatGroup>
          </StatRow>
          <ReleaseNote campaign={detail.data.campaign} />
          <StatRow title="Analytics">
            <AnalyticsStrip campaign={detail.data.campaign} evt={evt} tracking={tracking} linkMode={linkMode} />
          </StatRow>
        </>
      )}

      {detail.data && detail.data.attachments.length > 0 && (
        <section>
          <h2 className="text-base font-medium mb-2">
            Attachments ({detail.data.attachments.length})
            <span className="ml-2 text-xs font-normal text-slate-500 dark:text-slate-400">
              {linkMode ? 'sent as download links' : 'attached to each email'}
            </span>
          </h2>
          <ul className="bg-white border border-slate-200 rounded divide-y divide-slate-100 text-sm dark:bg-slate-900 dark:border-slate-800 dark:divide-slate-800">
            {detail.data.attachments.map((a) => (
              <li key={a.id} className="p-2 flex justify-between">
                <span>{a.filename} <span className="text-xs text-slate-500 dark:text-slate-400">({a.disposition})</span></span>
                <span className="text-xs text-slate-500 dark:text-slate-400">{a.content_type} · {(a.size / 1024).toFixed(1)} KB</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section>
        <div className="flex gap-1 border-b border-slate-200 dark:border-slate-800 mb-4">
          <TabButton active={tab === 'events'} onClick={() => setTab('events')}>Events</TabButton>
          <TabButton active={tab === 'logs'} onClick={() => setTab('logs')}>Logs</TabButton>
        </div>
        {tab === 'events' ? (
          chartData.length === 0 ? (
            <div className="bg-white border border-slate-200 rounded p-6 text-center text-sm text-slate-500 dark:bg-slate-900 dark:border-slate-800 dark:text-slate-400">
              No events for this campaign yet.
            </div>
          ) : (
          <div className="h-72 bg-white border border-slate-200 rounded p-2 dark:bg-slate-900 dark:border-slate-800">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={chartData}>
                <CartesianGrid strokeDasharray="3 3" className="stroke-slate-200 dark:stroke-slate-700" />
                <XAxis dataKey="bucket" fontSize={10} />
                <YAxis fontSize={10} />
                <Tooltip />
                <Legend />
                {tracking !== 'off' && <Bar dataKey="open" stackId="a" fill="#10b981" />}
                {tracking !== 'off' && <Bar dataKey="click" stackId="a" fill="#3b82f6" />}
                <Bar dataKey="bounce" stackId="a" fill="#f59e0b" />
                <Bar dataKey="unsubscribe" stackId="a" fill="#94a3b8" />
                <Bar dataKey="download" stackId="a" fill="#8b5cf6" />
              </BarChart>
            </ResponsiveContainer>
          </div>
          )
        ) : (
          <SendsTable campaignId={id} />
        )}
      </section>
    </div>
  );
}

// While subscribers are paused: when the next share is dispatched (normally the
// next UTC midnight), or that sending is held after an account-level error.
function ReleaseNote({ campaign }: { campaign: Detail['campaign'] }) {
  const paused = campaign.paused_count ?? 0;
  if (!ACTIVE_CAMPAIGN_STATUSES.includes(campaign.status) || paused === 0) return null;
  const next = campaign.next_release_at ? fmtDate(campaign.next_release_at) : '';
  return (
    <p className="text-xs text-slate-500 dark:text-slate-400 -mt-3">
      {campaign.dispatch_paused
        ? `Sending is paused after a Cloudflare sending limit or account error; it resumes automatically${next ? ` at ${next}` : ''}.`
        : `Paused subscribers are dispatched automatically ${next ? `from ${next}` : 'in the next sending window'}, as the daily sending budget allows (or when a temporary send error is retried).`}
    </p>
  );
}

// Whether this campaign's sent emails had open/click tracking: 'unknown' when
// no tracking state was recorded (sent before 2.6.5, or nothing sent yet).
type TrackingState = 'unknown' | 'off' | 'partial' | 'on';
function trackingState(campaign: Detail['campaign'] | undefined): TrackingState {
  const recorded = campaign?.tracking_recorded_count ?? 0;
  const tracked = campaign?.tracked_count ?? 0;
  if (recorded === 0) return 'unknown';
  if (tracked === 0) return 'off';
  return tracked < recorded ? 'partial' : 'on';
}

// One full-width strip: tracking (on/off, for how many subscribers), unique
// opens and clicks with their rate among tracked emails, unsubscribes with
// their rate among sent emails, and downloads in link mode. Opens and clicks
// are left out when no email was tracked.
function AnalyticsStrip({ campaign, evt, tracking, linkMode }: {
  campaign: Detail['campaign']; evt: Record<string, number>; tracking: TrackingState; linkMode: boolean;
}) {
  const tracked = campaign.tracked_count ?? 0;
  const recorded = campaign.tracking_recorded_count ?? 0;
  const sent = campaign.sent_count ?? 0;
  // A small non-zero share shows as "<1%" rather than a misleading "0%".
  const pct = (n: number, of: number) => (n > 0 && (100 * n) / of < 1 ? '<1%' : `${Math.round((100 * n) / of)}%`);
  const n = (v: number) => v.toLocaleString();
  const trackingValue = tracking === 'unknown'
    ? <span className="text-base font-medium text-slate-500 dark:text-slate-400">Not recorded</span>
    : <span className={`inline-flex items-center rounded px-2.5 py-1 text-sm font-medium ${tracking === 'off'
      ? 'bg-slate-100 text-slate-700 dark:bg-slate-700 dark:text-slate-200'
      : 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300'}`}>{tracking === 'off' ? 'Off' : 'On'}</span>;
  const trackingSub = tracking === 'unknown'
    ? 'sent before tracking was recorded'
    : tracking === 'off' ? `for none of ${n(recorded)} subscribers` : `for ${n(tracked)} of ${n(recorded)} subscribers`;
  const engagement = (unique: number, total: number) =>
    tracked > 0 ? `${pct(unique, tracked)} of tracked · ${n(total)} total` : `${n(total)} total`;
  return (
    <div className="w-full grid grid-cols-2 sm:grid-cols-3 lg:grid-flow-col lg:auto-cols-fr rounded-lg shadow-sm border bg-white border-slate-200 dark:bg-slate-900 dark:border-slate-800">
      <Segment label="Tracking" tip="Open and click tracking: the global switch, the newsletter's setting and each subscriber's consent" value={trackingValue} sub={trackingSub} />
      {tracking !== 'off' && <Segment label="Opens" tip="Subscribers who opened the email (unique)" value={n(campaign.unique_opens ?? 0)} sub={engagement(campaign.unique_opens ?? 0, evt.open ?? 0)} />}
      {tracking !== 'off' && <Segment label="Clicks" tip="Subscribers who clicked a link (unique)" value={n(campaign.unique_clicks ?? 0)} sub={engagement(campaign.unique_clicks ?? 0, evt.click ?? 0)} />}
      <Segment label="Unsubs" tip="Subscribers who unsubscribed from this campaign" value={n(evt.unsubscribe ?? 0)} sub={sent > 0 ? `${pct(evt.unsubscribe ?? 0, sent)} of sent` : undefined} />
      {/* Downloads are counted only in link mode, where attachments are
          delivered as download links instead of inside each email. */}
      {linkMode && <Segment label="Downloads" tip="Times subscribers downloaded the attachments from their links" value={n(evt.download ?? 0)} sub="attachment downloads" />}
    </div>
  );
}

function Segment({ label, value, sub, tip }: { label: string; value: ReactNode; sub?: string; tip?: string }) {
  return (
    <div className="p-4 lg:border-l lg:first:border-l-0 border-slate-200 dark:border-slate-800" title={tip}>
      <div className="text-xs uppercase tracking-wide whitespace-nowrap text-slate-500 dark:text-slate-400">{label}</div>
      <div className="text-2xl font-semibold mt-1 whitespace-nowrap text-slate-900 dark:text-slate-100">{value}</div>
      {sub && <div className="text-xs text-slate-400 mt-0.5 dark:text-slate-500">{sub}</div>}
    </div>
  );
}

function StatRow({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div>
      <div className="flex items-center gap-3 mb-3">
        <h2 className="text-base font-medium">{title}</h2>
        <div className="flex-1 border-t border-slate-200 dark:border-slate-800" />
      </div>
      <div className="flex flex-wrap items-stretch gap-4">{children}</div>
    </div>
  );
}

// A light background that groups related cards within a row. It is only as
// wide as its cards (fixed width), and wraps them when space runs out.
function StatGroup({ children }: { children: ReactNode }) {
  return (
    <div className="flex flex-wrap gap-3 rounded-xl bg-slate-100/70 p-2 dark:bg-slate-800/30">{children}</div>
  );
}

function Stat({ label, value, ok, bad, tip, highlight, sub }: { label: string; value: ReactNode; ok?: boolean; bad?: boolean; tip?: string; highlight?: boolean; sub?: string }) {
  const cls = ok ? 'text-emerald-700 dark:text-emerald-400' : bad ? 'text-red-700 dark:text-red-400' : 'text-slate-900 dark:text-slate-100';
  // Same card style as the dashboard; the highlighted card gets a neutral accent
  // (a stronger frame and a left bar), so only its status badge carries colour.
  const frame = highlight
    ? 'bg-white border-slate-300 border-l-4 border-l-slate-700 ring-1 ring-slate-200 dark:bg-slate-900 dark:border-slate-600 dark:border-l-slate-300 dark:ring-slate-700'
    : 'bg-white border-slate-200 dark:bg-slate-900 dark:border-slate-800';
  return (
    <div className={`w-36 rounded-lg shadow-sm border p-4 ${frame}`} title={tip}>
      <div className={`text-xs uppercase tracking-wide whitespace-nowrap ${highlight ? 'font-bold text-orange-600 dark:text-orange-400' : 'text-slate-500 dark:text-slate-400'}`}>{label}</div>
      <div className={`text-2xl font-semibold mt-1 whitespace-nowrap ${cls}`}>
        {typeof value === 'number' ? value.toLocaleString() : value}
      </div>
      {sub && <div className="text-xs text-slate-400 mt-0.5 dark:text-slate-500" title="Emails sent with open and click tracking">{sub}</div>}
    </div>
  );
}

function TabButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`shrink-0 whitespace-nowrap px-3 py-2 text-sm -mb-px border-b-2 ${
        active
          ? 'border-slate-900 text-slate-900 font-medium dark:border-slate-100 dark:text-slate-100'
          : 'border-transparent text-slate-500 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-100'
      }`}
    >
      {children}
    </button>
  );
}

function pivotTimeseries(rows: TimeseriesRow[]): Record<string, number | string>[] {
  const buckets = new Map<string, Record<string, number | string>>();
  for (const r of rows) {
    const b = buckets.get(r.bucket) ?? { bucket: r.bucket };
    (b as Record<string, number | string>)[r.type] = r.n;
    buckets.set(r.bucket, b);
  }
  return Array.from(buckets.values());
}

function SendsTable({ campaignId }: { campaignId: string }) {
  const [status, setStatus] = useState('');
  const [page, setPage] = useState(0);
  const sends = useQuery({
    queryKey: ['campaign-sends', campaignId, status, page],
    placeholderData: keepPreviousData,
    queryFn: () => {
      const sp = new URLSearchParams({ limit: String(PAGE_SIZE), cursor: String(page * PAGE_SIZE) });
      if (status) sp.set('status', status);
      return api<Page<Send>>(`/api/campaigns/${campaignId}/sends?${sp.toString()}`);
    },
  });
  return (
    <section>
      <div className="flex items-center gap-2 mb-2">
        <p className="text-sm text-slate-500 dark:text-slate-400">Delivery log for each subscriber.</p>
        <select
          value={status}
          onChange={(e) => { setStatus(e.target.value); setPage(0); }}
          className="border border-slate-300 rounded px-2 py-1 text-xs ml-auto bg-white text-slate-900 dark:bg-slate-800 dark:border-slate-700 dark:text-slate-100"
        >
          <option value="">All</option>
          <option value="sent">Sent</option>
          <option value="failed">Failed</option>
          <option value="bounced">Bounced</option>
          <option value="pending">Pending</option>
        </select>
      </div>
      <div className="bg-white border border-slate-200 rounded overflow-hidden dark:bg-slate-900 dark:border-slate-800">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-slate-600 dark:bg-slate-800/60 dark:text-slate-300">
            <tr>
              <th className="text-left p-2">Email</th>
              <th className="text-left p-2">Status</th>
              <th className="text-left p-2">Sent at</th>
              <th className="text-left p-2">Error</th>
            </tr>
          </thead>
          <tbody>
            {sends.data?.items.map((s) => (
              <tr key={s.id} className="border-t border-slate-100 dark:border-slate-800">
                <td className="p-2 font-mono text-xs">{s.email ?? `#${s.subscriber_id}`}</td>
                <td className="p-2"><StatusPill status={s.status} /></td>
                <td className="p-2 text-slate-500 dark:text-slate-400">{s.sent_at ? fmtDate(s.sent_at) : '—'}</td>
                <td className="p-2 text-red-700 text-xs dark:text-red-400">{s.error ?? ''}</td>
              </tr>
            ))}
            {sends.data && sends.data.items.length === 0 && (
              <tr><td colSpan={4} className="p-4 text-center text-slate-500 dark:text-slate-400">No matching sends.</td></tr>
            )}
          </tbody>
        </table>
      </div>
      <div className="mt-2">
        <Pagination
          page={page}
          total={sends.data?.total ?? 0}
          itemCount={sends.data?.items.length ?? 0}
          busy={sends.isFetching}
          onPage={setPage}
        />
      </div>
    </section>
  );
}
