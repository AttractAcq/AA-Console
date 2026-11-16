-- Phase 4: page and sales-agent drafts join the reviewed campaign sweep.
-- This is internal preparation only. Publishing and public agent enablement
-- remain separately reviewed actions.

create table public.campaign_conversion_drafts_v7 (
  run_id uuid primary key references public.workflow_runs(id) on delete cascade,
  client_id uuid not null references public.clients(id) on delete cascade,
  campaign_id uuid not null references public.client_campaigns(id) on delete cascade,
  plan_fingerprint text not null check (plan_fingerprint ~ '^[0-9a-f]{32}$'),
  page_id uuid references public.client_pages(id) on delete restrict,
  sales_agent_id uuid references public.client_sales_agents(id) on delete restrict,
  page_work_item_id uuid references public.delivery_work_items_v6(id) on delete restrict,
  sales_work_item_id uuid references public.delivery_work_items_v6(id) on delete restrict,
  created_at timestamptz not null default now()
);
alter table public.campaign_conversion_drafts_v7 enable row level security;
create policy campaign_conversion_drafts_v7_read
  on public.campaign_conversion_drafts_v7 for select to authenticated
  using (public.can_access_client(client_id));
revoke all on public.campaign_conversion_drafts_v7 from public, anon, authenticated;
grant select on public.campaign_conversion_drafts_v7 to authenticated;
grant all on public.campaign_conversion_drafts_v7 to service_role;

create function public.ensure_campaign_conversion_drafts_v7(
  p_campaign_id uuid, p_run_id uuid
) returns public.campaign_conversion_drafts_v7
language plpgsql volatile security definer
set search_path = pg_catalog, public as $$
declare
  c public.client_campaigns%rowtype;
  r public.workflow_runs%rowtype;
  d public.campaign_conversion_drafts_v7%rowtype;
  w public.delivery_work_items_v6%rowtype;
  v_page uuid;
  v_agent uuid;
  v_version integer;
  v_hash text;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'A trusted campaign worker is required.' using errcode='42501';
  end if;
  select * into c from public.client_campaigns where id=p_campaign_id for update;
  select * into r from public.workflow_runs where id=p_run_id for update;
  if c.id is null or r.id is null or r.kind<>'campaign_sweep'
     or r.campaign_id is distinct from c.id or r.client_id<>c.client_id then
    raise exception 'Sweep run does not belong to the campaign.';
  end if;
  if c.acquisition_mode='legacy' or public.campaign_sweep_blocker_v6(c.id) is not null then
    raise exception 'A current approved route plan is required.';
  end if;
  v_hash:=public.campaign_plan_fingerprint(c);
  select * into d from public.campaign_conversion_drafts_v7 where run_id=r.id;
  if found then
    if d.plan_fingerprint<>v_hash then raise exception 'Sweep plan changed.'; end if;
    return d;
  end if;
  insert into public.campaign_conversion_drafts_v7
    (run_id,client_id,campaign_id,plan_fingerprint)
  values (r.id,c.client_id,c.id,v_hash) returning * into d;

  if c.needs_landing_page then
    insert into public.client_pages(client_id,page_type,title,brief,status)
    values (c.client_id,'landing',c.name || ' — campaign page',
      concat_ws(E'\n\n', 'Campaign: ' || c.name, nullif(c.objective,''),
        nullif(c.audience,''),nullif(c.offer_summary,''),nullif(c.core_message,'')),
      'draft') returning id into v_page;
    insert into public.campaign_artifacts(campaign_id,client_id,kind,page_id)
      values(c.id,c.client_id,'landing_page',v_page);
    select coalesce(max(work_version),0)+1 into v_version
      from public.delivery_work_items_v6
      where campaign_id=c.id and item_key='campaign_page' and route_key='shared';
    select * into w from public.create_delivery_work_item_v6(c.id,null,null,null,
      'campaign_page',v_version,'website_studio',true,
      jsonb_build_object('workflow_run_id',r.id,'plan_fingerprint',v_hash,'page_id',v_page),
      jsonb_build_object('artifact_kind','page','step_key','conversion_page'));
    update public.campaign_conversion_drafts_v7
      set page_id=v_page,page_work_item_id=w.id where run_id=r.id;
  end if;

  if c.needs_sales_agent then
    insert into public.client_sales_agents(client_id,page_id,name,purpose)
    values(c.client_id,v_page,c.name || ' — campaign sales agent',
      concat_ws(E'\n\n','Campaign: ' || c.name,nullif(c.objective,''),
        nullif(c.audience,''),nullif(c.offer_summary,'')))
      returning id into v_agent;
    insert into public.campaign_artifacts(campaign_id,client_id,kind,sales_agent_id)
      values(c.id,c.client_id,'sales_agent',v_agent);
    select coalesce(max(work_version),0)+1 into v_version
      from public.delivery_work_items_v6
      where campaign_id=c.id and item_key='campaign_sales_agent' and route_key='shared';
    select * into w from public.create_delivery_work_item_v6(c.id,null,null,null,
      'campaign_sales_agent',v_version,'sales_os',true,
      jsonb_build_object('workflow_run_id',r.id,'plan_fingerprint',v_hash,
        'sales_agent_id',v_agent,'page_id',v_page),
      jsonb_build_object('artifact_kind','sales_agent',
        'step_key','conversion_sales_agent'));
    update public.campaign_conversion_drafts_v7
      set sales_agent_id=v_agent,sales_work_item_id=w.id where run_id=r.id;
  end if;
  select * into d from public.campaign_conversion_drafts_v7 where run_id=r.id;
  return d;
end $$;

revoke all on function public.ensure_campaign_conversion_drafts_v7(uuid,uuid)
  from public,anon,authenticated;
grant execute on function public.ensure_campaign_conversion_drafts_v7(uuid,uuid)
  to service_role;

create table public.campaign_conversion_work_bindings_v7 (
  work_item_id uuid primary key references public.delivery_work_items_v6(id) on delete cascade,
  run_id uuid not null references public.workflow_runs(id) on delete cascade,
  step_key text not null check (step_key in ('conversion_page','conversion_sales_agent')),
  created_at timestamptz not null default now(),
  unique(run_id,step_key),
  foreign key(run_id,step_key) references public.workflow_steps(run_id,step_key)
    on delete cascade
);
alter table public.campaign_conversion_work_bindings_v7 enable row level security;
create policy campaign_conversion_work_bindings_v7_read
  on public.campaign_conversion_work_bindings_v7 for select to authenticated
  using (exists(select 1 from public.delivery_work_items_v6 w
    where w.id=work_item_id and public.can_access_client(w.client_id)));
revoke all on public.campaign_conversion_work_bindings_v7 from public,anon,authenticated;
grant select on public.campaign_conversion_work_bindings_v7 to authenticated;
grant all on public.campaign_conversion_work_bindings_v7 to service_role;

create function public.bind_campaign_conversion_work_v7(
  p_work_item_id uuid,p_run_id uuid,p_step_key text
) returns public.campaign_conversion_work_bindings_v7
language plpgsql volatile security definer
set search_path=pg_catalog,public as $$
declare
  d public.campaign_conversion_drafts_v7%rowtype;
  b public.campaign_conversion_work_bindings_v7%rowtype;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'A trusted campaign worker is required.' using errcode='42501';
  end if;
  select * into d from public.campaign_conversion_drafts_v7 where run_id=p_run_id;
  if d.run_id is null or not ((p_step_key='conversion_page'
      and d.page_work_item_id=p_work_item_id)
    or (p_step_key='conversion_sales_agent'
      and d.sales_work_item_id=p_work_item_id)) then
    raise exception 'Conversion work does not belong to this sweep step.';
  end if;
  insert into public.campaign_conversion_work_bindings_v7
    (work_item_id,run_id,step_key) values(p_work_item_id,p_run_id,p_step_key)
    on conflict(work_item_id) do nothing returning * into b;
  if not found then
    select * into b from public.campaign_conversion_work_bindings_v7
      where work_item_id=p_work_item_id;
    if b.run_id<>p_run_id or b.step_key<>p_step_key then
      raise exception 'Conversion work binding conflicts with another step.';
    end if;
  end if;
  return b;
end $$;

revoke all on function public.bind_campaign_conversion_work_v7(uuid,uuid,text)
  from public,anon,authenticated;
grant execute on function public.bind_campaign_conversion_work_v7(uuid,uuid,text)
  to service_role;

select public.lock_down_definer_functions();
