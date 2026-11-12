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

- a domain added as an active Cloudflare authoritative DNS zone (primary/full setup) without an existing email service/MX records;
- Workers, D1, R2 and Queues available;
- Email Sending and Email Routing available for the zone;
- Zero Trust Access available.

The installer asks for two API tokens restricted to the target account and zone:

- **Short-lived installation token:** Account Workers Scripts Edit, D1 Edit,
  Queues Edit, Workers R2 Storage Edit, Access Organizations/Identity
  Providers/Groups Edit, Access Apps and Policies Edit, and Zero Trust Edit;
  Zone Read, Workers Routes Edit, and, for fresh installations, Zone Settings
  Edit and Email Routing Rules Edit.
- **Runtime automation token:** Account Email Sending Read, Workers Scripts
  Read, and Zero Trust Edit; Zone Read, Email Routing Rules Edit, and Analytics
  Read. This token is installed as encrypted Worker secrets on fresh installs.

Revoke the short-lived installation token after use; keep the runtime token
active for application automation.

Note: no GitHub account or repository is required.

### Installer

<a href="https://installer.cf-newsletter.com/"><img src="https://deploy.workers.cloudflare.com/button" alt="Deploy cf-newsletter to Cloudflare"></a>

Enter the target account ID, domain and Cloudflare administrator email, then
follow the on-screen instructions.

After installation, open **Compute → Email Service → Email Sending**, onboard
the selected domain if necessary, and wait for DNS/DKIM to become active.

### Updates

Open **Settings -> Updates** in the console to check releases, review changes,
run preflight and approve an update. Updates are never installed automatically.
Enter a temporary Cloudflare token with **Workers Scripts Edit** on the target
account, or explicitly save a dedicated update token on the updater Worker.
Saving a token is optional; in-app updates are not. This permission can modify
other Workers in the same account.

Temporary update credentials are encrypted in the target account, expire after
one hour, and are removed on completion or failure. A cleanup schedule removes
expired credentials from abandoned jobs. Credentials never appear in Workflow
parameters, logs or update history. Revoke temporary tokens after use.

The [hosted installer/updater](https://installer.cf-newsletter.com/) remains a
supported alternative indefinitely, including when the console is unavailable.
Existing installations need one hosted bootstrap update to create the updater.
Hosted updates use a newly supplied installation token, not a saved update token;
existing runtime secrets and saved update credentials are preserved.

Back up D1 or verify a recovery point before updating. Routine updates preserve
bindings, resource IDs/locality, secrets, settings, routes, schedules and Queues.
Failures retain a deployment lock and per-Worker checkpoints; resume with a fresh
token from the console or hosted updater. Rolling back code does not restore D1
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
