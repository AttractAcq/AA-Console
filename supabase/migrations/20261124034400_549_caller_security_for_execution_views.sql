-- Execution and evidence views must apply the caller's table RLS policies.
-- These were created without security_invoker in earlier pending migrations.
alter view public.gateway_tool_execution_overview_v6 set (security_invoker = true);
alter view public.google_reply_execution_overview_v6 set (security_invoker = true);
alter view public.google_profile_execution_overview_v6 set (security_invoker = true);
alter view public.meta_profile_execution_overview_v6 set (security_invoker = true);
alter view public.client_external_outcomes_v6 set (security_invoker = true);
alter view public.campaign_budget_readback_overview_v6 set (security_invoker = true);
alter view public.campaign_page_readback_overview_v6 set (security_invoker = true);
alter view public.campaign_proof_release_observations_v6 set (security_invoker = true);
alter view public.campaign_lead_enrolment_source_v6 set (security_invoker = true);
alter view public.campaign_proof_retraction_status_v6 set (security_invoker = true);
alter view public.proof_approval_execution_evidence_v6 set (security_invoker = true);
alter view public.lead_magnet_approval_execution_evidence_v6 set (security_invoker = true);
alter view public.proof_outcome_followup_submissions_v7 set (security_invoker = true);
