# Newsletter Distribution on Cloudflare

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

- a domain added as an active Cloudflare authoritative DNS zone (primary/full setup);
- Workers, D1, R2 and Queues available;
- Email Sending and Email Routing available for the zone;
- Zero Trust Access available.

The installer asks for a short-lived API token with these permissions:

- **Account:** Workers Scripts Edit, D1 Edit, Queues Edit, Workers R2
  Storage Edit, Access Organizations/Identity Providers/Groups Edit, Access
  Apps and Policies Edit, Zero Trust Edit and Email Sending Read;
- **Zone:** Zone Read, Zone Settings Edit, Workers Routes Edit, Email Routing
  Rules Edit and Analytics Read.

Restrict the token to the target account and zone, and revoke it after use.

Note: no GitHub account or repository is required.

### Installer

<a href="https://cf-newsletter-installer.davideslab.eu/"><img src="https://deploy.workers.cloudflare.com/button" alt="Deploy cf-newsletter to Cloudflare"></a>

Enter the target account ID, domain and Cloudflare administrator email, then
follow the on-screen instructions.

After installation, open **Compute → Email Service → Email Sending**, onboard
the selected domain if necessary, and wait for DNS/DKIM to become active.

### Updates

To install a newer release, open the same hosted installer and follow the
on-screen instructions. Existing data and configuration are preserved.

## Documentation

- [`docs/deploy.md`](docs/deploy.md) — hosted installation and updates.
- [`docs/help.md`](docs/help.md) — using the administration console.
- [`docs/attachments.md`](docs/attachments.md) — attachment handling and secure downloads.
- [`docs/tracking.md`](docs/tracking.md) — open and click tracking.
- [`docs/subscribe-unsubscribe.md`](docs/subscribe-unsubscribe.md) — signup and unsubscribe flows.
- [`docs/warmup.md`](docs/warmup.md) — sending warmup and limits.
- [`docs/retention.md`](docs/retention.md) — data retention and cleanup.
- [`docs/workers.md`](docs/workers.md) — component-level technical details.

For implementation and system design details, see [Architecture](architecture.md).
