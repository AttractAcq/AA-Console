-- Paid and organic are the same API and the same token model, but they are
-- not the same account: Ads Insights is addressed by act_<id> and
-- Instagram insights by the IG user id. credential_label holds one id, so
-- each surface gets its own integration row rather than trying to encode
-- two ids in one field.
--
--   surface 'paid'    -> provider 'meta'
--   surface 'organic' -> provider 'instagram'
--
-- Without this the organic pull would call the IG endpoints with an ad
-- account id and fail for every client, every day.

create or replace function enqueue_metrics_ingest_jobs(p_days integer default 7)
returns integer
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_count integer;
  v_since date := current_date - greatest(coalesce(p_days, 7), 1);
  v_until date := current_date;
begin
  insert into agent_jobs (agent_key, client_id, params)
  select 'metrics_ingest',
         ci.client_id,
         jsonb_build_object('surface', s.surface, 'since', v_since, 'until', v_until)
    from client_integrations ci
    join (values ('meta', 'paid'), ('instagram', 'organic')) as s(provider, surface)
      on s.provider = ci.provider
   where ci.status = 'active'
     and ci.ingest_enabled = true
     and ci.credential_secret_id is not null
     and not exists (
       select 1 from agent_jobs j
        where j.agent_key = 'metrics_ingest'
          and j.client_id = ci.client_id
          and j.params->>'surface' = s.surface
          and j.status in ('queued', 'claimed', 'running')
     );

  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

revoke all on function enqueue_metrics_ingest_jobs(integer) from public, anon, authenticated;
grant execute on function enqueue_metrics_ingest_jobs(integer) to service_role;

comment on function enqueue_metrics_ingest_jobs(integer) is
  'Enqueues a trailing-window metrics pull per client per surface, for integrations with ingest_enabled. meta -> paid, instagram -> organic. Pure INSERT; driven by pg_cron.';;
