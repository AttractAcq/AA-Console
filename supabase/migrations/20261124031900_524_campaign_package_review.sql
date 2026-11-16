-- Package review authorizes the exact internal preparation package only.
-- Publication, paid activation, page publish and agent enablement retain
-- their own separate external-action approvals.
create function public.register_campaign_preparation_review_v7()
returns trigger language plpgsql security definer
set search_path=pg_catalog,public as $$
begin
  perform public.register_approval_request_v6(jsonb_build_object(
    'client_id',new.client_id,'source_system','aa_console',
    'source_kind','campaign_preparation_package','source_id',new.id::text,
    'source_version',new.snapshot_hash,'artifact_hash',new.snapshot_hash,
    'title','Campaign preparation package v' || new.version::text,
    'preview',new.snapshot,'destination','campaign_factory:prepared_package',
    'scope',jsonb_build_object('client_id',new.client_id,
      'campaign_id',new.campaign_id,'package_id',new.id,'run_id',new.run_id,
      'version',new.version,'snapshot_hash',new.snapshot_hash),
    'owner_role','admin_or_active_client_manager',
    'requested_by',new.assembled_by,'requester_kind','human',
    'expires_at',now()+interval '7 days',
    'owning_path','/clients/' || new.client_id::text ||
      '/delivery/campaign-factory?campaign=' || new.campaign_id::text));
  return new;
end $$;
create trigger campaign_preparation_inbox_request_v7
  after insert on public.campaign_preparation_packages_v7
  for each row execute function public.register_campaign_preparation_review_v7();
revoke all on function public.register_campaign_preparation_review_v7()
  from public,anon,authenticated,service_role;

create function public.campaign_preparation_review_source_state_v7(p_request_id uuid)
returns text language plpgsql stable security definer
set search_path=pg_catalog,public as $$
declare
  r public.approval_requests_v6%rowtype;
  p public.campaign_preparation_packages_v7%rowtype;
begin
  select * into r from public.approval_requests_v6 where id=p_request_id;
  if r.id is null or r.source_system<>'aa_console'
     or r.source_kind<>'campaign_preparation_package' then return 'unverified'; end if;
  if auth.role()<>'service_role' and (auth.role()<>'authenticated'
      or not public.can_review_approval_request_v6(r.client_id,r.owner_role)) then
    return 'unverified';
  end if;
  if r.source_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    then return 'unverified'; end if;
  select * into p from public.campaign_preparation_packages_v7
    where id=r.source_id::uuid;
  if p.id is null then return 'cancelled'; end if;
  if p.client_id is distinct from r.client_id
    or p.snapshot_hash is distinct from r.source_version
    or p.snapshot_hash is distinct from r.artifact_hash
    or p.snapshot is distinct from r.preview
    or r.destination is distinct from 'campaign_factory:prepared_package'
    or r.scope is distinct from jsonb_build_object('client_id',p.client_id,
      'campaign_id',p.campaign_id,'package_id',p.id,'run_id',p.run_id,
      'version',p.version,'snapshot_hash',p.snapshot_hash) then
    return 'superseded';
  end if;
  if not public.campaign_preparation_package_current_v7(p.id) then
    return 'superseded';
  end if;
  return 'pending';
end $$;
revoke all on function public.campaign_preparation_review_source_state_v7(uuid)
  from public,anon;
grant execute on function public.campaign_preparation_review_source_state_v7(uuid)
  to authenticated,service_role;

create function public.decide_campaign_preparation_package_v7(
  p_package_id uuid,p_request_id uuid,p_approved boolean,p_reason text default null
) returns uuid language plpgsql volatile security definer
set search_path=pg_catalog,public as $$
declare
  p public.campaign_preparation_packages_v7%rowtype;
  r public.approval_requests_v6%rowtype;
  v_decision text;
begin
  if p_approved is null then raise exception 'Choose a review decision.'; end if;
  select * into p from public.campaign_preparation_packages_v7
    where id=p_package_id for share;
  select * into r from public.approval_requests_v6 where id=p_request_id;
  if p.id is null or r.id is null or r.source_id<>p.id::text
     or r.client_id<>p.client_id or r.source_kind<>'campaign_preparation_package'
     or r.source_version<>p.snapshot_hash then
    raise exception 'The exact package request is unavailable.' using errcode='23514';
  end if;
  if public.campaign_preparation_review_source_state_v7(r.id)<>'pending'
     or not exists(select 1 from public.approval_inbox_v6 i
       where i.id=r.id and i.status='pending' and i.preview_blocker is null) then
    raise exception 'The package has changed or is not reviewable.' using errcode='23514';
  end if;
  v_decision:=case when p_approved then 'approved' else 'rejected' end;
  return public.record_approval_decision_v6(r.id,v_decision,p.snapshot_hash,
    'campaign_preparation_package:' || p.id::text,p_reason);
end $$;
revoke all on function public.decide_campaign_preparation_package_v7(uuid,uuid,boolean,text)
  from public,anon,service_role;
grant execute on function public.decide_campaign_preparation_package_v7(uuid,uuid,boolean,text)
  to authenticated;

create function public.campaign_preparation_approved_v7(p_package_id uuid)
returns boolean language plpgsql stable security definer
set search_path=pg_catalog,public as $$
declare p public.campaign_preparation_packages_v7%rowtype;
  r public.approval_requests_v6%rowtype;
  v_decision text;
begin
  select * into p from public.campaign_preparation_packages_v7 where id=p_package_id;
  if p.id is null then return false; end if;
  if auth.role() not in ('authenticated','service_role')
    or (auth.role()='authenticated' and not public.can_access_client(p.client_id)) then
    raise exception 'Package access required.' using errcode='42501';
  end if;
  if not public.campaign_preparation_package_current_v7(p.id) then return false; end if;
  select * into r from public.approval_requests_v6
    where source_system='aa_console' and source_kind='campaign_preparation_package'
      and source_id=p.id::text and source_version=p.snapshot_hash;
  if r.id is null then return false; end if;
  select d.decision into v_decision from public.approval_decision_events_v6 d
    where d.request_id=r.id order by d.event_order desc limit 1;
  return v_decision='approved';
end $$;
revoke all on function public.campaign_preparation_approved_v7(uuid)
  from public,anon;
grant execute on function public.campaign_preparation_approved_v7(uuid)
  to authenticated,service_role;
select public.lock_down_definer_functions();
