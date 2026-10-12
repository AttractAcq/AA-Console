-- A launch package is ready for human activation only after verified
-- component evidence. It never calls launch_campaign or activates Meta spend.
create table client_launch_packages (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null unique references workflow_runs(id) on delete cascade,
  campaign_id uuid not null references client_campaigns(id) on delete cascade,
  client_id uuid not null references clients(id) on delete cascade,
  input_snapshot jsonb not null check (jsonb_typeof(input_snapshot) = 'object'),
  created_at timestamptz not null default now(),
  unique (campaign_id, run_id)
);

create table client_launch_checks (
  package_id uuid not null references client_launch_packages(id) on delete cascade,
  check_key text not null check (check_key in (
    'campaign_plan', 'brand_context', 'icp_context', 'proof_rights',
    'page', 'sales_agent', 'organic_creative', 'meta_handoff',
    'conversion_path', 'measurement')),
  status text not null check (status in ('needs_input', 'pending', 'pass', 'fail')),
  record_id uuid,
  evidence jsonb not null default '{}'::jsonb check (jsonb_typeof(evidence) = 'object'),
  blocker text,
  checked_at timestamptz,
  primary key (package_id, check_key)
);
create table client_launch_asset_checks (
  package_id uuid not null references client_launch_packages(id) on delete cascade,
  asset_id uuid not null references client_media_assets(id) on delete cascade,
  qa_evidence jsonb not null check (jsonb_typeof(qa_evidence) = 'object'),
  checked_at timestamptz not null default now(),
  primary key (package_id, asset_id)
);
create index client_launch_packages_client_idx on client_launch_packages (client_id, created_at desc);
alter table client_launch_packages enable row level security;
alter table client_launch_checks enable row level security;
alter table client_launch_asset_checks enable row level security;
create policy launch_packages_read on client_launch_packages for select to authenticated
  using (can_access_client(client_id));
create policy launch_checks_read on client_launch_checks for select to authenticated
  using (exists (select 1 from client_launch_packages p where p.id = package_id
    and can_access_client(p.client_id)));
create policy launch_asset_checks_read on client_launch_asset_checks for select to authenticated
  using (exists (select 1 from client_launch_packages p where p.id = package_id
    and can_access_client(p.client_id)));
grant select on client_launch_packages, client_launch_checks, client_launch_asset_checks to authenticated;

create function start_client_launch_package(
  p_campaign_id uuid, p_idempotency_key text, p_deadline_at timestamptz
) returns client_launch_packages
language plpgsql security definer set search_path to 'public' as $$
declare v_campaign client_campaigns; v_snapshot jsonb; v_run workflow_runs;
  v_package client_launch_packages; v_missing text[] := '{}';
  v_brand uuid; v_icp uuid; v_proof uuid; v_plan_ok boolean;
begin
  if auth.role() <> 'service_role' then raise exception 'AUTH: service role required'; end if;
  select * into v_campaign from client_campaigns where id = p_campaign_id;
  if not found then raise exception 'No such campaign.'; end if;
  if p_deadline_at is null or p_deadline_at <= now() then
    raise exception 'A future launch deadline is required.';
  end if;
  v_plan_ok := v_campaign.built_at is not null
    and nullif(btrim(v_campaign.audience), '') is not null
    and nullif(btrim(v_campaign.offer_summary), '') is not null
    and v_campaign.status in ('planning', 'live');
  select id into v_brand from client_agent_records where client_id = v_campaign.client_id
    and domain = 'brand_strategy' and nullif(btrim(body), '') is not null
    order by updated_at desc limit 1;
  select id into v_icp from client_agent_records where client_id = v_campaign.client_id
    and domain = 'icp' and nullif(btrim(body), '') is not null
    order by updated_at desc limit 1;
  select id into v_proof from client_proof_assets where client_id = v_campaign.client_id
    and usage_rights = 'approved' and (expires_on is null or expires_on >= current_date)
    order by strength desc nulls last, created_at desc limit 1;
  if not v_plan_ok then v_missing := array_append(v_missing, 'Campaign plan needs a built audience and offer.'); end if;
  if v_brand is null then v_missing := array_append(v_missing, 'Brand context is missing.'); end if;
  if v_icp is null then v_missing := array_append(v_missing, 'ICP context is missing.'); end if;
  if v_proof is null then v_missing := array_append(v_missing, 'Cleared proof is missing.'); end if;
  v_snapshot := jsonb_build_object(
    'campaign_id', v_campaign.id, 'campaign_name', v_campaign.name,
    'audience', v_campaign.audience, 'offer', v_campaign.offer_summary,
    'core_message', v_campaign.core_message, 'brand_record_id', v_brand,
    'icp_record_id', v_icp, 'proof_id', v_proof,
    'needs_landing_page', v_campaign.needs_landing_page,
    'needs_sales_agent', v_campaign.needs_sales_agent,
    'content_count', v_campaign.content_count);
  v_run := create_workflow_run(v_campaign.client_id, 'client_launch_package',
    'v5.launch.1', p_idempotency_key, v_snapshot, p_deadline_at, v_campaign.id);
  insert into client_launch_packages (run_id, campaign_id, client_id, input_snapshot)
  values (v_run.id, v_campaign.id, v_campaign.client_id, v_snapshot)
  on conflict (run_id) do nothing returning * into v_package;
  if not found then select * into v_package from client_launch_packages where run_id = v_run.id; end if;
  insert into client_launch_checks (package_id, check_key, status, record_id, evidence, blocker, checked_at)
  values
    (v_package.id, 'campaign_plan', case when v_plan_ok then 'pass' else 'needs_input' end,
      v_campaign.id, jsonb_build_object('built_at', v_campaign.built_at),
      case when v_plan_ok then null else 'Campaign plan needs a built audience and offer.' end, now()),
    (v_package.id, 'brand_context', case when v_brand is null then 'needs_input' else 'pass' end,
      v_brand, '{}'::jsonb, case when v_brand is null then 'Brand context is missing.' end, now()),
    (v_package.id, 'icp_context', case when v_icp is null then 'needs_input' else 'pass' end,
      v_icp, '{}'::jsonb, case when v_icp is null then 'ICP context is missing.' end, now()),
    (v_package.id, 'proof_rights', case when v_proof is null then 'needs_input' else 'pass' end,
      v_proof, '{}'::jsonb, case when v_proof is null then 'Cleared proof is missing.' end, now())
  on conflict (package_id, check_key) do nothing;
  insert into client_launch_checks (package_id, check_key, status)
  select v_package.id, unnest(array[
    'page', 'sales_agent', 'organic_creative', 'meta_handoff',
    'conversion_path', 'measurement']), 'pending'
  on conflict (package_id, check_key) do nothing;
  if v_run.status = 'pending' then
    update workflow_runs set status = case when array_length(v_missing, 1) > 0
        then 'needs_input' else 'needs_internal_qa' end,
      blocker = nullif(array_to_string(v_missing, ' '), ''), updated_at = now()
      where id = v_run.id;
  end if;
  return v_package;
end;
$$;

create function record_client_launch_asset_check(
  p_package_id uuid, p_asset_id uuid, p_qa_evidence jsonb
) returns client_launch_asset_checks
language plpgsql security definer set search_path to 'public' as $$
declare v_package client_launch_packages; v_check client_launch_asset_checks;
begin
  if auth.role() <> 'service_role' then raise exception 'AUTH: service role required'; end if;
  select * into v_package from client_launch_packages where id = p_package_id;
  if not found then raise exception 'No such launch package.'; end if;
  if p_qa_evidence is null or p_qa_evidence->>'result' is distinct from 'pass'
     or jsonb_typeof(p_qa_evidence->'checks') is distinct from 'array'
     or jsonb_array_length(p_qa_evidence->'checks') = 0 then
    raise exception 'An asset needs passing internal QA evidence.';
  end if;
  if not exists (select 1 from client_media_assets m
    join campaign_artifacts a on a.asset_id = m.id
    where m.id = p_asset_id and m.client_id = v_package.client_id
      and a.campaign_id = v_package.campaign_id
      and nullif(btrim(m.storage_path), '') is not null
      and (m.media_type <> 'video' or nullif(btrim(m.render_path), '') is not null)) then
    raise exception 'Asset is missing, unfinished or belongs to another campaign.';
  end if;
  insert into client_launch_asset_checks (package_id, asset_id, qa_evidence)
  values (p_package_id, p_asset_id, p_qa_evidence)
  on conflict (package_id, asset_id) do nothing returning * into v_check;
  if not found then
    select * into v_check from client_launch_asset_checks
      where package_id = p_package_id and asset_id = p_asset_id;
    if v_check.qa_evidence <> p_qa_evidence then raise exception 'idempotency_conflict'; end if;
  end if;
  return v_check;
end;
$$;

-- Evidence is scoped to the actual campaign's client. A checklist item cannot
-- be satisfied by a row from another client or by an empty QA assertion.
create function record_client_launch_check(
  p_package_id uuid, p_check_key text, p_record_id uuid, p_evidence jsonb
) returns client_launch_checks
language plpgsql security definer set search_path to 'public' as $$
declare v_package client_launch_packages; v_check client_launch_checks;
  v_ok boolean; v_run workflow_runs;
begin
  if auth.role() <> 'service_role' then raise exception 'AUTH: service role required'; end if;
  select * into v_package from client_launch_packages where id = p_package_id for update;
  if not found then raise exception 'No such launch package.'; end if;
  select * into v_run from workflow_runs where id = v_package.run_id for update;
  if v_run.status = 'needs_input' then raise exception 'Complete preflight inputs in a new package version.'; end if;
  if v_run.status not in ('needs_internal_qa', 'awaiting_human_approval') then
    raise exception 'Launch package is not accepting checks.';
  end if;
  if p_check_key not in ('page', 'sales_agent', 'organic_creative', 'meta_handoff',
      'conversion_path', 'measurement') or p_record_id is null
      or p_evidence is null or p_evidence->>'result' is distinct from 'pass'
      or jsonb_typeof(p_evidence->'checks') is distinct from 'array'
      or jsonb_array_length(p_evidence->'checks') = 0 then
    raise exception 'A dynamic launch check needs a record and passing evidence.';
  end if;
  -- The current page builder produces static HTML and the launch workflow has
  -- no trusted form/lead/consent/event probe. A caller-supplied list of labels
  -- cannot certify a working conversion path or unlock human approval.
  if p_check_key = 'conversion_path' then
    raise exception 'Conversion path requires a recorded end-to-end probe; checklist labels are not verification.';
  end if;
  v_ok := case p_check_key
    when 'page' then exists (select 1 from client_pages p
      join campaign_artifacts a on a.page_id = p.id
      where p.id = p_record_id and p.client_id = v_package.client_id
        and a.campaign_id = v_package.campaign_id and nullif(btrim(p.html), '') is not null)
    when 'sales_agent' then exists (select 1 from client_sales_agents s
      join campaign_artifacts a on a.sales_agent_id = s.id
      where s.id = p_record_id and s.client_id = v_package.client_id
        and a.campaign_id = v_package.campaign_id and s.built_at is not null
        and nullif(btrim(s.system_prompt), '') is not null)
    when 'organic_creative' then exists (select 1 from client_media_assets m
      join campaign_artifacts a on a.asset_id = m.id
      where m.id = p_record_id and m.client_id = v_package.client_id
        and a.campaign_id = v_package.campaign_id and nullif(btrim(m.storage_path), '') is not null)
      and (select count(*) from client_launch_asset_checks qa
        where qa.package_id = p_package_id)
        >= (select greatest(1, c.content_count) from client_campaigns c
          where c.id = v_package.campaign_id)
    when 'meta_handoff' then exists (select 1 from client_campaigns c
      where c.id = p_record_id and c.id = v_package.campaign_id
        and c.meta_campaign_id is not null)
    when 'conversion_path' then exists (select 1 from client_pages p
      join campaign_artifacts a on a.page_id = p.id
      where p.id = p_record_id and p.client_id = v_package.client_id
        and a.campaign_id = v_package.campaign_id)
    when 'measurement' then p_record_id = v_package.campaign_id
    else false end;
  if not v_ok then raise exception 'Evidence record is missing, unbuilt or belongs to another campaign.'; end if;
  update client_launch_checks set status = 'pass', record_id = p_record_id,
    evidence = p_evidence, blocker = null, checked_at = now()
    where package_id = p_package_id and check_key = p_check_key returning * into v_check;
  if not found then raise exception 'No such launch check.'; end if;
  if not exists (select 1 from client_launch_checks
    where package_id = p_package_id and status <> 'pass') then
    update workflow_runs set status = 'awaiting_human_approval', blocker = null,
      updated_at = now() where id = v_package.run_id;
  end if;
  return v_check;
end;
$$;

revoke all on function start_client_launch_package(uuid, text, timestamptz)
  from public, anon, authenticated;
revoke all on function record_client_launch_check(uuid, text, uuid, jsonb)
  from public, anon, authenticated;
revoke all on function record_client_launch_asset_check(uuid, uuid, jsonb)
  from public, anon, authenticated;
grant execute on function start_client_launch_package(uuid, text, timestamptz) to service_role;
grant execute on function record_client_launch_check(uuid, text, uuid, jsonb) to service_role;
grant execute on function record_client_launch_asset_check(uuid, uuid, jsonb) to service_role;
select lock_down_definer_functions();
