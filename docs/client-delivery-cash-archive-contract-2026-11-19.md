# Cash-positive lead archival contract — 19 November 2026

**Status:** Original source and isolated-catalog dependency audit for draft PR #363 at `a077d065d4958f58ba29ed4fca9a03b0c77af0ad`. No cash-archive behavior was changed. The current `archive_lead` guard is still required until the reporting and action paths below move together. Hosted projects and outward switches were untouched.

**Candidate progress, 19 November:** Migration 623 added the internal historical lead source. Migration 624 moves `acquisition_funnel` and `client_money_currency_breakdown` onto it, including archived sale-stage events. Their disposable fixture compares before archive, archived and recovered results. Other listed reporting and operational consumers still need migration and cross-surface tests; the positive-cash archive guard remains in force.

Migrations 625–627 add one internal historical progress source and move three public plus two MCP Economics reports onto it. Disposable fixtures cover probe exclusion, active/archive overlap, an archived sale later marked lost, recorded USD cash and exact before/archive/recovery equality. At that point, `content_attribution`, other attribution/MCP summaries and operational claims still needed coordinated work and cross-surface checks before the archive guard could change.

Migrations 628–629 move `content_attribution`, `top_content_by_revenue` and MCP content performance onto archived-aware asset outcomes. The view retains security-invoker behavior; its narrow aggregate helper returns zero lead outcomes to a viewer without lead entitlement and denies anonymous direct execution. Local fixtures preserved cash and sale contribution before/archive/recovery, denied an ungranted MCP bot-client call, and kept absent provider metrics unknown. At that point, the MCP conversion funnel, pipeline summary, page/offer reporting and action claims still needed separate work.

Migration 630 moves the bot-scoped MCP conversion funnel onto the historical sources; its fixture matches before/archive/recovery values and denies an ungranted client. Migration 631 keeps the MCP pipeline's existing stage/count/cash fields active-only, labels that scope, and adds a separate all-recorded-leads cash amount and currency that survives archive. Page/offer reporting, remaining measurement paths, operational action claims and the coordinated archive/recover release gate remain open.

## Present behavior and gap

`archive_lead` snapshots a lead and its events into `archived_leads`, then deletes the active `client_leads` row. It refuses a lead with positive `cash_collected` because current revenue reports read active leads and would lose that cash. Migration 621 makes archived snapshots visible in the scoped journey trace. Migration 622 preserves **new** promoted-submission links through the durable same-client `lead_identities` key. Neither change makes archived cash part of live revenue aggregates, and previously nulled submission links remain unknown.

The Archive goal requires a finished sale to leave the operating pipeline while its historical sale, cash, campaign, offer, route and asset evidence remain readable. A new archive marker on `client_leads` alone would leave the row visible to existing capture, booking, outbound and sequence workers. A direct deletion followed by an uncoordinated aggregate patch would make at least one report disagree with another. Keep the positive-cash refusal until the reporting and action boundaries are implemented and tested as one release.

## Catalog dependency inventory

The isolated 71-migration candidate has **54 public functions** whose definitions mention `client_leads`. The directly affected reporting set includes `acquisition_funnel`, `acquisition_coverage_v8`, `top_content_by_revenue`, `client_economics`, `client_economics_by_channel`, `client_economics_by_campaign`, `client_money_currency_breakdown` and `lead_journey_trace_v8/v10`. The public views `content_attribution`, `lead_pipeline_counts`, `lead_progress`, `campaign_live_evidence`, `delivery_source_catalog_v6` and `outbound_message_due` also read active leads. `mcp_internal.attribution_conversion_funnel`, `attribution_content_performance`, `cohort_economics`, `cohort_economics_by_campaign` and `get_pipeline_summary` are additional measurement consumers.

Operational consumers include capture and deduplication, booking, outbound claims, nurture enrolment, DM merging, lead updates, service-outcome follow-up and Sales OS reads. Those paths must either exclude archived leads or define an explicit, reviewed reopen transition. The inventory is from the local catalog, not a claim that every dynamic query or external consumer was found.

## Implementation sequence

1. Define a single tenant-scoped historical lead reporting source that selects one current or archived snapshot per durable lead identity, preserves recorded amount currencies and source IDs, and labels a missing legacy currency unknown. Prove no double count when an archive snapshot and an operating row coexist during a transition.
2. Move every revenue, attribution, Economics and MCP aggregate above onto that source. Keep operating pipeline counts separate from all-time/historical totals. Preserve each report's existing window, probe exclusion, currency comparability and metric-coverage rules. Add an explicit archived/current coverage field where a report would otherwise imply current operations.
3. Make archive/recover atomic and idempotent for positive-cash leads. Preserve event, route and review lineage. Restore the same financial contribution exactly once, including a previously unknown currency. Do not infer a missing route, provider receipt or cash currency from a campaign or spend row.
4. Prevent archived leads from entering outbound, nurture, booking and proof-follow-up claims. Define how a later consented submission reopens or creates a lead, and require a new explicit action rather than silently changing archived history.
5. Gate release on a rollback fixture that checks pre-archive, archived and restored report values across every listed public/MCP surface, plus mixed/unknown currencies, duplicate submissions, cross-client denial, archived action suppression and a live readback after deployment. Keep the archive restriction in place if any surface diverges.

This contract is preparatory evidence for the full Archive behavior. It does not accept Phases 8/9 or authorize a hosted change.
