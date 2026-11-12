# Application updates

In-app updates are the primary update path. A super admin opens Settings ->
Updates, reviews the published stable GitHub release, supplies a deployment token
if none is saved, runs preflight, confirms a database recovery point and approves
the deployment. Regular newsletter admins cannot check or start deployments.
There are no unattended installations or customer-side builds.

## Credentials

Only the updater Worker can decrypt job credentials. Its UPDATE_PRIVATE_KEY
secret corresponds to a public key in deployment_metadata. The hosted updater
can encrypt a temporary credential without reading that private key.

CF_UPDATE_TOKEN is an optional, reusable Worker secret. The console can save,
replace or remove it; no read-back endpoint exists. If a saved token is revoked,
enter a valid replacement to rotate/remove it. Removing it does not disable
in-app updates: enter a new temporary token each time instead.

Each job stores an RSA-OAEP-encrypted copy of its token, bound to its job ID and
usable for one hour. Completion/failure clears it. A ten-minute cleanup schedule
terminates expired jobs and removes abandoned credentials. Expired ciphertext may
remain until the next cleanup tick, but cannot be used by the update engine.
No plaintext token is placed in Workflow parameters, step results or history.
Cloudflare Workers Scripts Edit is account-scoped and powerful; restrict tokens
to the intended account and revoke temporary credentials after use.

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

Closing the browser does not cancel the job. Failed jobs retain their lock;
inspect the error, correct the cause and choose Resume from checkpoint with a
fresh token. A retry reconciles live Worker versions before uploading again.
Do not start a separate manual deployment while a job owns the lock.

The hosted updater is permanently supported and does not depend on the console
or a saved token. Rerunning it with the same release reconnects to an active job
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
are reported as unavailable, never as "up to date"; an optional read-only
GITHUB_TOKEN secret may be configured on the updater to mitigate shared-egress
rate limits.
