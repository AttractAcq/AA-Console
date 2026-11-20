-- Campaign-bound Google handoffs must carry an explicit human keyword
-- research assignment. Search-copy generation does not perform that research.
begin;

create or replace function public.create_paid_operator_bundle_v7(
  p_package_id uuid,p_owner text,p_budget_instruction text,p_tracking_instruction text)
returns public.paid_operator_bundles_v7 language plpgsql volatile security definer
set search_path=pg_catalog,public as $$
declare p public.campaign_preparation_packages_v7%rowtype;
  v_source jsonb; v_snapshot jsonb; v_hash text;
  v_prior public.paid_operator_bundles_v7%rowtype;
begin
  select * into p from public.campaign_preparation_packages_v7 where id=p_package_id;
  if p.id is null then raise exception 'Reviewed preparation package required.' using errcode='23514'; end if;
  if auth.role()<>'authenticated' or auth.uid() is null
    or public.current_role_of() is null or not public.can_access_client(p.client_id) then
    raise exception 'Client operator required.' using errcode='42501';
  end if;
  if nullif(btrim(p_owner),'') is null or nullif(btrim(p_budget_instruction),'') is null
    or nullif(btrim(p_tracking_instruction),'') is null then
    raise exception 'Operator, budget instruction and tracking instruction are required.' using errcode='23514';
  end if;
  perform 1 from public.client_campaigns where id=p.campaign_id for update;
  v_source:=public.paid_operator_source_v7(p.id);
  if v_source is null then
    raise exception 'Approved current paid package with offer, audience, geography, budget and creative required.' using errcode='23514';
  end if;
  if v_source->>'platform'='google' then
    raise exception 'Google handoff requires an exact keyword research task.' using errcode='23514';
  end if;
  v_snapshot:=jsonb_build_object('source',v_source,'operator',btrim(p_owner),
    'budget_instruction',btrim(p_budget_instruction),
    'tracking_instruction',btrim(p_tracking_instruction));
  v_hash:=encode(sha256(convert_to(v_snapshot::text,'UTF8')),'hex');
  select * into v_prior from public.paid_operator_bundles_v7
    where package_id=p.id order by version desc limit 1;
  if v_prior.snapshot_hash=v_hash and v_prior.snapshot=v_snapshot then return v_prior; end if;
  insert into public.paid_operator_bundles_v7
    (client_id,campaign_id,package_id,platform,version,snapshot,snapshot_hash,created_by)
  values(p.client_id,p.campaign_id,p.id,v_source->>'platform',coalesce(v_prior.version+1,1),
    v_snapshot,v_hash,auth.uid()) returning * into v_prior;
  return v_prior;
end $$;

create function public.create_google_paid_operator_bundle_v7(
  p_package_id uuid,p_owner text,p_budget_instruction text,p_tracking_instruction text,
  p_research_task text)
returns public.paid_operator_bundles_v7 language plpgsql volatile security definer
set search_path=pg_catalog,public as $$
declare p public.campaign_preparation_packages_v7%rowtype;
  v_source jsonb; v_snapshot jsonb; v_hash text;
  v_prior public.paid_operator_bundles_v7%rowtype;
begin
  select * into p from public.campaign_preparation_packages_v7 where id=p_package_id;
  if p.id is null then raise exception 'Reviewed preparation package required.' using errcode='23514'; end if;
  if auth.role()<>'authenticated' or auth.uid() is null
    or public.current_role_of() is null or not public.can_access_client(p.client_id) then
    raise exception 'Client operator required.' using errcode='42501';
  end if;
  if nullif(btrim(p_owner),'') is null or nullif(btrim(p_budget_instruction),'') is null
    or nullif(btrim(p_tracking_instruction),'') is null
    or nullif(btrim(p_research_task),'') is null then
    raise exception 'Operator, budget, tracking and keyword research task are required.' using errcode='23514';
  end if;
  perform 1 from public.client_campaigns where id=p.campaign_id for update;
  v_source:=public.paid_operator_source_v7(p.id);
  if v_source is null or v_source->>'platform'<>'google' then
    raise exception 'Approved current Google paid package with offer, audience, geography, budget and copy required.' using errcode='23514';
  end if;
  v_snapshot:=jsonb_build_object('source',v_source,'operator',btrim(p_owner),
    'budget_instruction',btrim(p_budget_instruction),
    'tracking_instruction',btrim(p_tracking_instruction),
    'research_task',btrim(p_research_task),
    'consequence','Manual handoff only. Keyword research, paid activation and spend changes need their own human work and decisions.');
  v_hash:=encode(sha256(convert_to(v_snapshot::text,'UTF8')),'hex');
  select * into v_prior from public.paid_operator_bundles_v7
    where package_id=p.id order by version desc limit 1;
  if v_prior.snapshot_hash=v_hash and v_prior.snapshot=v_snapshot then return v_prior; end if;
  insert into public.paid_operator_bundles_v7
    (client_id,campaign_id,package_id,platform,version,snapshot,snapshot_hash,created_by)
  values(p.client_id,p.campaign_id,p.id,'google',coalesce(v_prior.version+1,1),
    v_snapshot,v_hash,auth.uid()) returning * into v_prior;
  return v_prior;
end $$;
revoke all on function public.create_google_paid_operator_bundle_v7(uuid,text,text,text,text)
  from public,anon,service_role;
grant execute on function public.create_google_paid_operator_bundle_v7(uuid,text,text,text,text)
  to authenticated;

select public.lock_down_definer_functions();
commit;

-- Older Google packets without the task stay held until a newly reviewed version exists.
begin;
create or replace function public.paid_operator_bundle_review_source_state_v7(p_request_id uuid)
returns text language plpgsql stable security definer
set search_path=pg_catalog,public as $$
declare q public.approval_requests_v6%rowtype;
  b public.paid_operator_bundles_v7%rowtype;
begin
  select * into q from public.approval_requests_v6 where id=p_request_id;
  if q.id is null or q.source_system<>'aa_console'
    or q.source_kind<>'paid_operator_bundle' then return 'unverified'; end if;
  if auth.role()<>'service_role' and (auth.role()<>'authenticated'
    or not public.can_review_approval_request_v6(q.client_id,q.owner_role)) then
    return 'unverified'; end if;
  if q.source_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    then return 'unverified'; end if;
  select * into b from public.paid_operator_bundles_v7 where id=q.source_id::uuid;
  if b.id is null then return 'cancelled'; end if;
  if b.client_id is distinct from q.client_id
    or b.snapshot_hash is distinct from q.source_version
    or b.snapshot_hash is distinct from q.artifact_hash
    or b.snapshot is distinct from q.preview
    or q.destination is distinct from b.platform||'_ads:manual_operator_handoff'
    or q.scope is distinct from jsonb_build_object('client_id',b.client_id,
      'campaign_id',b.campaign_id,'package_id',b.package_id,
      'bundle_id',b.id,'platform',b.platform,'version',b.version,
      'snapshot_hash',b.snapshot_hash)
    or not public.paid_operator_bundle_current_v7(b.id) then return 'superseded'; end if;
  if b.platform='google' and nullif(btrim(b.snapshot->>'research_task'),'') is null
    then return 'source_held'; end if;
  return 'pending';
end $$;
revoke all on function public.paid_operator_bundle_review_source_state_v7(uuid)
  from public,anon;
grant execute on function public.paid_operator_bundle_review_source_state_v7(uuid)
  to authenticated,service_role;

create or replace function public.paid_operator_bundle_approved_v7(p_bundle_id uuid)
returns boolean language plpgsql stable security definer
set search_path=pg_catalog,public as $$
declare b public.paid_operator_bundles_v7%rowtype;
  q public.approval_requests_v6%rowtype;
  v_decision text;
begin
  select * into b from public.paid_operator_bundles_v7 where id=p_bundle_id;
  if b.id is null then return false; end if;
  if b.platform='google' and nullif(btrim(b.snapshot->>'research_task'),'') is null
    then return false; end if;
  if not public.paid_operator_bundle_current_v7(b.id) then return false; end if;
  select * into q from public.approval_requests_v6
    where source_system='aa_console' and source_kind='paid_operator_bundle'
      and source_id=b.id::text and source_version=b.snapshot_hash;
  if q.id is null then return false; end if;
  select d.decision into v_decision from public.approval_decision_events_v6 d
    where d.request_id=q.id order by d.event_order desc limit 1;
  return coalesce(v_decision='approved',false);
end $$;
revoke all on function public.paid_operator_bundle_approved_v7(uuid)
  from public,anon;
grant execute on function public.paid_operator_bundle_approved_v7(uuid)
  to authenticated,service_role;

select public.lock_down_definer_functions();
commit;
