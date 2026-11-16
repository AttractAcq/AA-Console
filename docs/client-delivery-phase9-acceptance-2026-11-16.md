# Client delivery Phase 9 acceptance and release record

**Status:** blocked / not accepted after a read-only production inspection on 16 November 2026. **Merged source:** PR #356, merge commit `70c012f0f7205ee3d98a171aaf9c354841edcfc3`. The deployed browser and runtime do not match that commit. The live observations below were supplied by the desktop browser operator; this CLI session did not independently access the Console. This record follows the [build plan](client-delivery-build-plan-2026-11-14.md) and `AGENTS.md`.

## Evidence rules

Record the test client, operator, time, application SHA, runtime SHA, database migration head, exact approved version, external account and receipt ID for each journey. A queue entry, approval, export, attempted send, provider acknowledgement, read-back, lead and cash outcome are separate observations. Use `unknown` for a missing source or metric. Keep private customer details and credential values out of this record.

| Gate | Evidence to attach | Current status |
| --- | --- | --- |
| Schema | Clean upgrade replay, schema parity, migration list and generated types | CI clean and upgrade replay passed at source `49a30e6`; live migration head `20261115190000` and parity report unavailable. Production equivalence unknown. |
| Application | Frontend/runtime build and focused page tests at candidate SHA | All four CI jobs passed at `49a30e6`; live browser and runtime are behind the merged commit. |
| Organic journey | Approved exact asset and slot, provider publish receipt and read-back, captured lead with consent, sale and cash | Needs authorized test client and live provider run |
| Paid operator journey | Approved bundle hash, downloaded bytes, named handoff, external campaign/ad IDs, account read-back and metrics, lead and outcome | Needs authorized operator and live account run |
| Archive | Each domain archived and restored, historical attribution preserved, rejection reason retained | Six record domains passed disposable rollback fixture; live retrieval check open |
| Release identity | Deployed frontend/runtime/gateway SHA and database migration head | Browser `ca82a3c`, runtime `20c3ec8`, gateway `70c012f`, migration `20261115190000`; mixed release, not accepted. |

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
- CI clean and upgrade schema replay passed at the merged source. Configure production parity read access and reconcile the live migration head before deployment.
- Execute the two authorized account journeys, negative cases, provider receipts and post-release identity checks. Record dates, owners, IDs and results here. Until then, Phases 8 and 9 remain incomplete.

## Read-only live inspection — 16 November 2026

**Result: BLOCKED / NOT ACCEPTED.** Operator: Codex acting for Alex through the signed-in desktop Chrome AA Console tab. Client `e4b4b001-81f6-4997-8429-ff21f4ee1fbe` is the in-house Attract Acquisition account. Its use as an isolated disposable test fixture was not established. The production project shown was `bancbdztffokwiifzoiv`. System Readiness displayed a snapshot at 15:50:07, identities through 15:50:08, and a worker heartbeat at 15:50:09; display timezone was not independently verified. No application data, switches, approvals, credentials, migrations or deployments were changed. No publish, ad activation, lead submission, sale or cash event was performed.

| Component | Observed live identity | Assessment |
| --- | --- | --- |
| Merged source | `70c012f0f7205ee3d98a171aaf9c354841edcfc3` | GitHub resolved full SHA. |
| Browser | `ca82a3c605bac1cb5345c96d1811ab7e93b8ba51` | Four commits behind target in GitHub comparison; target absent. |
| Runtime | `20c3ec8d5b97070f6584ae13ae29254105f869e2` | One commit behind target in GitHub comparison; path-level equivalence unknown. |
| Gateway | `70c012f0f7205ee3d98a171aaf9c354841edcfc3` | Exact SHA match. |
| Database | migration head `20261115190000`; 341 tracked entries | Upgrade parity with merged source unknown. |
| Schema parity | Admin reports “Schema parity read access is not configured.” | No validated production report. |

The merged source's `supabase/verification/browser-release-components.json` pins runtime `97669c6a454d1678fc0c0e6752791dd42862de21`, gateway `e3447aba23b2af6081c526fe5b8fd12225decdc9`, and migration `20261111020000`. These differ from live observations. Different component SHAs alone do not prove incompatible code, but the browser is demonstrably behind the merged source. Cron registry equivalence is also unknown. A fresh worker, `agent-runtime:1:780cb6b1-3be0-4c68-b695-5d9ecde89d89`, reported the runtime SHA above, heartbeat 15:50:07, queued 0 and active 0. Historical stale workers were excluded from the fresh-fleet assessment. Runtime publishing was On; proof publishing, campaign actions, lead magnet delivery and outbound messaging were Off; the global database Engine was Off. Generic campaign action claims and profile PATCH were explicitly held. Stored credentials were not treated as proof of validity.

### Journey A — organic and proof

Campaign `457e0ca8-8af6-4ead-a39d-d5326c729882` (“AA Organic Launch — 14 Day”) was a legacy Planning record dated 24 September–7 October 2026. The inspected view had no established approved opportunity, offer or organic route package version; planner work was awaited, 0/28 content was ready, no HTML page or built live attached sales agent was present, and there was no manifest. It was marked Not live. UI counts showed actions 0/0, posts 0, pages 0/0 and leads 0; spend days were unknown. These are local counters, not provider read-back.

Engine settings were incomplete: no current month cap, empty timezone, zero cadence and no posting windows, with the global Engine off. Client Engine, publishing, proof, campaign actions, outbound and magnet-delivery switches were off; booking was not set up. Dashboard idea/brief policy switches showed On while both Engine settings were unchecked, an unresolved UI/source discrepancy. Facebook was stored as connected without live account/scope diagnostics; Instagram was stored in error. The Meta integration was stored active with Page ID `873864622487705` and a displayed last check of 04:15:03, but exact-account publishing and ads capability were not preflighted. The main-website proof destination was On while runtime proof publishing was Off; rights version, artifact and placement receipt were unknown. Admin showed no lead capture endpoints. A client agent deployment `e70a4062-1e63-4f39-ac3c-b42b681589ab` was On, which does not prove campaign attachment, exact approval or public health. Unified Inbox's default Pending filter loaded 0/0; historical and owning queues were not exhaustively inspected. No provider post ID, URL, timestamp, receipt or read-back was established.

### Journey B — paid operator and outcomes

Meta Ads Studio reported paid distribution unavailable and Schedule Paid disabled. Its November calendar showed no scheduled image assets; Paid Reporting said no paid metrics were ingested for the period. No approved operator bundle, exact hash, verified download, handoff, destination account, campaign/ad ID, activation or provider read-back was established. Spend, currency, metric freshness, impressions, clicks, cost and return remain unknown rather than observed zero.

Attribution OS displayed local totals of 0 leads, conversations, appointments and sales, and R0 cash. Those UI values do not prove external zero outcomes. There was no acceptance lead with consent wording, intake ID, click/UTM/source, exact route identity, conversation, appointment, sale or cash receipt. No synthetic outcomes were entered.

### Existing failures and unexecuted cases

Dashboard displayed 17 failed runs. Observed examples included `opportunity_evaluate` receiving Anthropic HTTP 400 for missing `additionalProperties=false`; `meta_build_sheet` missing template/objective, daily budget, current campaign dates and approved image ad copy; and `video_edit` QA failures for prescribed shots, captions, colours and compositing. These were pre-existing observations. Exact job IDs and retry outcomes were not established. The evaluator's schema defect is being addressed in a follow-up code change; its presence in the live runtime is not proof that the follow-up has deployed.

Controlled invalid-credential/wrong-account, stale-approval, revoked-rights, duplicate-effect, failed-generation/publish-and-retry, cross-client/AAL2, and archive/restore checks were **not executed**, therefore not passed. A disposable approved fixture and restricted identity were unavailable. Missing metrics were recorded as unknown.

**Stop decision:** keep outward switches off. The release owner must reconcile the browser/runtime/schema identities and release pins, configure read-only production parity, establish exact approved organic and paid test versions, complete scoped account preflight, and designate an isolated fixture before either journey can run. Record queue, approval, attempt, provider acknowledgement, read-back, lead, sale and cash as separate evidence. No migration, deployment or ad spend is authorized by this read-only inspection. Phases 8 and 9 remain incomplete.

## Local pre-live follow-up — route capture lineage

The draft follow-up change on PR #358 adds a route-specific campaign page-form endpoint, snapshots its exact route package on every submission, and displays recorded capture route IDs in Attribution. General Sales OS capture links without a campaign remain supported and have an unknown route; campaign page forms must be created in Website Studio. Existing endpoints and historical submissions remain unknown. The route ID describes the capture door, not provider execution or sale causation. The endpoint starts disabled and still needs the existing activation and exact page approval flow.

The new database guards reject wrong campaign/client routes, stale plan packages, route retargeting and submission source rewrites. A disposable rollback fixture covers route binding, snapshot, client-read authorization and rejection paths. Local verification passed: clean replay, released-to-current upgrade equivalence, catalog contract, generated types, all four Phase 8 rollback fixtures, 35 focused UI tests and a production frontend build. This is local source preparation only; the new migration and browser code have not been deployed, and no live capture has been performed. The live release and provider gates above remain blocked.
