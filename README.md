# cf-newsletter

[![Latest release](https://img.shields.io/github/v/release/Davide-Grandis/cf-newsletter?display_name=tag&include_prereleases)](https://github.com/Davide-Grandis/cf-newsletter/releases)

A self-hosted newsletter distribution solution for teams that want to author
campaigns by email and manage multiple lists from a secure web console. It
handles delivery, attachments, subscriptions, engagement tracking, bounces,
retention, sender controls and reputation warmup while keeping each newsletter
independently managed.

## Features

- **Multiple newsletters** — manage independent lists, inbound addresses,
  senders, footers, authors, administrators and subscribers.
- **Email-based authoring** — publish campaigns by emailing the newsletter's
  address from an approved sender.
- **Attachment support** — validate and deliver regular and inline attachments,
  with secure download links for larger files.
- **Engagement analytics** — optional open and click tracking, campaign metrics,
  delivery logs and downloadable reports.
- **Subscriber management** — add subscribers manually, import or export CSV,
  provide public double opt-in signup, and support one-click unsubscribe.
- **Deliverability controls** — sender authentication, bounce handling,
  configurable sending warmup and delivery limits.
- **Retention controls** — automatically remove campaigns and associated data
  after a configurable period.
- **Secure administration** — role-based access for global and per-newsletter
  administrators, with read-only and edit permissions.

## Install on Cloudflare

### Account requirements

Before running the browser-based installer, the target Cloudflare account must have:

- an active Cloudflare authoritative DNS zone (primary/full setup), with either no apex MX records or correctly configured Cloudflare Email Routing;
- Workers, D1, R2 and Queues available;
- Email Sending and Email Routing available for the zone;
- Zero Trust Access available.

The installer uses **Connect to Cloudflare** for temporary installation/update
authorization. The Cloudflare account must allow public OAuth
authorization (default). 
Fresh installation requires a **runtime automation token**, restricted
to the target account and zone: Account Email Sending Read, Workers Scripts
Edit, Turnstile Edit, and Zero Trust Edit; Zone Read, Email Routing Rules Edit, and Analytics
Read. This token is installed as encrypted Worker secrets on fresh installs and is required for application automation.

### Installer

<a href="https://installer.cf-newsletter.com/"><img src="https://deploy.workers.cloudflare.com/button" alt="Deploy cf-newsletter to Cloudflare"></a>

Enter the target account ID, domain and Cloudflare administrator email, then
follow the on-screen instructions.

After installation, open **Compute → Email Service → Email Sending**, onboard
the selected domain if necessary, and wait for DNS/DKIM to become active.

### Updates

Open **Settings -> Updates** in the console to check releases and review
changes. Updates are never installed automatically. **Update**
records a single-use update request and continues on the
[hosted installer](https://installer.cf-newsletter.com/), where you sign in to
Cloudflare as an Administrator or Super Administrator of this account. The
installer checks compatibility, asks for final confirmation and starts the update;
progress remains visible in the console. No API token is entered or
stored. A failed update is resumed the same way with **Resume with Cloudflare**.

The temporary OAuth credential is encrypted in the target account for the job,
expires no later than one hour, and is removed on completion or failure. It never
appears in Workflow parameters, logs or update history.

The hosted installer/updater can also be opened directly, including when the
console is unavailable. Existing installations need one hosted bootstrap update
to create the updater. Releases that use console OAuth updates require updater
engine 1.1.0, so consoles running older releases update once through the hosted
installer. That update
removes any previously saved update token from the updater Worker. Revoke such
tokens in the Cloudflare dashboard.

Back up D1 or verify a recovery point before updating. Routine updates preserve
bindings, resource IDs/locality, secrets, settings, routes, schedules and Queues.
Failures retain a deployment lock and per-Worker checkpoints; resume with
Cloudflare from the console or the hosted updater. Rolling back code does not restore D1
data. Legacy migrations, destructive schema changes and unsupported infrastructure
changes require explicit manual intervention.

See [the update operations guide](docs/updates.md).

## Documentation

- [`docs/help.md`](docs/help.md) — using the administration console.
- [`docs/attachments.md`](docs/attachments.md) — attachment handling and secure downloads.
- [`docs/tracking.md`](docs/tracking.md) — open and click tracking.
- [`docs/subscribe-unsubscribe.md`](docs/subscribe-unsubscribe.md) — signup and unsubscribe flows.
- [`docs/warmup.md`](docs/warmup.md) — sending warmup and limits.
- [`docs/retention.md`](docs/retention.md) — data retention and cleanup.
- [`docs/workers.md`](docs/workers.md) — component-level technical details.

For implementation and system design details, see [Architecture](docs/architecture.md).
