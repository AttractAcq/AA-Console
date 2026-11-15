-- A required magnet has durable, plan-bound work even before its file exists.
create table public.campaign_magnet_drafts_v7 (
  run_id uuid primary key references public.workflow_runs(id) on delete cascade,
  client_id uuid not null references public.clients(id) on delete cascade,
  campaign_id uuid not null references public.client_campaigns(id) on delete cascade,
  plan_fingerprint text not null check(plan_fingerprint ~ '^[0-9a-f]{32}$'),
  magnet_id uuid not null unique references public.lead_magnets(id) on delete restrict,
  work_item_id uuid not null unique references public.delivery_work_items_v6(id) on delete restrict,
  created_at timestamptz not null default now()
);
alter table public.campaign_magnet_drafts_v7 enable row level security;
create policy campaign_magnet_drafts_read_v7 on public.campaign_magnet_drafts_v7
  for select to authenticated using(public.can_access_client(client_id));
revoke all on public.campaign_magnet_drafts_v7 from public,anon,authenticated;
grant select on public.campaign_magnet_drafts_v7 to authenticated;
grant all on public.campaign_magnet_drafts_v7 to service_role;

create function public.ensure_campaign_magnet_draft_v7(
  p_campaign_id uuid,p_run_id uuid
) returns public.campaign_magnet_drafts_v7
language plpgsql volatile security definer set search_path=pg_catalog,public as $$
declare c public.client_campaigns%rowtype;
  r public.workflow_runs%rowtype;
  d public.campaign_magnet_drafts_v7%rowtype;
  w public.delivery_work_items_v6%rowtype;
  v_magnet uuid;
  v_version integer;
  v_hash text;
begin
  if auth.role()<>'service_role' then
    raise exception 'A trusted campaign worker is required.' using errcode='42501';
  end if;
  select * into c from public.client_campaigns where id=p_campaign_id for update;
  select * into r from public.workflow_runs where id=p_run_id for update;
  if c.id is null or r.id is null or r.client_id<>c.client_id
     or r.campaign_id is distinct from c.id or r.kind<>'campaign_sweep'
     or c.acquisition_mode='legacy' or not c.needs_lead_magnet
     or public.campaign_sweep_blocker_v6(c.id) is not null then
    raise exception 'A current approved magnet plan and matching sweep are required.'
      using errcode='23514';
  end if;
  v_hash:=public.campaign_plan_fingerprint(c);
  if r.input_snapshot->>'plan_fingerprint' is distinct from v_hash
     or r.input_snapshot->>'needs_lead_magnet' is distinct from 'true' then
    raise exception 'Sweep does not bind the reviewed magnet requirement.'
      using errcode='23514';
  end if;
  select * into d from public.campaign_magnet_drafts_v7 where run_id=r.id;
  if found then
    if d.plan_fingerprint<>v_hash or d.campaign_id<>c.id then
      raise exception 'Existing magnet draft belongs to another plan.';
    end if;
    return d;
  end if;
  insert into public.lead_magnets
    (client_id,name,objective,audience,format,campaign_id,offer_version_id)
  values(c.client_id,c.name || ' — campaign lead magnet',
    coalesce(nullif(c.objective,''),c.brief),c.audience,
    'pdf_guide',c.id,c.offer_version_id)
  returning id into v_magnet;
  select coalesce(max(work_version),0)+1 into v_version
    from public.delivery_work_items_v6
    where campaign_id=c.id and item_key='campaign_lead_magnet' and route_key='shared';
  select * into w from public.create_delivery_work_item_v6(
    c.id,null,null,null,'campaign_lead_magnet',v_version,
    'lead_magnet_studio',true,
    jsonb_build_object('workflow_run_id',r.id,'plan_fingerprint',v_hash,
      'magnet_id',v_magnet,'offer_version_id',c.offer_version_id),
    jsonb_build_object('artifact_kind','magnet_version','format','pdf_guide'));
  insert into public.campaign_magnet_drafts_v7
    (run_id,client_id,campaign_id,plan_fingerprint,magnet_id,work_item_id)
  values(r.id,c.client_id,c.id,v_hash,v_magnet,w.id)
  returning * into d;
  return d;
end $$;
revoke all on function public.ensure_campaign_magnet_draft_v7(uuid,uuid)
  from public,anon,authenticated;
grant execute on function public.ensure_campaign_magnet_draft_v7(uuid,uuid)
  to service_role;
select public.lock_down_definer_functions();
