# B008 production release: exact-version authority and effect boundaries

**Status:** Migration 293 and its UI/attester are a held preparatory slice. No
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
| Human decision | A Bot/service account, AAL1 session, non-admin, stale displayed card or changed artifact tries to approve. | 293 demands authenticated provisioned admin AAL2, locks the request, compares both expected hashes, requires fresh trusted proof, and appends the decision. The global Inbox re-reads the whole card before calling the owning RPC. Rejection and revocation require reasons. |
| Approval to merge | The PR head/base or GitHub checks advance after the person decides; an unrelated `gh pr merge` bypasses the Inbox; a previously green check remains green after the human revokes. | **Still open:** a trusted merger must re-run the verifier and latest decision immediately before the exact GitHub merge API call, compare head/base/plan, and fail on mismatch. Make its status mandatory in GitHub protection or merge queue **and** remove direct/bypass merge authority. A cached green status or CLI wrapper alone does not prevent a revoked-plan merge. |
| Merge to Railway | Railway deploys watched `main` before main CI or the release card is checked. | **Still open:** turn on a verified CI wait for both services and add a deploy-start exact approved-release/manifest check, or hold automatic deployment until a reviewed orchestrator deploys exact SHAs. A premerge approval alone does not prove the squash merge SHA or live service identity. |
| Main CI to Pages | A newer `main` arrives while an older successful `workflow_run` builds. | The existing `assert-current-deploy-sha.sh` checks tested SHA and current main before and after the live identity wait. Its test simulates `main` advancing and rejects the old run. A later Pages effect gate must also compare the exact approved release scope. |
| Runtime to browser pin | Railway deploys watched runtime source while the browser manifest pins an older runtime commit. | The existing live identity/source-tree gate rejects the browser build, as observed in Pages run 41015609250. After the final runtime merge is deployed and read back, a separate reviewed manifest-pin commit must name that exact full SHA; its own main CI and Pages gate then publish the browser. |
| Migration and switches | SQL file or production history differs, or a switch changes outside the approved plan. | **Still open:** read live migration history, verify each committed SQL digest and order, apply only the approved set, record actual history, and require a new approval for any changed switch. Keep all external marketing switches off until their separate class gates pass. |

## 293 implementation contract

1. A provisioned admin at AAL2 submits migration 288's immutable candidate
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

## Focused verification in this held patch

- PGlite: thirteen cases cover the held source, server-only proof, digest/PR/CI/SQL
  drift, AAL1/member/service rejection, direct canonical-RPC denial, exact
  admin approval, stale-proof revocation, reasoned rejection and preservation
  of 292's held organic package Inbox branch.
- Inbox UI: 34 cases cover global/card routing, AAL2 exact decision,
  changed-proof rejection on refresh, reasoned revocation after a proof
  becomes stale and the client Inbox's held-source default visibility.
- Attester and read-only premerge assertion: five tests cover exact binding,
  self-fetch/server-only submit, a GitHub head advance before any proof write,
  a changed base and human revocation during recheck.
- Existing Pages guard: `scripts/assert-current-deploy-sha.test.mjs`
  exercises a newer `main` arriving between tested SHA selection and the
  publication check. This is the same class of race observed in run 41014777972.
