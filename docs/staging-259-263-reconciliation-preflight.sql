-- B002 staging-only reconciliation preflight. READ ONLY.
-- Run EACH SELECT separately against the pinned staging project
-- vmmertwoboqiazcsougw through the Supabase Management API
-- /database/query/read-only endpoint with a fine-grained Database Read PAT.
-- Do not run this file through a write-capable SQL editor or add DML/DDL.
-- The outputs contain counts and catalog definitions, never customer rows.
-- Repeat against production bancbdztffokwiifzoiv for comparison where noted.

-- P01. Verify connection identity. The API path/ref and token scope are the
-- primary guard; current_database alone does not identify a Supabase project.
select current_database() as database_name,
       current_user as database_role,
       current_setting('server_version') as postgres_version
;

-- P02. Record history versions and whether stored SQL exists. NULL statements
-- cannot prove that an alternate timestamp applied the tracked source bytes.
select version, name,
       statements is null as sql_payload_unavailable,
       case when statements is null then null else cardinality(statements) end as statement_count
  from supabase_migrations.schema_migrations
 where version in (
   '20261025233000', '20261025235000', '20261025240000', '20261025250000',
   '20261029120000', '20261029130000', '20261029140000'
 )
    or name like '259_%' or name like '260_%'
 order by version
;

-- P03. Aggregate history completeness without returning any SQL body.
select count(*) as migration_count,
       max(version) as migration_head,
       count(*) filter (where statements is null) as unavailable_sql_payloads
  from supabase_migrations.schema_migrations
;

-- P04. Data-preservation gate. This query deliberately fails if an expected
-- table is absent; an unknown count is a stop, not a zero. No IDs are read.
select (select count(*) from public.clients) as clients,
       (select count(*) from public.client_campaigns) as client_campaigns,
       (select count(*) from public.campaign_manifest_versions) as campaign_manifest_versions,
       (select count(*) from public.google_ads_build_sheets) as google_ads_build_sheets,
       (select count(*) from public.google_ads_copy) as google_ads_copy,
       (select count(*) from public.google_ads_builds) as google_ads_builds,
       (select count(*) from public.campaign_action_approvals) as campaign_action_approvals,
       (select count(*) from public.campaign_action_executions) as campaign_action_executions,
       (select count(*) from public.client_integrations) as client_integrations,
       (select count(*) from public.agent_runtime_heartbeats) as agent_runtime_heartbeats
;

-- P05. Auth users are separate from public tables. Preserve these accounts.
-- If Database Read lacks access, record UNKNOWN and stop any reset proposal.
select count(*) as auth_users from auth.users
;

-- P06. The external Google action must remain off throughout reconciliation.
select action_key, supported, executor_module
  from public.campaign_action_executors
 where action_key = 'google_ad_build'
;

-- P07. Count enabled campaign-action switches; do not return client identity.
select count(*) as engine_settings,
       count(*) filter (where campaign_actions_enabled) as enabled_campaign_action_settings
  from public.client_engine_settings
;

-- P08. Exact-column inventory for the reviewed 260 delta. Missing/extra
-- columns must be interpreted with P09 and the checked-in migration.
select n.nspname as schema_name, c.relname as table_name,
       a.attname as column_name, pg_catalog.format_type(a.atttypid, a.atttypmod) as data_type,
       a.attnotnull as not_null
  from pg_catalog.pg_attribute a
  join pg_catalog.pg_class c on c.oid = a.attrelid
  join pg_catalog.pg_namespace n on n.oid = c.relnamespace
 where n.nspname = 'public'
   and c.relname in (
     'google_ads_build_sheets', 'google_ads_copy', 'google_ads_builds',
     'campaign_action_approvals', 'client_integrations'
   )
   and a.attnum > 0 and not a.attisdropped
 order by table_name, a.attnum
;

-- P09. Exact constraint and validation inventory. Compare this output with
-- reviewed 260; the old simple FKs must be replaced by same-client composite
-- FKs only after affected-row counts and referential checks pass.
select n.nspname as schema_name, c.relname as table_name,
       k.conname as constraint_name, k.contype as constraint_type,
       k.convalidated as validated,
       pg_catalog.pg_get_constraintdef(k.oid, true) as definition
  from pg_catalog.pg_constraint k
  join pg_catalog.pg_class c on c.oid = k.conrelid
  join pg_catalog.pg_namespace n on n.oid = c.relnamespace
 where n.nspname = 'public'
   and c.relname in (
     'google_ads_build_sheets', 'google_ads_copy', 'google_ads_builds',
     'campaign_action_approvals', 'client_integrations'
   )
 order by table_name, constraint_name
;

-- P10. Function lineage fingerprints. Function definitions are hashed in SQL,
-- so no executable body or secret-bearing source is returned. Run against
-- staging and production, then compare signatures and hashes.
select n.nspname as schema_name,
       p.oid::pg_catalog.regprocedure::text as function_signature,
       md5(pg_catalog.pg_get_functiondef(p.oid)) as definition_md5
  from pg_catalog.pg_proc p
  join pg_catalog.pg_namespace n on n.oid = p.pronamespace
 where n.nspname in ('public', 'mcp_internal')
   and p.proname in (
     'client_for_meta_recipient_v6', 'close_dm_conversation_v6',
     'merge_dm_lead_v6', 'record_google_ads_sheet_v6',
     'record_google_ads_sheet_for_manifest_v6', 'all_within_length',
     'guard_google_ads_build_identity_v6', 'google_ads_build_spec_v6',
     'request_campaign_google_build_v6', 'start_google_build_v6',
     'record_google_build_progress_v6', 'record_google_build_finished_v6',
     'system_readiness_catalog', 'prune_agent_runtime_heartbeats',
     'handle_new_user', 'create_console_user', 'assign_production'
   )
 order by schema_name, function_signature
;

-- P11. View definition fingerprints. A missing view returns NULL.
select 'public.google_ads_build_due' as view_name,
       md5(pg_catalog.pg_get_viewdef(pg_catalog.to_regclass('public.google_ads_build_due'), true)) as definition_md5
union all
select 'public.agent_runtime_status' as view_name,
       md5(pg_catalog.pg_get_viewdef(pg_catalog.to_regclass('public.agent_runtime_status'), true)) as definition_md5
;

-- P12. Guard/updated-at trigger inventory on the Google build table.
select c.relname as table_name, t.tgname as trigger_name,
       t.tgenabled as enabled,
       md5(pg_catalog.pg_get_triggerdef(t.oid, true)) as definition_md5
  from pg_catalog.pg_trigger t
  join pg_catalog.pg_class c on c.oid = t.tgrelid
  join pg_catalog.pg_namespace n on n.oid = c.relnamespace
 where n.nspname = 'public' and c.relname = 'google_ads_builds'
   and not t.tgisinternal
 order by trigger_name
;

-- P13. Older ensure_rls difference. Return tags and the handler hash without
-- invoking the event trigger. An empty tag list means all command tags.
select e.evtname, e.evtevent, e.evtenabled, e.evttags,
       md5(pg_catalog.pg_get_functiondef(e.evtfoid)) as handler_md5
  from pg_catalog.pg_event_trigger e
 where e.evtname = 'ensure_rls'
;

-- P14. Indexes involved in reviewed 260 and 261, with no table rows.
select c.relname as table_name, i.relname as index_name,
       md5(pg_catalog.pg_get_indexdef(i.oid)) as definition_md5
  from pg_catalog.pg_index x
  join pg_catalog.pg_class c on c.oid = x.indrelid
  join pg_catalog.pg_namespace n on n.oid = c.relnamespace
  join pg_catalog.pg_class i on i.oid = x.indexrelid
 where n.nspname = 'public'
   and c.relname in (
     'google_ads_build_sheets', 'google_ads_copy', 'google_ads_builds',
     'campaign_action_approvals', 'agent_runtime_heartbeats'
   )
 order by table_name, index_name
;

-- P15. Cron metadata only; run after confirming pg_cron is installed. This
-- returns no command body. A missing cron.job is a stop for 262 planning.
select jobname, schedule, active
  from cron.job
 where jobname = 'prune-runtime-heartbeats'
;

-- P16. The reviewed 260 helper rejects a NULL array element. Earlier
-- staging behavior accepted it. This SELECT has no writes.
select public.all_within_length(array[null::text], 30) as null_element_accepted
;

-- P17. Existing same-client relationships must be valid before stronger
-- composite FKs are considered. Counts only, no campaign or client IDs.
select (select count(*) from public.google_ads_copy cp
         left join public.client_campaigns c on c.id = cp.campaign_id
        where c.id is null or c.client_id is distinct from cp.client_id) as copy_campaign_client_mismatches,
       (select count(*) from public.google_ads_builds b
         left join public.client_campaigns c on c.id = b.campaign_id
        where c.id is null or c.client_id is distinct from b.client_id) as build_campaign_client_mismatches,
       (select count(*) from public.google_ads_builds b
         left join public.google_ads_build_sheets s on s.id = b.sheet_id
        where s.id is null or s.client_id is distinct from b.client_id
           or s.campaign_id is distinct from b.campaign_id) as build_sheet_mismatches,
       (select count(*) from public.google_ads_builds b
         left join public.campaign_action_approvals a on a.id = b.approval_id
        where a.id is null or a.client_id is distinct from b.client_id
           or a.campaign_id is distinct from b.campaign_id) as build_approval_mismatches
;
