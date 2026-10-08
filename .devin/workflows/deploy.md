---
description: Install or update cf-newsletter using the hosted installer
---

Use the [hosted installer](https://cf-newsletter-installer.davideslab.eu/) for both installation and updates. Follow the prerequisites and steps in `docs/deploy.md`. Do not deploy the product Workers from this checkout with Wrangler or create local `wrangler.toml` files.

For updates, run preflight in the hosted installer and check for a final **complete** message. The installer reuses existing resources, applies release migrations, and deploys the release's Workers. Review errors before retrying; updates are not atomic.
