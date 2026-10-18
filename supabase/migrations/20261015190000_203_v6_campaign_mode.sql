-- v6 campaigns have one acquisition route. Historical rows remain readable as
-- legacy; an operator explicitly clones one before using a v6 route.
alter table public.client_campaigns
  add column acquisition_mode text not null default 'legacy',
  add column paid_platform text,
  add column cloned_from_campaign_id uuid;

alter table public.client_campaigns
  add constraint client_campaigns_acquisition_route_check check (
    (acquisition_mode = 'paid' and paid_platform in ('meta', 'google')) or
    (acquisition_mode in ('legacy', 'organic') and paid_platform is null)
  ),
  add constraint client_campaigns_clone_not_self check (
    cloned_from_campaign_id is null or cloned_from_campaign_id <> id
  ),
  add constraint client_campaigns_clone_same_client_fkey
    foreign key (cloned_from_campaign_id, client_id)
    references public.client_campaigns (id, client_id)
    on delete set null (cloned_from_campaign_id);

create index client_campaigns_clone_source_idx
  on public.client_campaigns (cloned_from_campaign_id)
  where cloned_from_campaign_id is not null;

comment on column public.client_campaigns.acquisition_mode is
  'One v6 route: organic or paid. Legacy means the pre-v6 route was not established; clone explicitly to adopt v6.';
comment on column public.client_campaigns.paid_platform is
  'The paid activation provider. Required for paid campaigns; null for organic and legacy.';
comment on column public.client_campaigns.cloned_from_campaign_id is
  'Source campaign for a new independent run. Creative, approvals, external IDs and performance are never copied.';

create function public.guard_campaign_acquisition_route()
returns trigger language plpgsql set search_path = public as $$
begin
  if old.acquisition_mode is distinct from new.acquisition_mode
     or old.paid_platform is distinct from new.paid_platform
     or old.cloned_from_campaign_id is distinct from new.cloned_from_campaign_id then
    raise exception 'Campaign route and lineage are immutable. Clone this campaign into a new route.';
  end if;
  return new;
end;
$$;

create trigger guard_campaign_acquisition_route_update
  before update on public.client_campaigns
  for each row execute function public.guard_campaign_acquisition_route();

create function public.clone_campaign_for_route(
  p_source_campaign_id uuid,
  p_target_mode text,
  p_paid_platform text default null,
  p_name text default null
)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_source public.client_campaigns%rowtype;
  v_clone_id uuid;
  v_name text;
begin
  if auth.role() <> 'service_role' and not public.is_admin() then
    raise exception 'Only an admin can clone campaigns.';
  end if;
  if p_target_mode is null or p_target_mode not in ('organic', 'paid')
     or (p_target_mode = 'paid' and coalesce(p_paid_platform, '') not in ('meta', 'google'))
     or (p_target_mode = 'organic' and p_paid_platform is not null) then
    raise exception 'Choose organic, or paid with Meta or Google.';
  end if;

  select * into v_source from public.client_campaigns
    where id = p_source_campaign_id;
  if not found then raise exception 'Source campaign not found.'; end if;
  if v_source.acquisition_mode <> 'legacy' and v_source.acquisition_mode = p_target_mode then
    raise exception 'Clone into the other route to keep independent distribution and results.';
  end if;
  v_name := coalesce(nullif(btrim(p_name), ''), v_source.name || ' · ' || initcap(p_target_mode));
  if length(v_name) > 200 then raise exception 'Campaign name is too long.'; end if;

  insert into public.client_campaigns (
    client_id, name, brief, acquisition_mode, paid_platform,
    cloned_from_campaign_id, ideate_on_plan
  ) values (
    v_source.client_id, v_name, v_source.brief, p_target_mode, p_paid_platform,
    v_source.id, v_source.ideate_on_plan
  ) returning id into v_clone_id;
  return v_clone_id;
end;
$$;

revoke execute on function public.clone_campaign_for_route(uuid, text, text, text)
  from public, anon;
grant execute on function public.clone_campaign_for_route(uuid, text, text, text)
  to authenticated, service_role;

comment on function public.clone_campaign_for_route(uuid, text, text, text) is
  'Creates an unplanned campaign in one route from the source brief. No ideas, assets, approvals, external IDs or results are copied.';

-- A paused ad object is still an external write. Existing legacy behavior is
-- preserved until migration; a v6 campaign must use the approval executor.
create or replace function public.request_meta_build(p_campaign_id uuid)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  c public.client_campaigns%rowtype;
  v_job uuid;
begin
  select * into c from public.client_campaigns where id = p_campaign_id for update;
  if c.id is null then raise exception 'That campaign no longer exists.'; end if;
  if not (auth.role() = 'service_role' or public.can_access_client(c.client_id)) then
    raise exception 'Not permitted for this client';
  end if;
  if c.acquisition_mode <> 'legacy' then
    raise exception 'V6 Meta builds require exact-version human approval. The approval executor is not connected yet.';
  end if;
  if exists (
    select 1 from public.agent_jobs j
    where j.agent_key = 'meta_build'
      and j.input_table = 'client_campaigns'
      and j.input_id = c.id
      and j.status in ('queued', 'claimed', 'running')
  ) then
    raise exception 'A Meta build for this campaign is already queued or running.';
  end if;
  v_job := public.enqueue_agent_job_internal(
    'meta_build', c.client_id, 'client_campaigns', c.id, auth.uid(),
    '{}'::jsonb, 'Queued: build in Meta, paused'
  );
  return v_job;
end;
$$;
