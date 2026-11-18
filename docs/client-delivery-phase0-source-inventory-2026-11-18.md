# Client Delivery source inventory — 18 November 2026

**Scope and evidence level:** This is an inventory of the candidate source first inspected at `4d5624310df9d8d15dc6cf457a6f3991ff146c62`, with the later legacy Strategy redirect correction noted below. It is not a signed-in or deployed-page acceptance result. The 20 Delivery routes and their tab IDs come from `src/config/navigation.ts`; `src/App.tsx` registers the routes, and `src/pages/Page.tsx` binds tabs to panels. A rendered panel proves a source surface exists, not that its data, executor or external provider works. The live source-versus-deployment difference is still open: hosted staging and production were last recorded at migration 551, while draft PR #363 contains candidate migrations 552–567. Recheck deployed component SHAs and migration heads before release.

| Order | Delivery route | Source tabs or view | Main record or reader boundary | Action / review boundary | Archive or history home |
| --- | --- | --- | --- | --- | --- |
| 1 | `dashboard` | One panel | Client switches, runtime and job summaries | Switch edits; outward execution has separate gates | Audit and execution records; no dashboard archive |
| 2 | `approval-inbox` | Engine; Assets; Campaign actions; Unified | Source queues and unified approval ledger | Exact-version, role and assurance decisions; execution remains separate | Decision and attempt history |
| 3 | `intelligence-os` | Intelligence: Business Context, Market, ICP, Competitors, Branding & Associations, Campaign Intelligence, Campaign Inputs, Proof Intelligence. Strategy: Branding Strategy, Content Pillars, Offer Strategy, Money Model Strategy | Client model records and planning snapshots | Model generation and human source review | Models (`agent_models_archive`) |
| 4 | `market-opportunities` | One panel | Opportunity hypotheses, evidence, evaluation and activation | Evidence review and activation | Opportunities (`opportunities_archive`) |
| 5 | `offer-studio` | Offers; Versions | Versioned service offers and claims | Exact offer signoff and proof-right checks | Version history; no dedicated offer archive tab |
| 6 | `campaign-factory` | Campaign table; `:campaignId` detail | Commercial campaign, route packages, plan, work manifest | Plan/package review; route actions separately gated | Campaigns (`campaigns_archive`) |
| 7 | `content-production-factory` | Ideation; Briefs; Create; Edit / Repurpose; Assets | Ideas, briefs, renders, edits and approved assets | Production QA and exact human asset review | Content Production and Rejected Creative |
| 8 | `content-distribution` | Assets; Organic Calendar; Engine | Approved assets, scheduled slots and Engine settings | Exact-slot publication approval and provider attempt | Distribution log / post history; asset source archive |
| 9 | `meta-ads-studio` | Paid Distribution; Paid Reporting | Paid calendar, operator reports and metric snapshots | Human paid operator handoff; provider execution not inferred | Paid attempt/report history; campaign archive |
| 10 | `meta-profile` | Identities; Profile; Presence; Posts; Outcomes | Recorded identity, profile proposals, organic post and outcome reads | Profile writes held behind exact review and provider preflight | Profile/post history; no dedicated archive tab |
| 11 | `google-ads-studio` | Build sheet; Account; Automated build | Manual sheet and read-only account snapshots | Exact operator bundle review; automated build remains held | Operator and account-read history; campaign archive |
| 12 | `google-profile` | Location; Reviews; Posts; Metrics | Business Profile identity, proof/review and metric reads | Profile/reply proposals held; Proof Distribution owns placements | Review/post history; no dedicated archive tab |
| 13 | `proof-production-factory` | Capture; Produce; Repurpose; Assets | Raw proof, provenance, rights and derived assets | Source clearance and human asset review | Proof/asset history; rejected creative where applicable |
| 14 | `proof-distribution` | Destinations | Destination configuration and placement records | Exact placement approval, current rights and supported adapter | Placement event history; Placements/Rights panels remain legacy code |
| 15 | `website-studio` | Sites; Landing Pages; Offer Pages; Publish | Page revisions, publication and form-test evidence | Exact page review, publish and separate intake verification | Pages (`pages_archive`) |
| 16 | `sales-os` | Agents; Capture | Agent versions, capture endpoints and consented leads | Agent enable and endpoint activation require separate decisions | Sales Agents (`sales_agents_archive`); lead history in Attribution |
| 17 | `lead-magnet-studio` | Magnets | Magnet versions, downloads, opt-ins and owed deliveries | Exact file approval; manual handoff or separately gated delivery | Lead Magnets (`lead_magnets_archive`) |
| 18 | `motion-design` | Brief; Scenes; Renders | Project, scene and render candidates | Accepted exact cut may attach only as pending content | Render/revision history; no dedicated archive tab |
| 19 | `attribution-os` | Attribution; Organic; Paid; Landing Pages; Offer Pages; Pipeline; Commentary; Economics | Lead/source/outcome joins, provider and site metric coverage | Read and human outcome entry; provider data needs read-back | Historical attribution and pipeline records |
| 20 | `archive` | Content Production; Pages; Campaigns; Sales Agents; Opportunities; Models; Lead Magnets; Rejected Creative | Seven archive views plus rejection list | Archive/restore paths vary by domain; rejection list is not restorable | This page is the retrieval surface |

**Legacy URLs:** `src/config/navigation.ts` maps 15 replaced Delivery paths to their current module and often a default tab. `src/App.tsx` separately redirects `/delivery/campaign-execution/:campaignId` to Campaign Factory detail. `src/pages/LegacyDeliveryRedirect.tsx` preserves old query parameters except that a historical Strategy `view=v1`/`view=v2` bookmark now stays in the Strategy half. Navigation and redirect tests cover route order, targets and that exception. Other retired tab IDs are not comprehensively translated; historical bookmarks and deployed redirects need a signed-in browser pass.

**Product decisions in source:** One commercial campaign coordinates separately versioned organic and paid route packages; the route approvals and results remain independent. Motion Design remains a producer with its scene/render history; only an accepted cut enters Content Production as a pending asset. Both decisions appear in the build plan and candidate implementation, but Phase 0 still needs Alex's signed-off current-state inventory and a deployed/source comparison.

## Open inventory gaps and owners

| ID | Owner | Missing evidence or action |
| --- | --- | --- |
| P0-01 | Release owner | Record fresh browser/runtime/gateway SHAs, migration heads and current route rendering for the target client; compare each against candidate source. |
| P0-02 | Product owner and client operator | Sign off this page/tab inventory and the two product decisions against the real account workflow. |
| P0-03 | Approvals owner | Enumerate every live required class and prove each has an owning queue, exact preview, decision and outcome; the source panel list is insufficient. |
| P0-04 | Provider/integrations owner | Verif
