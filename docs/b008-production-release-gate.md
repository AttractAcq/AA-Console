# B008 production release: exact-version authority and effect boundaries

**Status:** Migrations 293, 295 and 297 and their UI/attester/merger source are held preparatory slices. No
production SQL, merge gate, Railway deployment gate, Pages approval gate or
external switch is enabled by this document or this patch. Class 32 stays
blocked until those independent effect gates and a live release pilot pass.

## Current observed deployment topology

`agent-runtime` and `aa-mcp-gateway` watch their respective paths on GitHub
`main`. Railway automatic deployment is enabled and **Wait for CI is off**.
Thus a watched merge can deploy a new service before the merge commit's own CI
finishes. GitHub Pages uses `workflow_run` for successful `main` CI, pins the
tested SHA, and rechecks current `main` before publication. The #276 runtime
commit `539e19ee37f1310bb5ce96bc751cd3ffe16ad8a5` was observed deployed
before its main CI finished. Its later eligible Pages run
[`41014777972`](https://github.com/AttractAcq/AA-Console/actions/runs/41014777972)
failed at the current-main recheck after #279 advanced main. That failure is
the intended stale publication guard; it does not retroactively gate Railway.
The #279 main CI passed all four jobs, but its eligible Pages run
[`41015609250`](https://github.com/AttractAcq/AA-Console/actions/runs/41015609250)
failed the live identity gate because the browser manifest still pinned the
older `b9b4a3b3b02624218a834505ece2a4e412c36979` runtime source while
#276's `539e19ee37f1310bb5ce96bc751cd3ffe16ad8a5` runtime source had
deployed. This is another intended red gate: a later reviewed manifest-pin
commit is required after the new runtime SHA is observed. A second runtime
change before that pin requires the final observed runtime SHA, not the first.

## Trust and attack model

| Boundary | Attacker or race | Required behavior |
| --- | --- | --- |
| Browser to candidate source | A person or Bot supplies four green job names, migration hashes or deployment SHAs without independent proof. | Migration 288 keeps the source `source_held`; caller claims never clear the blocker. |
| Trusted attester to Supabase | A browser tries the proof RPC, a service caller sends a packet for another PR, a changed commit, a different CI run or different SQL bytes. | 293 grants proof submission only to `service_role`, repeats the packet digest and exact candidate binding in SQL, and records append-only evidence. The server process invokes the read-only GitHub verifier itself; it never accepts browser proof JSON. Service-role key custody is a required infrastructure control. |
| Human decision | A Bot/service account, AAL1 session, non-admin, stale displayed card or changed artifact tries to approve. A new proof arrives after the browser's last read but before its decision RPC. | 293 demands authenticated provisioned admin AAL2, locks the request, compares both expected source hashes, requires fresh trusted proof, and appends the decision. The global Inbox re-reads the whole card before calling the owning RPC. 295 additionally requires the exact displayed GitHub packet SHA-256 under the same request lock, so the bound proof is the one the human saw. Rejection and revocation require reasons. |
| Approved proof freshness | The 15-minute GitHub attestation expires while CI or review progresses; the approved card becomes held even when every approved byte is unchanged. A service caller tries to refresh with a different packet after the human decides. | 295 binds the original packet digest and proof ID to the AAL2 decision in an append-only table. Its server-only refresh RPC accepts only the identical JSON packet after fresh independent GitHub verification. It locks the request, requires the same latest decision, exact source, original proof and digest, and rejects revocation or expiry. The trusted check refreshes before its read-only assertion. |
| Approval to merge | The PR head/base or GitHub checks advance after the person decides; an unrelated `gh pr merge` bypasses the Inbox; a previously green check remains green after the human revokes. | Held 297 adds a database lease that serializes a final AAL2 decision read with revocation and a merger that repeats canonical/GitHub reads before dispatch. **Still open:** install a sole trusted merger identity, make its check mandatory, remove independent direct/bypass merge authority and run a live adverse-case pilot. |
| Merge to Railway | Railway deploys watched `main` before main CI or the release card is checked. | **Still open:** turn on a verified CI wait for both services and add a deploy-start exact approved-release/manifest check, or hold automatic deployment until a reviewed orchestrator deploys exact SHAs. A premerge approval alone does not prove the squash merge SHA or live service identity. |
| Main CI to Pages | A newer `main` arrives while an older successful `workflow_run` builds. | The existing `assert-current-deploy-sha.sh` checks tested SHA and current main before and after the live identity wait. Its test simulates `main` advancing and rejects the old run. A later Pages effect gate must also compare the exact approved release scope. |
| Runtime to browser pin | Railway deploys watched runtime source while the browser manifest pins an older runtime commit. | The existing live identity/source-tree gate rejects the browser build, as observed in Pages run 41015609250. After the final runtime merge is deployed and read back, a separate reviewed manifest-pin commit must name that exact full SHA; its own main CI and Pages gate then publish the browser. |
| Migration and switches | SQL file or production history differs, or a switch changes outside the approved plan. | **Still open:** read live migration history, verify each committed SQL digest and order, apply only the approved set, record actual history, and require a new approval for any changed switch. Keep all external marketing switches off until their separate class gates pass. |

## 293 implementation contract

1. A provisioned admin at AAL2 submits migration 291's immutable candidate
   into the **global** Approval Inbox. Its initial status is `source_held`.
2. A server operator runs `scripts/production-release-attestation.mjs` with
   the Inbox request UUID. The script reads that source with a server-only
   Supabase credential, invokes `verifyGithubReleaseCandidate` directly,
   compares exact PR/base/head, all four protected jobs from one successful
   run, released marker and pending committed SQL digests, then sends that
   verifier packet to the 293 RPC. It does not call a merge or deploy API.
3. `record_trusted_production_release_attestation_v6` rechecks the source,
   packet SHA-256, GitHub PR/CI and SQL fields, and appends the packet. No
   browser or Bot has an execute grant. An attestation is decision-ready for
   15 minutes; a renewed verifier run appends a new observation.
4. The Inbox shows the source candidate **and** independently verified GitHub
   packet in one preview. An admin AAL2 decision calls
   `decide_production_release_candidate_v6` with the exact source and artifact
   hashes. The decision becomes part of the canonical append-only history.
   This is approval of the exact **plan**, not proof of a completed release.
5. The class-32 coverage feed remains blocked: the source/decision slice still
   lacks a live AAL2 pilot, and the merge, production SQL, Railway and Pages
   effect gates remain absent.
6. `scripts/verify-approved-production-release.mjs` is a **read-only**
   premerge assertion. It re-reads the canonical approved card and latest AAL2
   decision, checks the fresh attestation, re-runs GitHub verification, compares
   the exact packet digest and re-reads the card for revocation. Until GitHub
   branch protection requires this result, running the script is advisory and
   does not close the merge effect gate.
7. Migration 295 replaces the decision RPC with a version that accepts the
   displayed GitHub packet SHA-256 and compares it under the request lock.
   It binds approval to the precise attestation that existed when the human
   decided. The trusted server may re-run GitHub verification and
   append a fresh attestation for that **identical packet** while the source
   remains unexpired and the bound AAL2 decision is latest. A changed PR, CI
   run, workflow digest, SQL file, packet field, candidate, or decision fails
   closed. No second human decision is needed for unchanged approved bytes;
   any change requires a new candidate and Inbox decision.

## Held 297 exact merge lease and source contract

The `production_release_merge_leases_v6` table and append-only event ledger
record one active, dispatched or completed attempt per approved Inbox request.
An aborted **pre-dispatch** attempt may be retried only after the canonical
approval, proof and GitHub plan are independently checked again. The lease RPC
takes the same approval-request row lock as the human decision RPC. If a
revocation wins that lock, lease acquisition fails. If acquisition wins, the
decision trigger refuses revocation while the lease is active or dispatched.
This closes the decision-read-to-merge race at the database boundary without
letting a service role or agent create an AAL2 human decision.

`scripts/trusted-production-release-merger.mjs` is **held source with no CLI,
workflow caller or installed credential**. It refreshes only the identical
human-bound GitHub packet, reads the latest canonical card/decision and exact
plan, checks current GitHub main and the open PR, requires strict branch
protection and a sole reviewed merger restriction, verifies all four CI jobs
plus `Approved production release (trusted)` as successful exact-head checks
from their pinned GitHub Actions app, and verifies the trusted check's workflow
run path, protected base SHA and single exact PR/head/base association. A
missing workflow-run PR association fails closed; GitHub may leave this array
empty for some event topologies, so the live `pull_request_target` pilot must
establish that these facts are available before activation. It then acquires
the lease, repeats the canonical/GitHub checks, and
calls the dispatch RPC. The future merge call supplies the exact PR head SHA
and approved merge method. It accepts a completed receipt only after a fresh
read of the merged PR and evidence that the reported commit is still an
ancestor of `main`. [GitHub documents the merge API's exact-head `sha`
precondition](https://docs.github.com/en/rest/pulls/pulls?apiVersion=2022-11-28#merge-a-pull-request)
and [strict required status checks](https://docs.github.com/en/rest/branches/branch-protection?apiVersion=2022-11-28#update-status-check-protection).

If dispatch or the GitHub merge response is ambiguous, the lease stays
unresolved. The process never retries the merge or automatically clears a
dispatched lease. This can temporarily block revocation; the Approval Inbox
must show that pending outcome before a live pilot. The
297 database RPC records a claimed observed merge SHA, so its production
credential must be held only by the reviewed merger process; a general
service-role key shared with other runtimes is insufficient custody.

### Manual dispatched-lease reconciliation (exception runbook)

1. Stop the merger runner for this request and **do not retry the GitHub
   merge call**. Record request UUID, lease UUID, exact PR/head/base/packet,
   dispatch timestamp, the HTTP outcome or timeout, and the latest canonical
   Inbox decision. If the lease is still `active` and the process has not
   called dispatch, the trusted runner may use its pre-dispatch abort RPC.
2. Wait at least five minutes from `dispatched_at`. Read the GitHub PR, its
   merge status and merge commit, current `main` ref and ancestry, check runs,
   and the repository audit log twice at different times. Save both raw
   first-party observations with timestamps in a controlled evidence file;
   record its SHA-256 and the reviewers' names. An open PR alone is not proof
   if an asynchronous or queued merge may still be pending.
3. If the PR is merged, verify the merge commit against the exact approved
   head and `main` ancestry, then let the trusted merger record `completed`
   with that full observed SHA. If the effect is still uncertain, leave the
   lease `dispatched`, keep revocation blocked, and escalate to Alex; never
   invent a negative outcome.
4. Only if the saved evidence proves **no merge occurred and none is pending**,
   a database owner (`postgres`) invokes
   `reconcile_unmerged_production_release_merge_lease_v6(lease_uuid,
   evidence_sha256, reason)` through a reviewed SQL session. The function
   requires an aged dispatch, writes the digest and reason into both lease
   and append-only event ledger, and has no app, browser or `service_role`
   execute grant. The operator then re-reads the ledger and the Inbox; a
   provisioned human AAL2 admin may revoke the approved plan if needed.

**Q020 / activation blocker:** Alex must approve a dedicated merger identity,
separate read-only GitHub verifier and write-capable merger tokens, and
server-only Supabase credential custody; ensure GitHub protection allows
only that identity to change `main` with no bypass, make the trusted check
mandatory with an exact GitHub Actions app binding, and prove a
`pull_request_target` job is attached to the *PR head* before this verifier can
accept it. A base-commit-only check is rejected. The new merger file is not
yet part of the 293 verifier's protected gate-code path list; adding it there
needs a separately reviewed trust-root bootstrap because ordinary candidates
cannot change the verifier itself. None of these settings are changed by 297.

The final distributed window remains between the last GitHub read, the
database dispatch and GitHub's merge API. The exact-head `sha` precondition
and strict up-to-date protection are required interlocks; the database lease
holds revocation throughout. Protection or administrator policy could still
be changed outside this process, and Railway currently watches `main` with
Wait for CI off. Class 32 therefore stays blocked until the sole-identity
policy, Railway/SQL/Pages effect gates, and live race/failure pilot are proven.

## Required next effect gates, in order

1. Keep the read-only verifier bootstrap from merged #279. Integrate 291 and
   292 before 293; replay the complete schema and regenerate types/manifest
   from that ancestry. #279's failed Pages run is an expected held release
   receipt, so browser publication requires the later observed runtime pin.
2. Build the trusted premerge decision check and merger without executing PR code in a
   secret-bearing context. It must read the latest canonical decision, fresh
   attestation and candidate, re-run GitHub verification at the moment of
   merge, and reject head/base, CI, workflow bytes, migration and plan drift.
   Configure its check as mandatory in GitHub branch protection or the merge
   queue; verify no admin bypass or independent direct merge route. A green
   status obtained before a revocation must not be usable for the merge. A
   changed head/base creates a new candidate and human decision.
3. Resolve Railway's early deploy window: verify `Wait for CI` semantics and
   turn it on for both watched services, or disable watched-main deployment
   and let a gated orchestrator deploy the approved exact merge SHA. Prove a
   deliberately failed main CI does **not** advance a live service. The
   service startup/readiness path must fail closed for unapproved or mismatched
   SHA/manifest and preserve the prior healthy version.
4. Gate production SQL application on the approved file list and SHA-256,
   dry-run the exact migrations, verify the live current head and ordering,
   then append an observed result. Never infer applied history from the
   committed released marker alone.
5. Gate Pages after main CI with a live runtime/gateway/schema identity match,
   an exact approved scope check, and current-main checks immediately before
   publication. The #276/#279 race must remain red for the older run. The
   #279 stale-runtime-pin failure must remain red until a reviewed follow-up
   manifest commit names the **observed final** runtime SHA (including any
   intervening #280 runtime change). That follow-up itself needs current-main
   CI and live identities before browser publication.
6. Append actual merge, migration, Railway and Pages receipts to the same
   release card/deployment inventory. Perform a controlled live pilot with
   rejection, revocation, stale head, failed CI, changed SQL, missed Railway
   health check and newer-main Pages race. Only then mark class 32 operational.

## Held trusted default-branch check (next source slice)

The held `Production release approval` workflow runs on `pull_request_target`
for PRs into `main`. Its single job has no skip condition. It checks out the
protected base commit named by the event, fetches the PR head as Git **object
data**, and runs only base-branch JavaScript. The script accepts one
`AA-Release-Request: UUID` line in the PR body as a locator. That line is
untrusted: the server-side assertion independently reads the canonical Inbox
card, its latest AAL2 human decision, its fresh trusted attestation, GitHub's
current PR/base/head and four CI jobs, the committed SQL bytes, and a second
card **and decision** observation. It compares the result to the event PR and
base/head before returning green. Before that assertion, the trusted server
re-verifies GitHub and invokes 295's refresh RPC for the same bound packet;
the refresh appends only internal proof evidence and is idempotent for a recent
identical proof. The trusted checkout mode requires checked out `HEAD` to equal
the exact GitHub PR base commit. It never checks out or executes the PR head
in the job with the server credential.

The first installation of this workflow is a bootstrap exception: a base
without the file cannot compare its bytes. Once the file exists on the base,
the GitHub verifier rejects PRs that edit or remove it **or its trusted
execution scripts**, just as it rejects changes to `ci.yml`. A later gate
upgrade therefore needs a separately reviewed bootstrap procedure and new
approval; it cannot ride inside an ordinary release candidate. The first
bootstrap must receive ordinary protected CI and human code review. A PR body
edit or an explicit rerun of the failed job can refresh the proof and check
after the AAL2 Inbox decision. If the approved packet is unchanged, the
15-minute attestation window is renewed without another human decision. A
green result is still only a snapshot.

**Activation remains held.** The current main protection requires the four
CI jobs with `strict: true` and `enforce_admins: true`, but does not require
`Approved production release (trusted)`. The repository's Actions secrets
currently contain only the public browser build settings; there is no
`AA_RELEASE_SUPABASE_SERVICE_ROLE_KEY`. Before making the check mandatory,
review custody and scope for that server credential (prefer a dedicated
release verifier identity limited to the proof-refresh RPC and reads), confirm GitHub's `pull_request_target`
event policy permits this trusted workflow, install the credential, test a
red stale/revoked candidate and a green exact candidate, then require the
check from the GitHub Actions app without a bypass route. No environment
secret, protection setting or production SQL is changed by this held source
slice.

**A required green status does not close the release effect gate.** The
human can revoke after the workflow's last read. GitHub can then merge a
cached green PR unless a trusted merger re-reads the latest decision
immediately before the merge API call, binds the expected head SHA, and
requires the approved base/plan. Even that read has a small distributed
race until the release decision is leased or locked through the effect.
Railway still watches `main` with Wait for CI off, so a merge can deploy
before the new main CI or any Pages `workflow_run` gate. No class-32 pass is
claimed until the trusted merger, production SQL gate, Railway deploy gate,
Pages gate and live adverse-case pilot are complete.

## Focused verification in this held patch

- PGlite: migration 296 cases cover the held source, server-only proof,
  digest/PR/CI/SQL drift, AAL1/member/service rejection, exact admin approval,
  stale-proof revocation, reasoned rejection and preservation of 292's held
  organic package Inbox branch. Migration 295 cases cover an unchanged packet
  refreshing after stale proof, idempotent repeat, changed packet rejection,
  service-only execution, revocation rejection and a new proof arriving after
  the Inbox read but before the human decision RPC.
- Inbox UI: 34 cases cover global/card routing, AAL2 exact decision,
  changed-proof rejection on refresh, reasoned revocation after a proof
  becomes stale and the client Inbox's held-source default visibility.
- Attester and trusted premerge assertion: tests cover server-side GitHub
  fetch and exact event binding before a proof write, the approved proof
  refresh path, a changed base, a mismatched human decision binding, and
  revocation during final recheck.
- Existing Pages guard: `scripts/assert-current-deploy-sha.test.mjs`
  exercises a newer `main` arriving between tested SHA selection and the
  publication check. This is the same class of race observed in run 41014777972.

---

*Migration numbers in this document refer to the released labels. The nineteen migrations integrated by #297 were renumbered from their original 280–298 to 283–301; references here were corrected on 1 November 2026. See `V6_MERGE_ARCHIVE_RECORD.md`.*
