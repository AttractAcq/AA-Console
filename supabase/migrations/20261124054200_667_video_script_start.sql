-- A source-bound start gate. The agent remains paused until the runtime and
-- execution rechecks are reviewed. No outward action is made by this route.
insert into public.agents(agent_key,name,initials,domain,description,
  requires_upstream,paused)
values ('video_script','Video script','VS','content_production',
  'Writes a sourced code-rendered video storyboard from a reviewed draft.',
  '{}'::text[],true);

alter table public.video_projects
  add column source_snapshot jsonb not null default '[]'::jsonb
    check (jsonb_typeof(source_snapshot)='array'),
  add column source_digest text check (source_digest is null or source_digest ~ '^[0-9a-f]{64}$'),
  add column job_id uuid references public.agent_jobs(id) on delete set null,
  add column started_by uuid references auth.users(id) on delete set null;
alter table public.video_project_costs
  add column attempt_key text unique
    check (attempt_key is null or length(attempt_key) between 8 and 180);

create function public.guard_video_project_intake_v1()
returns trigger language plpgsql set search_path=pg_catalog,public as $$
begin
  if old.stage <> 'draft' and (
    new.client_id is distinct from old.client_id
    or new.idea is distinct from old.idea
    or new.audience is distinct from old.audience
    or new.tone is distinct from old.tone
    or new.target_length_sec is distinct from old.target_length_sec
    or new.aspects is distinct from old.aspects
    or new.brief_id is distinct from old.brief_id
    or new.campaign_id is distinct from old.campaign_id
    or new.route_package_id is distinct from old.route_package_id
    or new.source_snapshot is distinct from old.source_snapshot
    or new.source_digest is distinct from old.source_digest
    or new.job_id is distinct from old.job_id
    or new.started_by is distinct from old.started_by
  ) then
    raise exception 'Started video source and intake identity are immutable.'
      using errcode='23514';
  end if;
  return new;
end $$;
create trigger video_project_intake_guard_v1 before update on public.video_projects
  for each row execute function public.guard_video_project_intake_v1();
revoke all on function public.guard_video_project_intake_v1()
  from public,anon,authenticated,service_role;

create function public.start_video_project_v1(
  p_project_id uuid, p_expected_ir_version integer,
  p_record_ids uuid[] default '{}'::uuid[], p_operator_note text default null
) returns uuid language plpgsql volatile security definer
set search_path=pg_catalog,public set timezone='UTC' as $$
declare
  p public.video_projects%rowtype;
  b public.client_briefs%rowtype;
  c public.client_campaigns%rowtype;
  route public.campaign_route_packages_v6%rowtype;
  r public.client_agent_records%rowtype;
  s record;
  v_sources jsonb := '[]'::jsonb;
  v_count integer := 0;
  v_chars integer := 0;
  v_note text := nullif(btrim(p_operator_note),'');
  v_digest text;
  v_job uuid;
begin
  if auth.role() is distinct from 'authenticated' or auth.uid() is null
    or public.current_role_of() is null then
    raise exception 'A provisioned video manager is required.' using errcode='42501'; end if;
  select * into p from public.video_projects where id=p_project_id for update;
  if not found or not (coalesce(public.is_admin(),false)
    or coalesce(auth.uid()=public.active_video_approval_manager(p.client_id),false)) then
    raise exception 'Video draft or manager authority is unavailable.' using errcode='42501'; end if;
  if p.stage<>'draft' or p.job_id is not null
    or p.ir_version is distinct from p_expected_ir_version
    or nullif(btrim(coalesce(p.audience,'')),'') is null then
    raise exception 'Only a current draft with audience and expected version may start.'
      using errcode='23514'; end if;
  if p.brief_id is not null then
    select * into b from public.client_briefs where id=p.brief_id
      and client_id=p.client_id for share;
    if not found or b.media_type<>'video'
      or b.status not in ('approved','in_production','complete') then
      raise exception 'The linked video brief is no longer approved.'
        using errcode='23514'; end if;
  end if;
  if p.route_package_id is not null then
    select * into c from public.client_campaigns where id=p.campaign_id
      and client_id=p.client_id for share;
    select * into route from public.campaign_route_packages_v6
      where id=p.route_package_id and campaign_id=p.campaign_id
        and client_id=p.client_id;
    if c.id is null or c.status in ('cancelled','complete') or route.id is null
      or route.plan_fingerprint is distinct from public.campaign_plan_fingerprint(c)
      or route.version <> (select max(version)
        from public.campaign_route_packages_v6 rp
        where rp.campaign_id=route.campaign_id and rp.route=route.route) then
      raise exception 'The campaign route package is no longer current.'
        using errcode='23514'; end if;
  end if;
  if p_record_ids is null or cardinality(p_record_ids)>12
    or cardinality(p_record_ids)<>(select count(distinct id) from unnest(p_record_ids) as item(id))
    or exists(select 1 from unnest(p_record_ids) as item(id) where id is null)
    or (p_operator_note is not null and (v_note is null or length(v_note)>4000)) then
    raise exception 'Choose at most twelve distinct sources and a short operator note.'
      using errcode='22023'; end if;
  for r in select * from public.client_agent_records
    where id=any(p_record_ids) order by id for share loop
    select * into s from public.model_section_review_state_v7
      where record_id=r.id;
    if not found or r.client_id<>p.client_id
      or s.review_state is distinct from 'supported'
      or nullif(btrim(coalesce(r.body,'')),'') is null
      or length(r.body)>4000 then
      raise exception 'Every model source must be current, supported and client-owned.'
        using errcode='23514'; end if;
    v_count:=v_count+1;
    v_chars:=v_chars+length(r.body);
    v_sources:=v_sources||jsonb_build_array(jsonb_build_object(
      'id',r.id::text,
      'kind',case
        when r.domain::text in ('market','icp','competitors') then 'market'
        when r.domain::text like '%offer%' then 'offer'
        when r.domain::text like '%proof%' then 'proof'
        when r.domain::text like '%campaign%' then 'campaign'
        else 'business' end,
      'asOf',s.observed_on,'text',r.body,
      'review_id',s.review_id,'record_hash',s.record_hash,
      'source_ref',s.source_ref));
  end loop;
  if v_count<>cardinality(p_record_ids) then
    raise exception 'One or more model sources are unavailable.' using errcode='23514'; end if;
  if v_note is not null then
    v_sources:=v_sources||jsonb_build_array(jsonb_build_object(
      'id','operator_note','kind','operator','asOf',current_date,'text',v_note));
    v_count:=v_count+1;
    v_chars:=v_chars+length(v_note);
  end if;
  if v_count>12 or v_chars>20000 then
    raise exception 'Video source packet exceeds the writing budget.'
      using errcode='22023'; end if;
  v_digest:=encode(sha256(convert_to(v_sources::text,'UTF8')),'hex');
  v_job:=public.enqueue_agent_job_internal('video_script',p.client_id,
    'video_projects',p.id,auth.uid(),
    jsonb_build_object('source_digest',v_digest,'ir_version',p.ir_version),
    'Queued: write a sourced video storyboard');
  update public.video_projects set stage='queued',job_id=v_job,
    source_snapshot=v_sources,source_digest=v_digest,started_by=auth.uid()
    where id=p.id;
  return v_job;
end $$;
revoke all on function public.start_video_project_v1(uuid,integer,uuid[],text)
  from public,anon,authenticated,service_role;
grant execute on function public.start_video_project_v1(uuid,integer,uuid[],text)
  to authenticated;

comment on function public.start_video_project_v1(uuid,integer,uuid[],text) is
  'Rechecks draft ownership and route, snapshots supported model sources, and queues a paused video_script agent only when enabled by a later release.';

-- Workers call this immediately before model use and again before persisting
-- output. A true result confirms currency at that read, not a durable approval.
create function public.video_project_source_current_v1(p_project_id uuid)
returns boolean language plpgsql stable security definer
set search_path=pg_catalog,public as $$
declare p public.video_projects%rowtype;
  c public.client_campaigns%rowtype;
  route public.campaign_route_packages_v6%rowtype;
  entry jsonb; state record;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Service video source check only.' using errcode='42501'; end if;
  select * into p from public.video_projects where id=p_project_id;
  if not found or p.stage not in ('queued','scripting') or p.job_id is null
    or p.source_digest is distinct from
      encode(sha256(convert_to(p.source_snapshot::text,'UTF8')),'hex') then
    return false; end if;
  if p.brief_id is not null and not exists (
    select 1 from public.client_briefs b where b.id=p.brief_id
      and b.client_id=p.client_id and b.media_type='video'
      and b.status in ('approved','in_production','complete')) then
    return false; end if;
  if p.route_package_id is not null then
    select * into c from public.client_campaigns where id=p.campaign_id
      and client_id=p.client_id;
    select * into route from public.campaign_route_packages_v6
      where id=p.route_package_id and campaign_id=p.campaign_id
        and client_id=p.client_id;
    if c.id is null or c.status in ('cancelled','complete') or route.id is null
      or route.plan_fingerprint is distinct from public.campaign_plan_fingerprint(c)
      or route.version <> (select max(version)
        from public.campaign_route_packages_v6 rp
        where rp.campaign_id=route.campaign_id and rp.route=route.route) then
      return false; end if;
  end if;
  for entry in select value from jsonb_array_elements(p.source_snapshot) loop
    if entry->>'kind'='operator' then continue; end if;
    select * into state from public.model_section_review_state_v7
      where record_id=(entry->>'id')::uuid and client_id=p.client_id;
    if not found or state.review_state is distinct from 'supported'
      or state.review_id::text is distinct from entry->>'review_id'
      or state.record_hash is distinct from entry->>'record_hash' then
      return false; end if;
  end loop;
  return true;
end $$;
revoke all on function public.video_project_source_current_v1(uuid)
  from public,anon,authenticated,service_role;
grant execute on function public.video_project_source_current_v1(uuid)
  to service_role;

-- One cost event per job attempt. A retry of the same receipt cannot add the
-- same charge twice, and a reused receipt with changed values is rejected.
create function public.record_video_project_cost_v1(
  p_project_id uuid,p_job_id uuid,p_attempt_key text,
  p_provider text,p_units numeric,p_usd numeric
) returns uuid language plpgsql volatile security definer
set search_path=pg_catalog,public as $$
declare p public.video_projects%rowtype;
  j public.agent_jobs%rowtype;
  saved public.video_project_costs%rowtype;
  v_id uuid;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Service video cost write only.' using errcode='42501'; end if;
  if p_attempt_key is null or length(p_attempt_key) not between 8 and 180
    or p_provider is null or length(btrim(p_provider)) not between 1 and 80
    or p_units is null or p_units<0 or p_usd is null or p_usd<0 then
    raise exception 'Invalid video cost receipt.' using errcode='22023'; end if;
  select * into p from public.video_projects where id=p_project_id for update;
  select * into j from public.agent_jobs where id=p_job_id;
  if p.id is null or p.job_id is distinct from p_job_id
    or j.client_id is distinct from p.client_id
    or j.input_table is distinct from 'video_projects'
    or j.input_id is distinct from p.id or j.agent_key is distinct from 'video_script' then
    raise exception 'Video cost job does not match the project.' using errcode='23514'; end if;
  insert into public.video_project_costs(project_id,client_id,job_id,stage,
    provider,units,unit,usd,attempt_key)
  values(p.id,p.client_id,j.id,'script',btrim(p_provider),p_units,'tokens',p_usd,p_attempt_key)
  on conflict(attempt_key) do nothing returning id into v_id;
  if v_id is null then
    select * into saved from public.video_project_costs
      where attempt_key=p_attempt_key;
    if saved.project_id is distinct from p.id or saved.job_id is distinct from j.id
      or saved.provider is distinct from btrim(p_provider)
      or saved.units is distinct from p_units or saved.usd is distinct from p_usd then
      raise exception 'Video cost receipt key was reused with different values.'
        using errcode='23514'; end if;
    return saved.id;
  end if;
  update public.video_projects set cost_usd=cost_usd+p_usd where id=p.id;
  return v_id;
end $$;
revoke all on function public.record_video_project_cost_v1(
  uuid,uuid,text,text,numeric,numeric)
  from public,anon,authenticated,service_role;
grant execute on function public.record_video_project_cost_v1(
  uuid,uuid,text,text,numeric,numeric)
  to service_role;
