# Application updates

In-app updates are the primary update path. A super admin opens Settings ->
Updates and reviews the published stable GitHub release. **Update** records a
single-use update intent and opens the hosted installer.
The operator authorizes the Cloudflare account through OAuth; the installer
verifies the intent, checks compatibility and asks for final approval before
submitting the durable job. Regular newsletter admins cannot request updates.
There are no unattended installations or customer-side builds.

## Update intents

The updater stores only the SHA-256 of a random 256-bit nonce in update_intents,
with the reviewed release ID and digest, the console administrator's Access
email and a 30-minute expiry. The nonce travels once, in the installer link
(`?update=`), which the installer removes from the address bar. A new request
supersedes unredeemed ones. For a failed job, the intent pins that job's
original release.

The hosted installer requests only update scopes for a console link. During the
OAuth callback, it reads the intent through the authorized account's D1: an
intent missing from that account, expired or redeemed is rejected, so the link is
bound to the account that created it. The release is pinned to the intent even
if a newer release is published. Deployment rechecks the intent and redeems it
atomically before starting the job, which records the console administrator as
its actor. The intent authorizes nothing without Cloudflare OAuth; anyone able to
write this D1 database can already deploy, so a separate signing key adds no
protection.

## Credentials

Only the updater Worker can decrypt job credentials. Its UPDATE_PRIVATE_KEY
secret corresponds to a public key in deployment_metadata. The hosted updater
encrypts the temporary OAuth credential without reading that private key.

Each job stores an RSA-OAEP-encrypted copy of its credential, bound to its job ID
and usable for at most one hour or the OAuth token lifetime. Completion/failure
clears it. A ten-minute cleanup schedule terminates expired jobs, removes
abandoned credentials and deletes expired intents. No plaintext credential is
placed in Workflow parameters, step results or history. There is no saved update
token: the hosted installer removes the legacy CF_UPDATE_TOKEN secret, which
older consoles could store, when it bootstraps the updater.

## Execution and recovery

Both entry points submit jobs to the same customer-owned Workflow and D1 lock.
The updater is private, with no public route, workers.dev endpoint or preview URL.
The console calls a named RPC entrypoint through a service binding.

Preflight inventories all six deployed Workers, their live bindings and active
version IDs. Routine deployments preserve existing settings and resource
locations rather than reconstructing them from default names. Pending additive
migrations run before code deployment, with recorded postcondition checks.
Workers deploy sequentially; admin and its static assets deploy last.
Installed version metadata changes only after all six active versions verify.
Cloudflare's deployments API can keep reporting a Worker's previous version for
a while after an upload, so since updater engine 1.1.2 each deploy waits (up to
about 20 seconds) for the uploaded version to become active before recording
it. If it is still not reported, the step fails without recording anything and
resuming adopts the uploaded version without uploading again. A job left by an
earlier engine that recorded the previous version as deployed (which failed
with "Verification failed for cf-newsletter-<worker>") resumes the same way,
provided the active version carries this release's APP_VERSION and APP_COMMIT.

Closing the browser does not cancel the job. Failed jobs retain their lock;
inspect the error, correct the cause and choose Resume with Cloudflare. A retry
reconciles live Worker versions before uploading again.
Do not start a separate manual deployment while a job owns the lock.

The hosted updater is permanently supported and does not depend on the console. Rerunning it with the same release reconnects to an active job
or resumes a failed one. Releases requiring a newer updater engine use the hosted
bootstrap path; the engine is not replaced during an active application update.

There is no cross-Worker/D1 transaction. Releases must tolerate mixed versions
during deployment and keep schema changes backward compatible. Code rollback
does not reverse migrations or restore database contents. Previous Worker version
IDs are retained in update_jobs.checkpoint for operator-controlled recovery via
Cloudflare's deployment controls. Never replay email sends as part of recovery.
Restoring D1 or reverting incompatible code requires a separate, explicitly
approved maintenance operation.

## Release contract

Public GitHub Releases contain the six prebuilt modules, SPA, migrations,
per-file SHA-256 checksums, and a separately versioned updater module. The outer
artifact digest is checked against GitHub metadata. Only stable releases are
offered in the production console; pushes to main do not trigger updates.

manifest.update declares minimum updater/app versions, additive migration mode,
the absence of infrastructure changes, compatibility date and flags. Unsupported
contracts and downgrades fail closed. The installer and app use the same
versioned update modules; installer maintainers synchronize them with
PRODUCT_ROOT=/path/to/app npm run sync:updates and verify with --check.

No GitHub account or token is required for customers. Release checks are cached
for six hours, with manual refresh limited to once per minute. GitHub failures
are reported as unavailable, never as "up to date".

Anonymous GitHub API calls are limited per IP address, and Workers share
Cloudflare's egress IPs, so an installation calling GitHub directly can get
HTTP 403 even when it rarely checks. Since updater engine 1.1.1, the updater
reads release metadata (the latest release and the release pinned by an update
job) from the hosted installer's `GET /api/releases/latest` and
`GET /api/releases/<id>`, which call GitHub with the installer's token and are
edge-cached for five minutes and one hour respectively. The installer only
relays metadata: the updater validates it exactly like a GitHub response,
requires the artifact URL to be the GitHub release download URL, downloads the
artifact from GitHub and checks it against the SHA-256 digest. If the installer
lookup fails, the updater falls back to anonymous GitHub, and the error shows
GitHub's message and rate-limit reset time. An optional read-only GITHUB_TOKEN
secret on the updater still makes it call GitHub directly with that token.
