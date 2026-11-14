# AA Console — client delivery build plan

**Prepared:** 14 November 2026
**Scope:** Every client Delivery page from Dashboard through Archive, plus the shared contracts that make those pages work together.
**Basis:** Alex's 31 October operating notes, the 12 November read-only review, the 14 November gap inventory, and GitHub `main` at `a8a179c8d80ebf6bb8741f935bb5ec14809a27f6` (12 November). The local checkout used to save this plan is older than that commit and has an incomplete `.git/HEAD`; refresh it before implementation.
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
