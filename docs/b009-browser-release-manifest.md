# B009 browser release component pins

GitHub Pages publishes the CI-tested browser commit only after its current-main
check, released-schema marker check, and live component identity check. The
source manifest is `supabase/verification/browser-release-components.json`:

```json
{
  "schemaVersion": 1,
  "runtimeSha": "<full deployed runtime commit>",
  "gatewaySha": "<full deployed gateway commit>",
  "migrationHead": "<14-digit released production migration version>"
}
```

The manifest's SHA fields are **exact deployment pins**, not minimum version
numbers. They can differ from the browser commit when Railway watched paths
correctly skip an unchanged service. The Pages job verifies both pins are
ancestors of its CI-tested main commit and that the tracked service source
has not changed between each pin and that commit. It then requests
the dedicated authenticated
`GET https://runtime.attractacq.com/release/identities/fresh` route with a
bounded twelve-second deadline per attempt,
requires a fresh complete observation, and compares the runtime SHA, gateway
SHA and migration head with the manifest. A 503, timeout, changed source,
stale response, or mismatch stops publication. The browser SHA is the exact
successful main CI SHA passed by GitHub's `workflow_run` event.
The dedicated 32-byte token is supplied only to the live identity step as a
GitHub Actions secret; it is never present in PR CI, the browser build or
the Pages artifact. The runtime bypasses its public ten-second cache for
this authenticated route and rereads the database and gateway on each call.

## Updating a pin after a service change

1. Merge the service change through the protected four-job CI gate. Its Pages
   run must stop while the old pin no longer matches the service source. This
   is the expected state, not a reason to bypass the live check.
2. Wait for the Railway service deployment and read its full SHA from the
   authenticated deployment record and the live identity probe. Read the
   production migration head separately through the read-only catalog.
3. Review compatibility of that service version with the current browser and
   released schema. Update only the relevant exact pin and, if a migration
   was actually applied, the released marker and manifest migration head.
   Record the release candidate, switches and rollback action in the unified
   Approval Inbox when its release class is operational.
4. Merge the manifest update after four protected CI jobs. Its own main CI
   triggers a new Pages job, which performs the full live comparison and
   publishes that CI-tested browser commit if all checks still hold. Fetch
   the public bundle and verify its embedded full build SHA afterward.

The manifest describes compatible **code and schema identity**, not the
result of an authenticated feature smoke test or permission to send, publish,
spend or deploy a customer-facing change. Those acceptance and exact-version
human approval requirements remain separate B008/B009 work. A failed Pages
gate leaves the previous site available; do not alter the marker solely to
make a red gate green. Preserve action ledger and external IDs during any
runtime rollback.

The runtime currently caches its gateway and schema observation for up to ten
seconds. A gateway rollback or schema change immediately after that cache fill
can make a recent `/release/identities` response briefly reflect the previous
state. This guard therefore does not establish an atomic deployment snapshot.
B009 remains open until the pre-publication observation can be forced fresh or
corroborated independently and an authenticated compatibility smoke test is
recorded. A later live change can also occur after any pre-publication check;
rollback monitoring must detect and reconcile that state.
