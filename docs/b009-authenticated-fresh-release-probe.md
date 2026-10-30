# B009: authenticated fresh release observation

## Scope and current release state

This change prepares `GET /release/identities/fresh` on the Railway runtime.
It uses the same bounded, read-only database catalog and authenticated gateway
read as the public `/release/identities` route, but calls `collectReleaseProbe`
on every authorized request. It never uses the public route's ten-second
cache. The public route remains available to operators and retains its cache.

This is a preparatory release slice. A missing `BROWSER_RELEASE_PROBE_TOKEN`
returns HTTP 503 from the fresh route, and the Pages identity step fails
before publication. This PR updates that step and its script, but does not
provision a production token, change a secret value, or claim a live probe.
It does not mark B009 complete or authorize a customer-facing release.

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

Release this in order after independent review of the exact candidate:

1. Provision one reviewed dedicated token in Railway and the GitHub Actions
   secret store. Check the existing public probe and workers after the
   config-only Railway redeploy of the older runtime; the new route is not
   present yet. Do not disclose the token in a release packet.
2. Merge this PR only after four fresh protected checks. Railway must deploy
   the new runtime code and its token; verify health and send a private
   authenticated fresh read. Compare its full runtime and gateway SHAs and
   live migration head with independent deployment and database reads. The
   Pages run for this merge is expected to withhold publication: its current
   manifest pins the older runtime source, and the runtime source changed.
   If configuration is absent or malformed, keep Pages blocked and repair the
   configuration without bypassing the gate.
3. Open a separate reviewed manifest update pinning the exact full runtime
   SHA actually deployed from step 2. After its four protected checks and
   merge, the Pages job receives the secret only in its live identity step,
   calls `/release/identities/fresh`, requires literal HTTP 200 and complete
   exact identities, and rechecks current main before publication. The
   runtime's sequential catalog, gateway fetch and gateway body deadlines can
   total nine seconds; the script uses one bounded twelve-second deadline
   per attempt, with a healthy six-to-nine-second response test. Keep the
   token out of the build, npm tests, artifacts, logs and `VITE_*` variables.
4. Exercise invalid/missing token, 401/503, old runtime, old gateway, pending
   migration, endpoint timeout and a component change during the bounded
   wait. Confirm each blocks Pages. Then observe a successful CI-tested SHA
   on the deployed browser bundle.

The protected Pages job does not need a Supabase Management API token. Such a
token would grant database management power to a privileged workflow merely
to read a migration head; the runtime already performs that read with its
server-only service credential. The source manifest and live identities
prove component versions only. B009 also requires its authenticated feature
smoke and the exact-version human Approval Inbox production-release decision.
