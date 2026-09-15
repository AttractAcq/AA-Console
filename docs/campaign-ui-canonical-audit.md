# Canonical campaign UI audit

## Surface inventory

Paths below use `:clientId` for the selected client. All operational reads now use `client_campaigns`; readiness is computed, never stored or dual-written.

| Route | Component | Before read | After read | Filter / purpose |
| --- | --- | --- | --- | --- |
| `/clients/:clientId/delivery/campaign-execution` (Overview tab) | CampaignExecutionPanel | client_campaigns + campaign_readiness | Same, with explicit query and readiness errors | client_id, all statuses, newest first; plan, content, provision, launch |
| `/client/active-campaigns` | ActiveCampaignsView in ClientViews | campaigns | client_campaigns | profile.client_id; display status=live only, count planning separately |
| `/operations?tab=campaigns` | CampaignsPanel | campaigns + campaign_totals; legacy insert form | client_campaigns + clients + campaign_readiness | cross-client; client and All / Planning / Ready to Launch / Live / Complete / Cancelled filters; execution links |
| `/clients/:clientId/delivery/economics` | ClientEconomicsPanel | campaigns selector; client_economics, client_economics_by_channel, client_economics_by_campaign | Same financial sources; labeled Ad spend tracker (legacy) | client_id + cohort dates; dated spend and attributed lead revenue, not operational readiness |
| `/clients/:clientId/delivery/reporting?tab=paid` | PaidReportingPanel / useMetrics | metrics_period_summary (metrics_daily LEFT JOIN campaigns) | Same; labeled Ad platform campaign | client_id + date window; measured advertising spend and results |
| `/clients/:clientId/delivery/intelligence?tab=campaign-intelligence` | CampaignIntelligencePanel / RecordWorkspace | client_agent_records, record_templates, agent_jobs | Same | client_id + campaign_intel domain; research records, not execution campaigns |
| Execution's Content production expander | CampaignContentPanel | client_ideas, campaign_artifacts, client_briefs, client_media_assets | Same | client_id + campaign_id, linked briefs/assets; idea → brief → asset flow |
| `/`, `/clients/:clientId/delivery/dashboard`, `/client/dashboard` | DashboardPanel, ClientDashboardPanel, ClientConsolePage | No campaign list/count query | Same | agency billing/client/team overview; delivery artifact counts and agent activity; client schedule/proof/approvals |
| Other Reporting tabs, Distribution/Marketing surfaces | OrganicReportingPanel, PagesReportingPanel, AttributionPanel, CommentaryPanel; OrganicPanel, PaidPanel | metrics summaries, attribution RPCs, agent records, distribution assets | Same | no operational campaign selector found |

Frontend campaign references were searched across src, including navigation, page routing and overview panels. The only remaining direct legacy campaign read is the explicitly labeled economics spend selector. Reporting also uses a legacy join indirectly.

## Attract Acquisition visibility

CoS supplied production evidence: client `e4b4b001-81f6-4997-8429-ff21f4ee1fbe` has 15 client_campaigns rows, all planning. This work did not query production or independently recount them.

Execution already uses `.from("client_campaigns").eq("client_id", clientId)` with no status filter. App.tsx nests the route under `clients/:clientId`, with `delivery/campaign-execution` generated from navigation. Therefore all 15 returned rows should render. Tests render 15 planning fixtures using this client ID. The old Operations and Active views queried a different table, so these records were not their source. After this change Operations includes planning by default; Active deliberately shows no live campaigns and the planning count.

Execution was broken in error handling: it ignored the Supabase error and converted null data to an empty list. Missing route identity also became empty. Both now produce errors; loading and successful emptiness are separate. Rejected requests are caught. Readiness errors keep campaign cards visible and disable launch for unchecked rows. Request sequencing prevents stale responses from overwriting a later refresh/client.

Migration 72 defines cc_admin_all using is_admin() and cc_client_read using is_client_user(client_id). The admin route is protected by RequireRole admin; client Active uses profile.client_id. No RLS changes are necessary based on the repository evidence. A SELECT filtered by RLS can return a successful empty array, which the browser cannot distinguish from genuine emptiness; explicit query/RPC errors are surfaced. If production Execution still appears empty, check the actual route UUID, authenticated profile/role and RLS policy installation, network response, then deployed bundle version. Production session, policy installation and stale bundle were not verified here; none is asserted as the observed cause.

## Legacy classification: C, partial overlap; financial domain still needed

Migration 14 models recruiting target_role, active/past, daily/total spend and historical dates. Migration 72 explicitly describes campaigns as an ad-platform spend tracker, distinct from operational plans. Dependencies remain:

- metrics_daily.campaign_id and metrics_period_summary's legacy join.
- client_leads.source_campaign_id for attribution.
- client_marketing_spend.campaign_id and client_economics_by_campaign.
- client_campaigns.ad_campaign_id as an optional existing reference.
- MCP campaign read interfaces still refer to legacy records (outside this frontend task).

Thus the table is not proven superseded or safe to delete. Financial UI concepts are renamed to distinguish them. The old recruiting Add Campaign form is removed from Operations; operational creation remains in Campaign Execution, reached through each campaign link. No replacement recruiting editor is introduced.

Gap: dated spend also has a client_campaign_id field, but existing economics groups spend and leads by legacy campaign IDs. Replacing that selector with operational IDs without changing attribution would corrupt semantics. A future financial-domain design must resolve this gap explicitly. No synchronization, duplicate records, dual-write, schema migration, legacy data deletion or stored ready status was introduced.

## Error audit and validation

Campaign Execution and the former Active query ignored errors: fixed. Operations previously ignored both campaign and totals errors: replaced by checked canonical reads. Economics previously checked only the headline RPC: now checks all four results and suppresses empty financial output on failure. Paid reporting already handles RPC errors; CampaignContentPanel already catches content-query errors. Generic agent-job monitoring and unrelated client organic/conversion views also contain data-only reads; they do not determine campaign list emptiness and are outside this campaign-source change.

Validation: full Vitest suite 351 tests across 28 files passed, including 27 campaign tests across three files; TypeScript/Vite build passed; oxlint passed with warnings (including the state reset in the new loading hook); git diff --check passed. Build reports a >500 kB chunk warning. Tests use mocked Supabase responses rendered into jsdom, not a production database. No authenticated browser screenshot was captured.
