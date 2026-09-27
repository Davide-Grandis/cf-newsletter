#!/usr/bin/env bash
#
# Deploy the admin worker (cf-newsletter Admin Console).
#
# Builds the React SPA into workers/admin/public, then deploys the admin
# worker. The worker is served on its custom hostname (configured in
# workers/admin/wrangler.toml) and gated by Cloudflare Access.
#
# After a successful deploy it commits any pending changes and pushes to
# GitHub (origin). Pass a commit message as the first argument; otherwise a
# timestamped default is used.
#
# Usage:
#   ./scripts/deploy-admin.sh
#   ./scripts/deploy-admin.sh "tweak dashboard cards"
#
# Requirements:
#   - wrangler authenticated (npx wrangler login)
#   - web/ dependencies installed (cd web && npm install)
#   - git remote 'origin' configured

set -euo pipefail

# Deployment is locked by scripts/deploy.mjs to davideg-individual-account.

# Resolve repo root from this script's location so it works from any cwd.
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

echo "==> Verifying account and deploying admin worker"
npm run deploy:admin

echo "==> Pushing to GitHub"
if [[ -n "$(git status --porcelain)" ]]; then
  MSG="${1:-deploy admin worker ($(date -u '+%Y-%m-%d %H:%M UTC'))}"
  git add -A
  git commit -m "$MSG"
else
  echo "    No changes to commit."
fi
git push origin HEAD

echo "==> Done."
