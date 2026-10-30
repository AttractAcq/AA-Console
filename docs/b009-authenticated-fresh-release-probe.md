# B009: authenticated fresh release observation

## Scope and current release state

This change prepares `GET /release/identities/fresh` on the Railway runtime.
It uses the same bounded, read-only database catalog and authenticated gateway
read as the public `/release/identities` route, but calls `collectReleaseProbe`
on every authorized request. It never uses the public route's ten-second
cache. The public route remains available to operators and retains its cache.

This is a preparatory release slice. A missing `BROWSER_RELEASE_PROBE_TOKEN`
returns HTTP 503 from the fresh route. No production token, GitHub Actions
secret, workflow edit, or live probe is included in this PR. It does not mark
B009 complete or authorize a customer-facing release.

## Credential and rollout contract

`BROWSER_RELEASE_PROBE_TOKEN` must be a separate 32-byte random value encoded
as exactly 64 lowercase hexadecimal characters. Generate it in a secure
terminal with `openssl rand -hex 32`; do not put its value in Git, a PR,
build output, browser variable, issue, or release receipt. It must be stored
only as a Railway runtime variable and a GitHub Actions repository secret of
the same name. Do not reuse the MCP service secret, runtime `/status` secret,
Supabase service role key, or Supabase Management API token.

The route requires `Authorization: Bearer <token>` with that exact format.
Missing or malformed configuration fails closed, and invalid calls return
HTTP 401 without making a database or gateway request. Non-GET calls return
405. A successful fresh read returns the existing release identity JSON with
HTTP 200; an unavailable dependency returns 503. All responses use
`Cache-Control: no-store`. No credential or dependency error text is returned.

Release this in order:

1. Merge and deploy this runtime code through four fresh protected checks.
   With the token absent, verify the service stays healthy, the public probe
   works, and the fresh route returns 503 without an internal read.
2. Provision the dedicated token in Railway and in the GitHub Actions secret
   store through the reviewed production configuration path. Verify the
   Railway deployment is active. Send one authenticated read from a private
   operator environment; compare its full runtime and gateway SHAs and live
   migration head with independent deployment and database reads. Never print
   the token or response headers that contain it.
3. After the browser manifest/Pages gate PR has merged, update the Pages
   identity step to pass `BROWSER_RELEASE_PROBE_TOKEN` only to that step and
   use `/release/identities/fresh` with an Authorization header. The runtime's
   sequential catalog, gateway fetch and gateway body deadlines can total
   nine seconds, so give the Pages HTTP request a bounded deadline of at
   least twelve seconds and test a healthy six-to-nine-second response.
   Require a nonempty, exact-format token before calling `fetch`; require literal HTTP
   200, fresh complete JSON, exact manifest identities, and a current-main
   recheck immediately before Pages publication. Keep the token out of the
   build, npm tests, artifacts, logs, and `VITE_*` environment variables.
4. Exercise invalid/missing token, 401/503, old runtime, old gateway, pending
   migration, endpoint timeout, and a component that changes during the
   bounded wait. Confirm each blocks Pages. Then observe a successful
   CI-tested SHA on the deployed browser bundle.

The protected Pages job does not need a Supabase Management API token. Such a
token would grant database management power to a privileged workflow merely
to read a migration head; the runtime already performs that read with its
server-only service credential. The source manifest and live identities
prove component versions only. B009 also requires its authenticated feature
smoke and the exact-version human Approval Inbox production-release decision.
