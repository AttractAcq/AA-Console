-- Evidence labels for commercial results tied to one v5 outcome run.
-- Unknown and estimated remain visible; neither is counted as observed.
alter table workflow_runs add column review_ready_at timestamptz;

create function stamp_workflow_review_ready_at() returns trigger
language plpgsql as $$
begin
  if new.status = 'awaiting_human_approval' and old.review_ready_at is null then
    new.review_ready_at := now();
  end if;
  return new;
end;
$$;
create trigger workflow_review_ready_at before update on workflow_runs
  for each row execute function stamp_workflow_review_ready_at();

create table workflow_lead_attribution (
  run_id uuid not null references workflow_runs(id) on delete cascade,
  lead_id uuid not null references client_leads(id) on delete cascade,
  label text not null check (label in ('observed', 'estimated', 'unknown')),
  evidence jsonb not null check (jsonb_typeof(evidence) = 'object'),
  recorded_at timestamptz not null default now(),
  primary key (run_id, lead_id)
);
create index workflow_lead_attribution_lead_idx on workflow_lead_attribution (lead_id);
alter table workflow_lead_attribution enable row level security;
create policy workflow_lead_attribution_read on workflow_lead_attribution for select to authenticated
  using (exists (select 1 from workflow_runs r where r.id = run_id
    and can_access_client(r.client_id)));
grant select on workflow_lead_attribution to authenticated;

create function record_workflow_lead_attribution(
  p_run_id uuid, p_lead_id uuid, p_label text, p_evidence jsonb
) returns workflow_lead_attribution
language plpgsql security definer set search_path to 'public' as $$
declare v_run workflow_runs; v_lead client_leads; v_link workflow_lead_attribution;
  v_observed boolean;
begin
  if auth.role() <> 'service_role' then raise exception 'AUTH: service role required'; end if;
  select * into v_run from workflow_runs where id = p_run_id;
  select * into v_lead from client_leads where id = p_lead_id;
  if v_run.id is null or v_lead.id is null or v_run.client_id <> v_lead.client_id then
    raise exception 'Run and lead must belong to the same real client.';
  end if;
  if p_label not in ('observed', 'estimated', 'unknown')
     or p_evidence is null or jsonb_typeof(p_evidence) <> 'object' then
    raise exception 'A valid attribution label and evidence object are required.';
  end if;
  v_observed :=
    exists (select 1 from workflow_artifacts a
      where a.run_id = p_run_id and a.artifact_kind = 'asset'
        and ((p_evidence->>'source' = 'asset'
          and p_evidence->>'source_id' = a.record_id::text
          and a.record_id = v_lead.source_asset_id)
        or (p_evidence->>'source' = 'post'
          and p_evidence->>'source_id' = v_lead.source_post_id::text
          and exists (select 1 from scheduled_posts sp where sp.id = v_lead.source_post_id
            and sp.asset_id = a.record_id))))
    or (v_run.kind = 'client_launch_package' and exists (
      select 1 from campaign_artifacts a
      where a.campaign_id = v_run.campaign_id
        and ((p_evidence->>'source' = 'page'
          and p_evidence->>'source_id' = a.page_id::text
          and a.page_id = v_lead.source_page_id)
          or (p_evidence->>'source' = 'asset'
          and p_evidence->>'source_id' = a.asset_id::text
          and a.asset_id = v_lead.source_asset_id))))
    or (v_run.kind = 'client_launch_package' and exists (
      select 1 from client_campaigns c where c.id = v_run.campaign_id
        and c.ad_campaign_id is not null
        and p_evidence->>'source' = 'campaign'
        and p_evidence->>'source_id' = c.ad_campaign_id::text
        and c.ad_campaign_id = v_lead.source_campaign_id));
  if p_label = 'observed' and not v_observed then
    raise exception 'Observed attribution needs a linked source record and source evidence.';
  end if;
  if p_label = 'estimated' and (
    nullif(btrim(coalesce(p_evidence->>'method', '')), '') is null
    or jsonb_typeof(p_evidence->'source_ids') is distinct from 'array'
    or jsonb_array_length(p_evidence->'source_ids') = 0) then
    raise exception 'Estimated attribution needs a method and source IDs.';
  end if;
  if p_label = 'unknown' and nullif(btrim(coalesce(p_evidence->>'reason', '')), '') is null then
    raise exception 'Unknown attribution needs a reason.';
  end if;
  insert into workflow_lead_attribution (run_id, lead_id, label, evidence)
  values (p_run_id, p_lead_id, p_label, p_evidence)
  on conflict (run_id, lead_id) do nothing returning * into v_link;
  if not found then
    select * into v_link from workflow_lead_attribution
      where run_id = p_run_id and lead_id = p_lead_id;
    if v_link.label <> p_label or v_link.evidence <> p_evidence then
      raise exception 'idempotency_conflict';
    end if;
  end if;
  return v_link;
end;
$$;

create function workflow_run_outcomes(p_run_id uuid) returns jsonb
language plpgsql stable security definer set search_path to 'public' as $$
declare v_run workflow_runs; v_jobs record; v_leads record;
  v_assets integer; v_accepted integer; v_rejections integer;
begin
  select * into v_run from workflow_runs where id = p_run_id;
  if not found then raise exception 'No such workflow run.'; end if;
  if auth.role() <> 'service_role' and not can_access_client(v_run.client_id) then
    raise exception 'Not permitted for this client.';
  end if;
  select count(*)::integer as jobs, coalesce(sum(cost_usd), 0)::numeric as cost_usd,
    count(*) filter (where status = 'failed')::integer as failed_jobs
    into v_jobs from agent_jobs where run_id = p_run_id;
  select count(*)::integer into v_assets from workflow_artifacts
    where run_id = p_run_id and artifact_kind = 'asset';
  select count(*)::integer into v_accepted from workflow_artifacts a
    join client_media_assets m on m.id = a.record_id
    where a.run_id = p_run_id and a.artifact_kind = 'asset'
      and m.human_approved_at is not null;
  select count(*)::integer into v_rejections from workflow_artifacts a
    join client_asset_reviews r on r.asset_id = a.record_id
    where a.run_id = p_run_id and a.artifact_kind = 'asset'
      and r.decision = 'rejected';
  select count(*)::integer as leads,
    count(*) filter (where a.label = 'observed')::integer as observed,
    count(*) filter (where a.label = 'estimated')::integer as estimated,
    count(*) filter (where a.label = 'unknown')::integer as unknown,
    coalesce(sum(l.cash_collected) filter (where a.label = 'observed'), 0)::numeric as observed_cash,
    coalesce(sum(l.cash_collected) filter (where a.label = 'estimated'), 0)::numeric as estimated_cash
    into v_leads from workflow_lead_attribution a
    join client_leads l on l.id = a.lead_id where a.run_id = p_run_id;
  return jsonb_build_object(
    'run_id', p_run_id, 'kind', v_run.kind, 'status', v_run.status,
    'deadline_at', v_run.deadline_at,
    'review_ready_at', v_run.review_ready_at,
    'deadline_met', case when v_run.review_ready_at is not null
      then v_run.review_ready_at <= v_run.deadline_at else null end,
    'job_count', v_jobs.jobs, 'failed_jobs', v_jobs.failed_jobs,
    'total_job_cost_usd', v_jobs.cost_usd,
    'accepted_asset_versions', v_assets,
    'human_approved_assets', v_accepted,
    'rejection_events', v_rejections,
    'linked_leads', v_leads.leads, 'observed_leads', v_leads.observed,
    'estimated_leads', v_leads.estimated, 'unknown_leads', v_leads.unknown,
    'attribution_coverage', case when v_leads.leads = 0 then null
      else round(v_leads.observed::numeric / v_leads.leads, 4) end,
    'observed_cash', case when v_leads.leads = 0 then null else v_leads.observed_cash end,
    'estimated_cash', case when v_leads.leads = 0 then null else v_leads.estimated_cash end);
end;
$$;

revoke all on function record_workflow_lead_attribution(uuid, uuid, text, jsonb)
  from public, anon, authenticated;
revoke all on function workflow_run_outcomes(uuid) from public, anon;
grant execute on function record_workflow_lead_attribution(uuid, uuid, text, jsonb)
  to service_role;
grant execute on function workflow_run_outcomes(uuid) to authenticated, service_role;
select lock_down_definer_functions();
