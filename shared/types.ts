// Queue messages (see shared/dispatch.ts): a dispatcher run, or one claimed
// batch of pending sends. Releases before 2.6.5 queued the recipients
// themselves ({ campaignId, batch }); the consumer still accepts those.
export type QueueMessage =
  | { kind: 'dispatch'; at?: number }
  | { kind: 'send'; campaignId: string; batchId: string }
  | { kind?: undefined; campaignId: string; batch: Recipient[] };

export interface Recipient {
  subscriberId: number;
  email: string;
  first_name?: string;
  last_name?: string;
  token: string;
}

export interface CampaignRow {
  id: string;
  subject: string;
  html: string | null;
  text: string | null;
  sent_by: string;
  status: string;
  link_mode: number;
  // Per-newsletter sender resolved via the campaign's newsletter. NULL means
  // fall back to newsletter@<BASE_DOMAIN>.
  from_address: string | null;
  reply_to_address: string | null;
  // The campaign's newsletter, used to resolve and personalise the footer.
  newsletter_id: string;
  newsletter_name: string | null;
  // Per-newsletter footer; NULL/empty falls back to the DEFAULT_FOOTER_* settings.
  footer_html: string | null;
  footer_text: string | null;
  footer_incoming: number | null;
  mail_merge_enabled: number;
  mail_merge_incoming: number;
  mail_merge_html: string | null;
  mail_merge_text: string | null;
  newsletter_tracking_enabled: number | null;
}

export interface AttachmentRow {
  id: number;
  campaign_id: string;
  r2_key: string;
  filename: string;
  content_type: string;
  size: number;
  sha256: string;
  content_id: string | null;
  disposition: 'attachment' | 'inline';
}
