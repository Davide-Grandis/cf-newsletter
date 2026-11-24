// Email sent to a console user when they are added or removed. Email-safe
// markup: tables, inline styles, no external images (the logo is an inline
// attachment referenced by cid).

export interface AccessEmailInput {
  event: 'added' | 'removed';
  role: 'super_admin' | 'admin';
  email: string;
  consoleUrl: string;
  /** Content-ID of the inline logo image, when one is attached. */
  logoCid?: string;
}

export interface AccessEmail {
  subject: string;
  text: string;
  html: string;
}

const APP_NAME = 'Newsletter Console';
const ACCENT = '#ea580c';

function esc(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}

export function consoleAccessEmail(input: AccessEmailInput): AccessEmail {
  const isSuper = input.role === 'super_admin';
  const roleLabel = isSuper ? 'Super administrator' : 'Administrator';
  const url = esc(input.consoleUrl);
  const added = input.event === 'added';
  const access = isSuper
    ? 'You have full access to the console, including all newsletters, user management and settings.'
    : 'You can manage subscribers, authors and campaigns for the newsletters you have been assigned to.';

  const subject = added ? `You have been added to the ${APP_NAME}` : `Your access to the ${APP_NAME} has been removed`;
  const text = added
    ? `Hello,\n\n` +
      `You have been granted access to the ${APP_NAME} as ${roleLabel}.\n\n` +
      `${access}\n\n` +
      `Open the console: ${input.consoleUrl}\n` +
      `Sign in with your organisation's single sign-on, using ${input.email}.\n\n` +
      `If you were not expecting this, please contact the person who added you.\n`
    : `Hello,\n\n` +
      `Your access to the ${APP_NAME} (previously ${roleLabel}) has been removed. ` +
      `You will no longer be able to sign in at ${input.consoleUrl}.\n\n` +
      `If you believe this is a mistake, please contact your console administrator.\n`;

  const logo = input.logoCid
    ? `<img src="cid:${esc(input.logoCid)}" width="40" height="40" alt="" style="display:block;width:40px;height:40px;border:0;object-fit:contain">`
    : '';
  const badge = `<span style="display:inline-block;padding:4px 10px;border-radius:999px;font-size:12px;font-weight:600;` +
    (added ? `background:#ffedd5;color:#9a3412` : `background:#f1f5f9;color:#475569`) + `">${roleLabel}</span>`;
  const body = added
    ? `<h1 style="margin:0 0 12px;font-size:20px;line-height:28px;color:#0f172a">Welcome to the ${APP_NAME}</h1>` +
      `<p style="margin:0 0 16px">You have been granted access as</p>` +
      `<p style="margin:0 0 20px">${badge}</p>` +
      `<p style="margin:0 0 24px">${esc(access)}</p>` +
      `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 24px"><tr>` +
      `<td bgcolor="${ACCENT}" style="border-radius:6px">` +
      `<a href="${url}" style="display:inline-block;padding:9px 20px;font-size:15px;font-weight:600;color:#ffffff;text-decoration:none;border-radius:6px">Open the console</a>` +
      `</td></tr></table>` +
      `<p style="margin:0;font-size:13px;color:#64748b">Sign in with your organisation's single sign-on, using <strong style="color:#334155">${esc(input.email)}</strong>. ` +
      `If the button doesn't work, open <a href="${url}" style="color:${ACCENT}">${url}</a>.</p>`
    : `<h1 style="margin:0 0 12px;font-size:20px;line-height:28px;color:#0f172a">Your console access has been removed</h1>` +
      `<p style="margin:0 0 16px">Your access to the ${APP_NAME} has been removed. You previously had the role</p>` +
      `<p style="margin:0 0 20px">${badge}</p>` +
      `<p style="margin:0">You will no longer be able to sign in at <a href="${url}" style="color:${ACCENT}">${url}</a>.</p>`;
  const footer = added
    ? 'If you were not expecting this, please contact the person who added you.'
    : 'If you believe this is a mistake, please contact your console administrator.';

  const html =
    `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(subject)}</title>` +
    `<style>@media (max-width:480px){.outer{padding:16px 8px!important}.card{padding:20px!important}}</style></head>` +
    `<body style="margin:0;padding:0;background:#f1f5f9">` +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f1f5f9"><tr><td class="outer" align="center" style="padding:32px 16px">` +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:15px;line-height:22px;color:#334155">` +
    `<tr><td style="padding:0 4px 16px"><table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>` +
    (logo ? `<td style="padding-right:12px;vertical-align:middle">${logo}</td>` : '') +
    `<td style="vertical-align:middle;font-size:17px;font-weight:600;color:#0f172a">${APP_NAME}</td>` +
    `</tr></table></td></tr>` +
    `<tr><td class="card" style="word-break:break-word;overflow-wrap:anywhere;background:#ffffff;border:1px solid #e2e8f0;border-top:4px solid ${added ? ACCENT : '#94a3b8'};border-radius:8px;padding:28px">${body}</td></tr>` +
    `<tr><td style="padding:16px 4px 0;font-size:12px;line-height:18px;color:#94a3b8">${footer}</td></tr>` +
    `</table></td></tr></table></body></html>`;
  return { subject, text, html };
}
