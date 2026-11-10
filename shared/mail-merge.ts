import { sanitizeFooterHtml } from './footer';

export const MAIL_MERGE_HTML_MAX = 20000;
export const MAIL_MERGE_TEXT_MAX = 5000;

export interface MailMergeSettings {
  mail_merge_enabled: number;
  mail_merge_html: string | null;
  mail_merge_text: string | null;
}

export function sanitizeMailMergeHtml(template: string): string {
  // A subscriber name is data, not a trusted URL like the footer's unsubscribe token.
  return sanitizeFooterHtml(template, false);
}

export function renderMailMerge(template: string, name: string | null | undefined, html: boolean): string {
  const value = name ?? '';
  const escaped = html
    ? value.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!))
    : value;
  return template.replace(/\{\{\s*subscriber_name\s*\}\}/g, () => escaped);
}

export function applyMailMerge(
  settings: MailMergeSettings,
  name: string | null | undefined,
  html: string,
  text: string,
): { html: string; text: string } {
  if (settings.mail_merge_enabled !== 1) return { html, text };
  if (settings.mail_merge_html?.trim()) {
    const header = renderMailMerge(settings.mail_merge_html, name, true);
    // Insert inside full HTML documents as well as supporting body fragments.
    const body = /<body\b[^>]*>/i;
    html = body.test(html)
      ? html.replace(body, (tag) => `${tag}\n${header}\n`)
      : `${header}\n${html}`;
  }
  if (settings.mail_merge_text?.trim()) {
    const header = renderMailMerge(settings.mail_merge_text, name, false);
    text = header + (text ? '\n\n' + text : '');
  }
  return { html, text };
}
