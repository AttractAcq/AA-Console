-- An immutable, exact-output package for a human to inspect. Assembly is an
-- internal action; it never authorizes publication or any provider write.
create table public.campaign_preparation_packages_v7 (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null,
  campaign_id uuid not null,
  run_id uuid not null unique references public.workflow_runs(id) on delete restrict,
  version integer not null check (version>0),
  snapshot jsonb not null check (jsonb_typeof(snapshot)='object'),
  snapshot_hash text not null check (snapshot_hash ~ '^[0-9a-f]{64}$'),
  assembled_by uuid references public.profiles(id) on delete set null,
  assembled_at timestamptz not null default now(),
  foreign key(campaign_id,client_id) references public.client_campaigns(id,client_id)
    on delete restrict,
  unique(campaign_id,version)
);
create index campaign_preparation_packages_client_v7
  on public.campaign_preparation_packages_v7(client_id,campaign_id,version desc);
create trigger campaign_preparation_packages_append_only_v7
  before update or delete on public.campaign_preparation_packages_v7
  for each row execute function public.reject_approval_ledger_mutation_v6();
alter table public.campaign_preparation_packages_v7 enable row level security;
create policy campaign_preparation_packages_read_v7
  on public.campaign_preparation_packages_v7 for select to authenticated
  using(public.can_access_client(client_id));
revoke all on public.campaign_preparation_packages_v7 from public,anon,authenticated;
grant select on public.campaign_preparation_packages_v7 to authenticated;
grant all on public.campaign_preparation_packages_v7 to service_role;

create function public.campaign_preparation_snapshot_v7(p_campaign_id uuid)
returns jsonb language plpgsql stable security definer
set search_path=pg_catalog,public as $$
declare
  c public.client_campaigns%rowtype;
  v_readiness jsonb;
  v_run uuid;
  v_routes jsonb;
  v_outputs jsonb;
begin
  select * into c from public.client_campaigns where id=p_campaign_id;
  if c.id is null then raise exception 'Campaign unavailable.' using errcode='P0001'; end if;
  if auth.role() not in ('authenticated','service_role')
    or (auth.role()='authenticated' and not public.can_access_client(c.client_id)) then
    raise exception 'Campaign access required.' using errcode='42501';
  end if;
  v_readiness:=public.campaign_package_readiness_v7(c.id);
  if v_readiness->>'status'<>'ready_for_review' then return null; end if;
  v_run:=(v_readiness->>'run_id')::uuid;
  select jsonb_agg(jsonb_build_object('id',r.id,'route',r.route,
    'version',r.version,'paid_platform',r.paid_platform,
    'plan_fingerprint',r.plan_fingerprint) order by r.route)
    into v_routes
  from public.campaign_route_packages_v6 r
  where r.campaign_id=c.id and r.id in (
    select w.route_package_id from public.delivery_work_items_v6 w
    where w.campaign_id=c.id and w.input_snapshot->>'workflow_run_id'=v_run::text
      and w.route_package_id is not null);
  select jsonb_agg(jsonb_build_object(
    'work_item_id',w.id,'item_key',w.item_key,'route_key',w.route_key,
    'route_package_id',w.route_package_id,'work_version',w.work_version,
    'owner_module',w.owner_module,'input_fingerprint',w.input_fingerprint,
    'expected_output',w.expected_output,'output_fingerprint',w.output_fingerprint,
    'output_refs',w.output_refs) order by
      case when w.owner_module='content_production_factory' then 0
        when w.owner_module='website_studio' then 1 else 2 end,
      w.item_key)
    into v_outputs
  from public.delivery_work_items_v6 w
  where w.campaign_id=c.id and w.client_id=c.client_id and w.required
    and w.input_snapshot->>'workflow_run_id'=v_run::text
    and w.owner_module in ('content_production_factory','website_studio','sales_os');
  if jsonb_array_length(coalesce(v_outputs,'[]'::jsonb))
      <> (v_readiness->>'expected')::integer then
    return null;
  end if;
  return jsonb_build_object('client_id',c.client_id,'campaign_id',c.id,
    'run_id',v_run,'plan_fingerprint',public.campaign_plan_fingerprint(c),
    'content_spec_id',c.content_spec_id,'content_spec_hash',c.content_spec_hash,
    'offer_version_id',c.offer_version_id,'routes',coalesce(v_routes,'[]'::jsonb),
    'outputs',v_outputs);
end $$;
revoke all on function public.campaign_preparation_snapshot_v7(uuid) from public,anon;
grant execute on function public.campaign_preparation_snapshot_v7(uuid)
  to authenticated,service_role;

create function public.assemble_campaign_preparation_package_v7(p_campaign_id uuid)
returns public.campaign_preparation_packages_v7
language plpgsql volatile security definer
set search_path=pg_catalog,public as $$
declare
  c public.client_campaigns%rowtype;
  v_snapshot jsonb;
  v_hash text;
  v_existing public.campaign_preparation_packages_v7%rowtype;
begin
  select * into c from public.client_campaigns where id=p_campaign_id for update;
  if c.id is null then raise exception 'Campaign unavailable.' using errcode='P0001'; end if;
  if auth.role()<>'authenticated' or auth.uid() is null
     or public.current_role_of() is null or not public.can_access_client(c.client_id) then
    raise exception 'A client operator must assemble the package.' using errcode='42501';
  end if;
  v_snapshot:=public.campaign_preparation_snapshot_v7(c.id);
  if v_snapshot is null then
    raise exception 'The current sweep is not ready for package review.' using errcode='23514';
  end if;
  v_hash:=encode(sha256(convert_to(v_snapshot::text,'UTF8')),'hex');
  select * into v_existing from public.campaign_preparation_packages_v7
    where run_id=(v_snapshot->>'run_id')::uuid;
  if found then
    if v_existing.snapshot_hash<>v_hash or v_existing.snapshot<>v_snapshot then
      raise exception 'This sweep already has a different frozen package.' using errcode='23514';
    end if;
    return v_existing;
  end if;
  insert into public.campaign_preparation_packages_v7
    (client_id,campaign_id,run_id,version,snapshot,snapshot_hash,assembled_by)
  values(c.client_id,c.id,(v_snapshot->>'run_id')::uuid,
    coalesce((select max(version)+1 from public.campaign_preparation_packages_v7
      where campaign_id=c.id),1),v_snapshot,v_hash,auth.uid())
  returning * into v_existing;
  return v_existing;
end $$;
revoke all on function public.assemble_campaign_preparation_package_v7(uuid)
  from public,anon,service_role;
grant execute on function public.assemble_campaign_preparation_package_v7(uuid)
  to authenticated;

create function public.campaign_preparation_package_current_v7(p_package_id uuid)
returns boolean language plpgsql stable security definer
set search_path=pg_catalog,public as $$
declare p public.campaign_preparation_packages_v7%rowtype;
  current_snapshot jsonb;
begin
  select * into p from public.campaign_preparation_packages_v7 where id=p_package_id;
  if p.id is null then return false; end if;
  if auth.role() not in ('authenticated','service_role')
    or (auth.role()='authenticated' and not public.can_access_client(p.client_id)) then
    raise exception 'Package access required.' using errcode='42501';
  end if;
  current_snapshot:=public.campaign_preparation_snapshot_v7(p.campaign_id);
  return current_snapshot is not null and current_snapshot=p.snapshot
    and encode(sha256(convert_to(current_snapshot::text,'UTF8')),'hex')=p.snapshot_hash;
end $$;
revoke all on function public.campaign_preparation_package_current_v7(uuid)
  from public,anon;
grant execute on function public.campaign_preparation_package_current_v7(uuid)
  to authenticated,service_role;
select public.lock_down_definer_functions();
