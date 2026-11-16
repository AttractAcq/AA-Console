# Client delivery Phase 9 acceptance and release record

**Status:** prepared for review, not executed on a live client. **Candidate:** draft PR #356, branch `feat/client-delivery-phases3-9`; record the exact head SHA at release. This record follows the [build plan](client-delivery-build-plan-2026-11-14.md) and `AGENTS.md`.

## Evidence rules

Record the test client, operator, time, application SHA, runtime SHA, database migration head, exact approved version, external account and receipt ID for each journey. A queue entry, approval, export, attempted send, provider acknowledgement, read-back, lead and cash outcome are separate observations. Use `unknown` for a missing source or metric. Keep private customer details and credential values out of this record.

| Gate | Evidence to attach | Current status |
| --- | --- | --- |
| Schema | Clean upgrade replay, schema parity, migration list and generated types | Full-head disposable start and Phase 8 fixtures passed; local CLI reset health failure leaves upgrade equivalence open |
| Application | Frontend/runtime build and focused page tests at candidate SHA | Passed locally through `1fb71ef` |
| Organic journey | Approved exact asset and slot, provider publish receipt and read-back, captured lead with consent, sale and cash | Needs authorized test client and live provider run |
| Paid operator journey | Approved bundle hash, downloaded bytes, named handoff, external campaign/ad IDs, account read-back and metrics, lead and outcome | Needs authorized operator and live account run |
| Archive | Each domain archived and restored, historical attribution preserved, rejection reason retained | Six record domains passed disposable rollback fixture; live retrieval check open |
| Release identity | Deployed frontend/runtime/gateway SHA and database migration head | Pending Alex via Chief of Staff |

## Journey A — organic and proof

1. Record test client, approved market opportunity, approved offer version, commercial campaign and organic route package version. Check sourced intelligence and proof rights at the version used.
2. Produce and approve exact content and any proof artifact. Verify the campaign manifest binds the intended asset, page, agent and magnet versions. Revoke or edit one preapproved version in a separate negative test; publication must remain held.
3. Enable only the scoped client and global switches required for the test. Schedule into an approved Engine slot. Confirm approval request, AAL2 decision where required, preflight and provider attempt are individually recorded.
4. Capture the provider post ID, URL/time and read-back from the connected account. A calendar row alone does not pass this gate. Verify one supported proof placement with rights, destination and placement receipt; record unsupported destinations as blocked.
5. Submit a consented test lead through the published page and enabled sales agent. Verify one intake record, source references, consent wording, campaign link and non-probe status. Record conversation, appointment, sale and collected cash through Sales OS. Check Attribution shows that recorded path and coverage without inventing missing route or provider evidence.
6. Archive and restore a finished source record. Check the journey remains visible in historical reporting with the same IDs and review reason.

## Journey B — paid operator

1. Bind the approved opportunity and offer version to a paid route package. Review the exact plan, creative, copy, targeting, page, tracking and budget instruction.
2. Approve the operator bundle and compare downloaded bytes/hash with the reviewed version. Record named operator, handoff time and destination; a bundle export is not ad activation.
3. The human operator records actual Meta or Google campaign/ad IDs and activation state. Read the same IDs and metrics back from the connected account. Reconcile spend currency, date range and freshness before showing cost or return ratios.
4. Submit a test lead through the paid page or capture endpoint. Record click/UTM/source where available, consent, appointment, sale and cash. Mark exact route-package identity unknown if the capture did not record it; campaign mode alone is insufficient.

## Failure and permission checks

| Case | Required result |
| --- | --- |
| Invalid/expired credential or wrong provider account | Preflight blocks; no success receipt or false “connected” state |
| Stale exact-version approval | Action remains held; a new review is required |
| Revoked/expired proof right | Proof placement remains held and history remains readable |
| Duplicate execution or callback | One external effect and one reconciled receipt, or an explicit unresolved state |
| Failed media generation or publish | Visible failure, retry path and no “published” claim |
| Missing provider/site metric | `unknown` or incomplete coverage, never an observed zero |
| Cross-client role or missing AAL2 | Read/action denied with no other-client data or external effect |

## Release sequence and stop conditions

Alex via Chief of Staff reviews the PR and executes merge, production migrations and Railway deployment under `AGENTS.md`. Before each step, record the source and target SHA, migration list, backup/recovery state, owner and time. Keep outward switches off until provider preflight and approval gates pass. After deployment, verify frontend/runtime/gateway identity, migration head, inbox blockers, error queues, provider read-back and both journeys again. Stop release if a required approval class, credential scope, route receipt, cross-client boundary or migration parity check fails. Reverting a frontend/runtime SHA does not reverse additive database migrations; assess data compatibility before rollback.

## Open work before completion

- The lead record currently stores campaign and source references but no exact route package ID. Add capture of that immutable ID or an equivalent execution receipt before claiming approved-route-to-cash attribution.
- Run the full schema upgrade replay in CI or a healthy disposable environment; the local CLI reset health failure is environmental evidence, not a passing upgrade test.
- Execute the two authorized account journeys, negative cases, provider receipts and post-release identity checks. Record dates, owners, IDs and results here. Until then, Phases 8 and 9 remain incomplete.
