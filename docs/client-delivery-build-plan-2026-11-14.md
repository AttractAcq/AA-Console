# AA Console — client delivery build plan

**Prepared:** 14 November 2026
**Scope:** Every client Delivery page from Dashboard through Archive, plus the shared contracts that make those pages work together.
**Basis:** Alex's 31 October operating notes, the 12 November read-only review, the 14 November gap inventory, and GitHub `main` at `a8a179c8d80ebf6bb8741f935bb5ec14809a27f6` (12 November). The original plan was saved from an older checkout; implementation now runs in a refreshed, isolated local worktree on `feat/client-delivery-phase2-controls`. Deployed identity still requires verification before release.
**Evidence rule:** A rendered page, saved row, queued job, approval, external action, and measured outcome are different states. Mark each state complete only with its own evidence.

## Outcome and non-negotiable contracts

The intended journey is **onboard → intelligence → opportunity → approved offer → campaign plan → content/proof/conversion assets → exact-version review → distribution or paid-operator handoff → lead and sale → attribution → archive**. A client operator must be able to see the current state, blocker, owner, next action, and evidence at every handoff.

- Internal generation may run unattended within client settings and spend caps. An external effect requires a human decision on the exact artifact version, action, destination and scope. Recheck current permissions, rights, credentials, switches and budget immediately before execution.
- Every execution stores an idempotency key, attempt, provider response, external ID or URL, timestamp, and remediation path. “Approved” never means “published,” “delivered,” or “live.”
- Every artifact and event carries client ID and, where relevant, opportunity ID, offer version, commercial campaign ID, route package ID, source/derivative IDs, approval ID and external ID. A missing relationship is shown as unknown.
- Preserve existing working v5/v6 capabilities, deep links and historical records while consolidating UI. Archive a surface only after its unique function has a new home and a migration/retrieval test.
- Read-only account pages and manual operator handoffs remain honest about what the Console cannot execute. No real provider action is used as an acceptance test without an exact approval and a safe test account or client-authorized scope.

## Phase order

| Phase | Name | Depends on | Pages primarily affected | Exit evidence |
|---|---|---|---|---|
| 0 | Baseline and product decisions | — | All | Current deployed SHA/schema and route inventory; resolved campaign and Motion decisions |
| 1 | Shared identity, lineage and state contracts | 0 | Campaign, all producers, Attribution, Archive | Versioned IDs and state transitions visible in one test campaign |
| 2 | Controls, approvals and execution boundary | 1 | Dashboard, Approval Inbox, all external actions | Complete approval-class inventory; stale/duplicate/unauthorized actions fail closed |
| 3 | Reliable inputs | 1–2 | Intelligence, Market Opportunities, Offer, Proof Production | Sourced, reviewable opportunity and approved offer/proof versions |
| 4 | Campaign planning and orchestration | 2–3 | Campaign Factory, content and conversion producers | One command prepares a durable dependency plan and stops at review |
| 5 | Production quality and ready-for-review packages | 4 | Content Production, Proof Production, Motion decision | Required assets pass QA and human review with full lineage |
| 6 | Conversion preparation and test | 4–5 | Website, Sales, Lead Magnet | Approved page/agent/magnet path and sourced, consented test lead |
| 7 | Distribution and paid handoff | 2, 5–6 | Organic, Proof Distribution, Meta/Google studios and profiles | Provider receipts for supported routes; manual paid handoff reconciled |
| 8 | Measurement, feedback and Archive | 1, 6–7 | Attribution, Dashboard, Archive | Source-to-cash chain, data coverage, archive/retrieve checks |
| 9 | Full acceptance and release | 0–8 | All | Organic and paid journeys, failures/retries, roles, deployed identity verified |

The phases express dependencies, not dates. A page may receive early scaffolding and close only when its phase exit evidence exists.

## Phase 0 — reconcile the baseline and settle two product decisions

1. Refresh a clean development checkout from GitHub `main`. Compare its SHA, migrations, runtime and frontend with the deployed versions. Reproduce the current client navigation, switches, approval coverage, provider connections, and held routes in a read-only test account. Record discrepancies against the 12 November review; do not turn an old counter into a current claim.
2. Inventory every client page/tab, legacy deep link, data source, executor, approval class and archive path. Classify each as visible, internally working, prepared, externally verified, outcome verified, held, or missing. Give each gap an ID and owner.
3. **Campaign structure decision — proposed contract:** one *commercial campaign* may coordinate organic and paid work, while each route remains a separately versioned *route package* with independent assets, approvals, activation and results. This meets Alex's “both capable” request without treating one paid approval as permission for organic publication. Migrate existing one-route campaigns as a commercial campaign with one route package; preserve clone lineage. Finalize the schema/UI contract before Phase 1.
4. **Motion Design decision — proposed contract:** retire it as a separate client navigation module after moving accepted renders and source projects into Content Production/Website asset records. Preserve revision and QA history. Reconcile the archived-surface ledger, which says it is archived, with current navigation, which still exposes it. If retained, assign it a defined producer role and the same review contract in Phase 5.

**Exit gate:** a signed-off state diagram and page inventory, with explicit answers to both decisions and a list of deployed-versus-source differences. No production mutation in this phase.

## Phase 1 — shared identity, lineage and state contracts

1. Define stable IDs and version fingerprints for opportunity, offer, campaign, route package, content/proof asset, page, magnet, sales agent, approval, distribution attempt, lead and outcome. Backfill existing records without changing their public meaning.
2. Define a common work-item contract: owner module, required/optional, input snapshot, expected output, job/attempt, cost, QA, blocker, approval, external result and retry/remediation state. Each module updates only its own work item.
3. Define explicit transitions: `draft → prepared → ready_for_review → approved → execution_due → attempted → externally_confirmed`, with held/failed/revoked/archived branches. Report UI labels from evidence, not from an optimistic campaign badge.
4. Add provenance and invalidation: changing an offer, proof right, source model, destination or artifact bytes makes affected pending approvals stale; existing external uses generate a remediation task where appropriate.

**Exit gate:** one migrated test campaign can trace every existing related record; a stale source version cannot silently remain approval-ready. Migration replay, tenant isolation and legacy-route tests pass.

## Phase 2 — Dashboard, Approval Inbox and shared execution

### Dashboard

- Put all client automation controls in one panel with effective state, prerequisites, last run, current blocker and last external receipt. Show the global Engine switch and runtime flags as read-only dependencies next to client switches.
- Make Master AI a read-only operational brief first: summarize runs, held jobs, stale approvals, provider health, owed deliveries, spend and failed external actions with links to source records. Add suggested actions only when the source and decision authority are explicit. Refresh incrementally rather than inferring from a static text snapshot.
- Keep controls unavailable when their executor is held. Turning a switch on must never manufacture a false “running” state.

### Approval Inbox and executor

- Inventory every action requiring a person. Bring all classes into Unified with an exact preview, source version/hash, destination, scope, consequence, rights/consent, cost/budget, expiry, reviewer and required assurance level. Preserve specialist queues for detailed decisions.
- Resolve the generic campaign-action claim hold with an atomic handler-ownership claim. An executor claims only an action it can perform; it revalidates the decision and dependencies before touching a provider.
- Store a separate receipt for approval and each execution attempt. Support idempotent retry, failure, retraction and revocation; alert the owning queue when approved work is held or fails.

**Exit gate:** 100% of the live required approval-class inventory has an owner, preview, decision path and execution outcome state. Tests prove stale bytes, wrong client, missing AAL2, absent consent/rights, disabled switch, unsupported handler and duplicate request fail closed. One supported external test action produces an observed receipt.

**Implementation checkpoint, 14 November 2026:** The local Phase 2 branch now has Dashboard runtime-control evidence, a read-only operational brief, a service-offer Inbox bridge and direct-write guard, an opt-in owned campaign-action claim, per-attempt receipts, a prewrite recheck, an owning-queue alert for held or failed campaign actions, and an AAL2 campaign-action withdrawal recorded in both the source and Inbox. The Dashboard now distinguishes source-held approvals and counts campaign actions as held only when a blocker exists. Proof release and lead enrolment require an owned wrapper that checks the current decision within the same transaction as the internal effect. Rollback-only fixtures prove that a withdrawn campaign action cannot be claimed, a disabled client switch blocks the wrapped effect, and an offer cannot be signed off or used by a campaign without its exact Inbox decision; local tests do not verify a provider action. The opt-in remains off by default. The local 34-class coverage view records 2 operational, 16 blocked and 16 missing classes; these are implementation-evidence states, not verification of live provider actions. Remaining work includes source-specific Inbox coverage, alerts for other owners, external retraction and unknown-outcome reconciliation paths, live assurance tests, and an authorized external test action with a provider receipt. Phase 2 is open.

**Lead magnet checkpoint, 14 November 2026:** New lead magnet approvals now create an exact Inbox request for the versioned file, delivery words, route and consented recipient scope. A trusted runtime route downloads and hashes stored bytes before the card becomes decision-ready. The source decision and Inbox event share one transaction and require a provisioned AAL2 owner. The due view checks the current decision, same-client opt-in, consent, bound endpoint, recipient and client switch; the courier still rehashes before sending. A rollback-only fixture covers wrong bytes, AAL1, an unauthorized reviewer, duplicate decisions, disabled switch, wrong recipient, revocation and a pre-bridge pending approval. Existing approved records remain labeled legacy and require an audit before migration. The class remains **blocked** in the coverage inventory until an authorized provider send and its receipt are observed. Phase 2 remains open.

**Proof-capture delivery checkpoint, 14 November 2026:** Preparing an email, SMS or WhatsApp evidence request now creates a canonical Inbox card with its exact recipient, message, subject, channel, template, capture link and send time. An AAL2 owner decides the current review epoch; direct approval is denied. The worker claim and a second runtime check require that decision and an active, unused capture link. A rollback-only fixture covers duplicate requests, AAL1, stale recipient, legacy status-only approval and revoked-link claim denial; the UI and runtime tests cover decision routing and pre-send refusal. Clean local migration replay passes. The provider sender account is not yet bound into the review packet, and no authorized external send/receipt has been observed, so this class remains **blocked**. The local 34-class view is now 2 operational, 18 blocked and 14 missing; Phase 2 remains open.

**Message template checkpoint, 14 November 2026:** New standing message approvals now request an exact Unified Inbox decision for immutable version words, template purpose, channel and the human-stated consent basis. A provisioned AAL2 decision writes the approval signature; the old direct approval RPC is denied. Editing template metadata invalidates old review tokens even after reverting the edit. Queueing, claiming and the courier pre-send check the current Inbox decision; the queued payload is immutable, and consent, suppression, channel support and the client switch are rechecked. A rollback-only fixture covers duplicate requests, AAL1, stale and reverted metadata, direct approval refusal, changed queued words, switch off, consent removal and last-moment denial. A clean local migration replay and focused UI/runtime tests pass. The class remains **blocked** pending legacy approval reconciliation, a message authoring/request screen, sender identity binding and an authorized provider receipt. Local coverage is 2 operational, 22 blocked and 10 missing; Phase 2 remains open.

**Meta profile proposal checkpoint, 14 November 2026:** A draft Facebook or Instagram field change now requests an exact Inbox review of its before/after values, platform, field, offer link and reason. A provisioned AAL2 owner decides it in the same transaction as the source status; the old direct decision RPC and direct status approval are denied. A rollback-only fixture covers duplicate requests, AAL1, changed proposal text and exact approval. The page shows pre-Inbox approvals separately from exact Inbox decisions. No provider field PATCH is released: the runtime hold remains, and account identity, field capability, prewrite check, provider receipt and read-back are still required. The class is **blocked**.

**Google Business Profile proposal checkpoint, 14 November 2026:** A pending field proposal now requests an exact Inbox review of the before/after words, reason, same-client location reference and last recorded profile read. A provisioned AAL2 owner decides it in the same transaction as the source status. Direct approved/applied transitions are refused, and the profile updater retains its global prewrite hold. A rollback-only fixture covers cross-client location mismatch, duplicate requests, AAL1, stale text, a reverted old review epoch, exact approval and an attempted applied status. The page distinguishes legacy approval from an exact Inbox decision. This class is **blocked** until account/location verification, current provider field comparison, an authorized provider PATCH receipt and read-back exist.

**Sales-agent public-use checkpoint, 14 November 2026:** The Sales OS request button now opens an exact-script Inbox request. Its source preview includes the full operating definition, client, bound page and consequence; an AAL2 decision writes the public-use signature in the same transaction. A direct signature fails, and changing the script invalidates approval. The public resolver and deployment-enable trigger check the current decision. A rollback-only fixture proves AAL1, unauthorized, direct-write, stale-script and unapproved-deployment refusals, plus revocation and a new request epoch. Existing approved agents are shown as pre-Inbox legacy records; they still need explicit review. This class remains **blocked** until a live test conversation and intake receipt are observed.

**Market-opportunity approval checkpoint, 14 November 2026:** A validated opportunity now requests review of a frozen buying-situation, score, strategy, intelligence-link and proof-requirement snapshot. Its AAL2 Inbox decision moves the source to approved in the same transaction. Direct status approval is refused, and campaign creation rechecks the current decision before either returning an existing campaign or making a new one. The UI shows stale and pre-Inbox approvals and withholds campaign creation for them. A rollback-only fixture covers duplicate requests, AAL1, wrong client, direct status writes, changed strategy, first campaign creation, stale reuse, pause and fresh review, and rejection. This class remains **blocked** until legacy approvals are reviewed and a live campaign plan is observed.

**Market-opportunity activation checkpoint, 14 November 2026:** The earlier opportunity approval still permits planning; moving an approved opportunity to active now requests a separate exact Inbox decision. Its preview binds the current approved buying-situation record, proof and linked campaigns, plus the activation note. A provisioned AAL2 decision atomically changes status and records an opportunity event. Direct active status changes fail; moving to learning or scaling requires a current activation decision. The client table labels legacy and stale activations. A rollback-only fixture covers AAL1, duplicate requests, a campaign added after review, stale decision refusal, approval, progression, pause and legacy progression refusal. The class remains **blocked** until existing active, learning and scaling records are audited and reconciled.

**Proof-rights checkpoint, 14 November 2026:** Text proof requests an exact Inbox review of its source words, permission basis and expiry. Stored image/video proof now uses a trusted runtime route that downloads and hashes the private file, checks its Storage object identity before and after the download, and binds the digest and file size to the exact review request. The reviewer must download and verify that file from the Inbox before its approval button unlocks. A source-owned AAL2 decision grants clearance; direct grants and pre-cleared inserts are refused. Restricting rights, editing a cleared source, or changing its Storage object ends clearance and records a revocation; pending media requests also become stale on Storage changes. The Proof Factory opens review instead of writing approval directly. Rollback-only SQL fixtures cover text and media decisions, wrong identity, AAL1, stale bytes and revocation; route tests prove the browser cannot supply the digest. Media placements remain held until their provider prewrite route rehashes bytes, and historical clearances and downstream uses need an audit. This class remains **blocked**.

**Standalone proof-placement checkpoint, 14 November 2026:** A text proof with current Inbox-cleared rights can now request a destination-specific placement decision in the Unified Inbox. The request freezes source words, rights, destination account and placement payload; an AAL2 source decision releases it to its destination worker or manual placement state. Direct decisions are refused, including attempts to decide campaign-owned placement rows outside their campaign action executor. The Proof Distribution page sends pending standalone reviews to the Inbox. The API due view and assisted placement action recheck the current decision, rights, destination support, integration and client switches before an effect. A rollback-only fixture covers duplicate requests, AAL1, wrong client, old direct approval, changed destination account, switch-off refusal, approval, manual receipt and rights revocation. Raw media placement and produced media assets still need a trusted provider prewrite byte check; legacy approvals and provider receipts need audit. The class remains **blocked**.

**Proof-artifact signoff checkpoint, 14 November 2026:** New immutable GEO, SEO and local-snippet artifact versions now request an exact Inbox review of their source proof, current rights, claim, evidence excerpt and complete artifact words. The source-owned AAL2 decision writes the signoff row; the old direct signoff path is refused. A placement rechecks the current signoff and rights before accepting the artifact, and the provider worker repeats the live placement gate immediately before its write. Historical signoffs without an Inbox decision are labeled legacy and held. A rollback-only fixture covers direct-write refusal, AAL1, duplicate request, exact signoff, artifact placement and rights revocation; a runtime test covers rights or approval changing after claim. Produced media assets remain held pending trusted byte/version review, and legacy artifacts and external receipts need audit; this class remains **blocked**.

**Creative approval route audit, 14 November 2026:** `ApprovalsPanel`, `CampaignContentPanel`, `ClientConsolePage` and the SMM's ordinary-video route historically called `review_media_asset` directly. Engine-owned assets instead use `approve_slot`, which signs off and schedules the slot atomically; moving that action to the ordinary-media RPC would strand the slot. Video also has owner, manager and optional client signoffs before final asset approval. The Production Bot has a separate `mcp_approve_asset` path that can set `review_status=approved` without human approval; `human_approved_at` distinguishes it for scheduling. The remaining bridge must preserve the video seats and Engine-slot transaction, cover multi-file creative and replace downstream checks that rely only on `human_approved_at`; legacy decisions need an audit.

**Creative byte-verification checkpoint, 14 November 2026:** A trusted runtime route can now download the current `client-media` object, hash its bytes, compare Storage identity before and after the download, and register the digest only when the asset and Storage row still match. The existing Storage mutation trigger clears the digest on replacement or deletion. Route tests reject another client's asset and changed bytes; a rollback-only SQL fixture rejects a wrong object ID and verifies invalidation. This establishes byte evidence for a future exact Inbox card. It does **not** approve creative, replace the direct review paths, or change the ordinary-media class from **missing**.

**Single-file creative Inbox checkpoint, 14 November 2026:** An image or text asset in `single` format can now request review after trusted byte attestation and recorded usage rights. The request freezes file digest, Storage object identity, source lineage and intended source signoff. A provisioned AAL2 manager or admin approves the exact card; the source-owned RPC records the Inbox event and then calls the existing asset review function. A direct human approval of that path is refused. A linked client account can submit the review request without gaining decision authority. The Inbox requires a matching file download before its approval button unlocks. A rollback-only fixture covers direct approval refusal, duplicate request, AAL1, client submission, exact approval and Storage mutation; UI tests cover the review button and owning RPC. This moves ordinary media from **missing** to **blocked**. Video, carousels, Engine slots, legacy approvals and downstream current-decision checks remain open.

**Creative current-signoff checkpoint, 14 November 2026:** A reusable predicate now checks the exact AAL2 event, source snapshot, rights, trusted file digest, Storage identity and invalidation record for a single-file image/text asset. The Organic Distribution asset list keeps a stale approved asset visible with a blocker, and the manual `schedule_asset` RPC refuses it even if `human_approved_at` remains set. The rollback fixture confirms scheduling reaches the later campaign-lineage check while the signoff is current, then fails at the signoff check after Storage replacement. Publication remains separately held by its outgoing package gate. Engine slots, multi-file assets and legacy downstream uses still need their own review and execution audit; ordinary media remains **blocked**.

**Engine-slot schedule hold checkpoint, 14 November 2026:** The specialist Engine queue now visibly holds “Approve and schedule” while its canonical preview lacks exact media, rights and destination evidence. A database trigger also refuses the `awaiting_approval → scheduled` transition unless a provisioned AAL2 reviewer has an approved, current, exact Engine Inbox request. Because the owning evidence and decision adapter is not yet built, this is a deliberate hold rather than a released scheduling route. Rejection and regeneration remain available. A clean local migration replay, rollback-only SQL fixture, Engine UI tests and TypeScript build passed. The next step is an Engine-owned request and decision that freezes trusted bytes, copy, slot and publisher account, then rechecks them before the atomic asset signoff and schedule transition. The Engine class remains **blocked**.

**Single-file Engine review checkpoint, 14 November 2026:** Image and text Engine slots can now attach a trusted media-byte digest, Storage identity, usage rights, all asset copy, schedule, slot lineage and a named Instagram or Facebook account to their existing Inbox entry. The specialist queue prepares that packet; the Unified Inbox requires the reviewer to download and verify the file before its AAL2 decision. The source-owned decision records the exact event and calls the existing atomic asset-signoff-and-schedule function. The asset-signoff guard blocks the old direct review RPC, and both slot transition guards recheck the decision and current package; post-schedule Storage mutation marks the Inbox card superseded. A clean migration replay, rollback-only fixtures for AAL1, direct bypass, duplicate preparation, stale copy, stale bytes, atomic schedule and later byte replacement, plus 78 focused UI tests passed. Video, multi-file creative, multiple legacy slot-entry events, direct specialist rejections, live provider identity and external publication receipts remain open. The Engine class remains **blocked**.

**Recruitment media eligibility checkpoint, 14 November 2026:** The AA recruitment campaign builder now lists only single-file images with a current exact creative Inbox signoff and an exact approved recruitment brief. Its server RPC repeats those checks, so a forged client selection or an old `review_status=approved` flag cannot create a campaign. An archived source brief remains usable after asset production because its approved copy is immutable; replacing the stored image ends eligibility and supersedes its held Meta build request. A rollback-only fixture covers the brief and media approval chain, held campaign creation and stale-byte refusal. This moves recruitment media from **missing** to **blocked** in the local 34-class inventory, now **2 operational, 17 blocked, 15 missing**. A separate recruitment media decision card, a provider prewrite byte recheck and Meta receipt remain open.

## Phase 3 — Intelligence, Market Opportunities, Offer Studio and proof inputs

### Intelligence OS

- Record source, observation date, model run, human correction and factual-confidence status for every generated section. Flag unsupported claims and missing input domains before downstream use.
- Make input snapshots immutable for a given plan; show which model version every opportunity, offer and campaign used. Provide a rerun path that creates a new version and names dependent items requiring review.
- Validate the current Strategy outputs, including Offer Strategy and Content Pillars, through repeated source-based review rather than job-completion status alone.

### Market Opportunities

- Use a searchable opportunity overview with one record showing Discover, Evaluate, Strategize, evidence, score, readiness and activation. Preserve current stage actions and the supported 2–8 discovery count.
- Add assisted evaluation and strategy drafts. Keep factor scoring, evidence-confidence ladder and claims independently reviewable. Require human activation; a generated hypothesis cannot authorize spend.
- Link an activated opportunity to its secondary offer and commercial campaign, with later evidence changes triggering review rather than silent propagation.

### Offer Studio

- Prove the existing main and secondary compiler against real inputs, failures and retries. Main offers use approved Offer Strategy; secondary offers bind a specific opportunity and its evidence snapshot.
- Keep a simple offers table with creation/compile actions, version detail, claims and live uses. Require exact-version human sign-off and current proof clearance before a campaign can select an offer.

### Proof Production inputs

- Test all six capture methods independently. Record genuine origin, author/source URL where relevant, consent or rights basis, expiry, intended channels and removal history.
- Production and repurposing retain the raw source and parent/version lineage, and stop at a reviewable asset. Rights withdrawal blocks pending uses and creates tasks for live destinations.

**Exit gate:** a reviewed, sourced opportunity produces an approved secondary offer; a genuine proof source supports a traceable derivative. An unsupported claim, expired right or missing opportunity evidence prevents downstream approval.

## Phase 4 — Campaign Factory as the coordinating workflow

1. Create a reviewed plan with objective, micro-niche, approved offer version, organic/paid route packages, platform, audience, positioning, content quantities by format, proof, page, sales agent and optional magnet requirements. The planner may propose quantities; a human can correct and approve the plan.
2. Convert each required item into a durable work item under the Phase 1 contract. Queue internal producers idempotently, respect per-client spend caps, expose progress and blockers, and retry only the failed item.
3. Assemble a versioned campaign package with the exact outputs and dependency evidence. A package is `ready_for_review` only when all required assets have passed their internal QA. Human approval of the package does not substitute for each consequential external-action decision.
4. Keep old campaigns and deep links readable; migrate route and opportunity/offer associations without asserting that legacy `live` means external activation.

**Exit gate:** one organic and one paid route package can be prepared from a commercial campaign without manual record stitching. A failed page or video job holds only its dependent work and names the retry. No external write occurs during preparation.

## Phase 5 — Content Production, Proof Production and creative quality

- Drive both campaign demand and recurring organic demand through Ideation → Brief → Create → Edit/Repurpose → QA → human review. Show requested, produced, rejected, revised and accepted counts by format, campaign and destination.
- Fix image factual/content errors and video continuity, claim, brand and full-cut quality. Compare candidate outputs against the same brief and record cost, latency and human acceptance. Keep original media and every derivative/rejection reason.
- Have proof capture methods optionally trigger production and repurposing to `ready_for_review`, subject to rights and source integrity. Never treat AI QA as publication approval.
- Execute the Phase 0 Motion Design decision: integrate accepted output and history into the receiving asset library, or retain the module with a defined producer contract and acceptance test.

**Exit gate:** representative campaign and recurring-organic assets of each supported format pass blind human review, have approved source/claim rights, and can be traced to their brief and source. Rejected work is retrievable with its reason.

## Phase 6 — Website Studio, Sales OS and Lead Magnet Studio

### Website Studio

- Generate main pages from main offers and campaign pages from the approved opportunity/secondary offer and campaign plan. Preserve page bytes, source versions, repository/commit and build history.
- Review the exact page before publishing. Record GitHub commit, public URL and provider read-back. A live page remains `untested` until a consented test submission reaches the intended Sales OS capture path.

### Sales OS

- Prepare an offer/page/campaign-bound sales agent as a draft. Review its exact instructions and claims, then attach and separately enable it on the approved page. Prove a conversation, capture, handoff and booking path.
- Keep capture endpoints, source, consent and access requests attached to leads. Confirm Pipeline and its permissions work under Attribution OS after the move.

### Lead Magnet Studio

- Build and version a magnet from the approved offer and campaign; review its bytes and claims. Distinguish approved, downloaded/handed to operator, enabled for automatic delivery and actually delivered.
- Keep opt-in, consent and owed-delivery visibility in the magnet detail and Sales Capture even though the old Opt-ins tab is archived. Do not enable delivery merely because a version is approved.

**Exit gate:** an approved page and agent receive a real test submission with campaign, route, source and consent, visible in Sales and Attribution. The optional magnet can be downloaded for manual handoff and has a separately testable delivery path if enabled.

## Phase 7 — organic, proof and paid distribution; Meta and Google profiles

### Organic Content Distribution and Meta Profile

- Verify Facebook and Instagram identity, account rights and token scope. Connect approved slots to scheduled provider writes and read-back. Keep a distribution log of scheduled, attempted, published, failed, removed and retried posts with external IDs.
- Consolidate destination setup and log navigation without losing cadence/Engine settings. Meta Profile reads the same actual post and outcome receipts; profile field changes remain separate exact-version actions with their own adapter.

### Proof Distribution and Google Studio

- Give each of the ten proof destinations its own capability/preflight state. Implement missing adapters only where the destination truly supports them; model assisted/manual placements as verified handoffs, not automatic publication.
- Provide a distribution and rights/remediation log before removing the old Placements/Rights logic. Show exact proof version, clearance, destination, external URL/ID, expiry, retraction and provider result.
- Verify Google Business Profile location/credential, review ingest, separately approved replies, post read-back and metrics freshness. Keep Google Ads data outside Business Profile ingestion even if shown in a combined client overview.

### Meta Ads Studio and Google Ads Studio

- Build a versioned paid-operator bundle: approved creative, targeting/offer/page context, copy, tracking, budget instruction, owner and handoff receipt. The human operator records external campaign/ad IDs, activation and changes.
- Ingest read-only real-account inventory and metrics for Meta and Google. Google automated build stays explicitly unbuilt until a separately scoped executor is approved and tested; the manual build sheet remains available.

**Exit gate:** one approved organic post and one supported proof placement have provider receipts and read-back; failures are visible and retryable. One Meta and one Google paid package can be handed to a human and reconciled to actual external IDs and metrics. Unsupported destinations say so plainly.

## Phase 8 — Attribution, Master AI feedback and Archive

### Attribution OS

- Join route/package, opportunity, offer, asset, page, agent and magnet versions to source/consent, provider events, appointments, sales, spend and collected cash. Reconcile external IDs, time windows and duplicate leads.
- Label every figure observed, estimated or unknown, and show coverage/freshness and sample size. Missing site or provider data must not appear as zero. Finish landing/offer-page analytics and paid/organic metrics connections.
- Feed dated, confidence-qualified learnings into Intelligence and future campaign planning; do not overwrite historical input snapshots.

### Dashboard and Archive

- Upgrade Master AI from the Phase 2 operational brief to a trustworthy cross-module explanation of what happened, what is blocked, what worked, and what needs a person. Every statement links to evidence.
- Verify archive/retrieve paths for Content, Pages, Campaigns, Sales Agents, Opportunities, Models and Lead Magnets, plus rejected creative and reason. Preserve lineage, rights, receipts and attribution after archive; allow operators to clear active queues without losing history.

**Exit gate:** a test lead can be traced to an approved route/asset/page and then to a recorded sale and cash event; missing data remains unknown. Every archive category has a tested write and read path, and an archived item remains in historical reporting.

## Phase 9 — full acceptance and release

1. Run one complete organic journey and one paid-operator journey on an authorized test client. Include a failed credential, stale approval, revoked proof right, duplicate execution, failed media job, failed publish, missing metric and retry. Confirm cross-client isolation and role/AAL2 boundaries.
2. Compare the delivered application with every page row below, current navigation, legacy deep links and the original operating notes. Verify no moved control has become unreachable. Measure actual provider receipts and outcome links; record unresolved limitations with owner and severity.
3. Run meaningful tests, migration replay/schema parity, frontend/runtime build checks, accessibility checks for review and status controls, and release identity checks. Prepare a reviewable PR and deployment runbook. Follow `AGENTS.md`: Alex via Chief of Staff handles merge, production migrations and Railway deployment.
4. After release, verify deployed frontend/runtime SHA, database migration state, provider preflight, error queues and the two end-to-end journeys again. Close the plan only from post-release evidence.

## Page coverage checklist

| Client page | Build phases | Required final check |
|---|---|---|
| Dashboard | 2, 8 | Effective controls and evidence-linked Master AI |
| Approval Inbox | 2, 9 | All required classes, exact decisions and outcomes |
| Intelligence OS | 3, 8 | Sourced versions and downstream use |
| Market Opportunities | 3–4 | Reviewed evidence, activation and linked offer/campaign |
| Offer Studio | 3–4 | Compiler, exact approval and live-use trace |
| Campaign Factory | 1, 4, 9 | Durable coordinated packages and external truth |
| Content Production Factory | 4–5 | Campaign/organic demand and accepted assets |
| Organic Content Distribution | 2, 7 | Approved slot through provider receipt |
| Meta Ads Studio | 7–8 | Operator bundle, external IDs and real metrics |
| Meta Profile | 7 | Verified identity, posts and outcomes |
| Google Ads Studio | 7–8 | Manual build reconciliation and read-only inventory |
| Google Studio | 7 | Verified location, review/post/metrics reads |
| Proof Production Factory | 3, 5 | Six capture methods, rights and derivatives |
| Proof Distribution | 2, 7 | Ten destination states, placements and retraction |
| Website Studio | 4, 6 | Approved publish and passing intake probe |
| Sales OS | 4, 6 | Approved agent, capture, handoff and booking |
| Lead Magnet Studio | 4, 6 | Version, approval, handoff and owed delivery |
| Motion Design | 0, 5 | Decision executed; assets/history preserved |
| Attribution OS | 1, 6, 8 | Coverage-qualified source-to-cash chain |
| Archive | 1, 8 | Every category archived and retrieved without data loss |

## Working rule for every implementation slice

Each slice ends with: (1) updated source/deployed status; (2) data/API and state contract; (3) UX and accessibility check; (4) permission and external-action boundary; (5) meaningful success/failure test; (6) migration/deep-link compatibility; (7) operator-visible blocker and receipt; (8) a recorded live-account test only when claiming external completion. Update this plan after each slice with evidence and remaining gaps.
