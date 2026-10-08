# Install and update on Cloudflare

Use the [hosted installer](https://cf-newsletter-installer.davideslab.eu/) for both fresh installations and updates. The product repository does not provide a standalone Wrangler deployment path. You do not need to generate `wrangler.toml` files or run deployment commands from this checkout.

## Fresh installation

Before starting, add your domain as an active Cloudflare authoritative DNS zone and ensure Workers, D1, R2, Queues, Email Routing, Email Sending, and Zero Trust are available in the target account. Open the hosted installer, enter the target account ID, domain, administrator email, and the requested API tokens, then complete preflight and installation. Check for the final **complete** message before revoking the short-lived installation token.

After installation, complete Email Sending onboarding and DKIM verification in the Cloudflare dashboard. Open `https://console.<your-domain>` through Cloudflare Access to manage newsletters and administrators.

## Updates

Open the same hosted installer and run preflight again with the target account and domain. It selects a published cf-newsletter release from GitHub, reuses existing resources and Worker secrets, applies pending D1 migrations, and deploys the new Worker bundles. Existing data is not reset. A change to `db/schema.sql` alone does not migrate an existing installation: the release must include the corresponding migration.

The installer does not back up resources or roll back a partially completed update. Check for the final **complete** message and inspect any reported failure before retrying. A product update becomes available when a new GitHub Release is published; pushing a source change alone does not update an installation.
