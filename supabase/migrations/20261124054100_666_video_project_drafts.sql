-- Manual-first project intake. This creates a draft only: no job is queued,
-- rendered, approved, attached, or published by this function.
alter table public.video_projects drop constraint video_projects_stage_check;
alter table public.video_projects add constraint video_projects_stage_check
  check (stage in ('draft', 'queued', 'scripting', 'scripted', 'timing', 'timed',
    'rendering', 'rendered', 'attached', 'published', 'failed', 'needs_human'));
alter table public.video_projects alter column stage set default 'draft';

create unique index client_briefs_id_client_video_v1
  on public.client_briefs(id, client_id);
alter table public.video_projects
  add column brief_id uuid,
  add column campaign_id uuid,
  add column route_package_id uuid,
  add column request_key text,
  add column request_hash text,
  add constraint video_projects_brief_client_fk
    foreign key (brief_id, client_id)
      references public.client_briefs(id, client_id) on delete restrict,
  add constraint video_projects_campaign_client_fk
    foreign key (campaign_id, client_id)
      references public.client_campaigns(id, client_id) on delete restrict,
  add constraint video_projects_route_client_fk
    foreign key (route_package_id, campaign_id, client_id)
      references public.campaign_route_packages_v6(id, campaign_id, client_id)
      on delete restrict,
  add constraint video_projects_route_pair_check
    check ((campaign_id is null) = (route_package_id is null)),
  add constraint video_projects_request_pair_check
    check ((request_key is null) = (request_hash is null));
create unique index video_projects_request_key_v1
  on public.video_projects(client_id, request_key)
  where request_key is not null;

create function public.create_video_project_draft_v1(
  p_client_id uuid, p_idea text, p_audience text default null,
  p_tone text default 'confident', p_target_length_sec integer default 180,
  p_aspects text[] default array['16:9']::text[],
  p_brief_id uuid default null, p_campaign_id uuid default null,
  p_route_package_id uuid default null, p_request_key text default null
) returns public.video_projects language plpgsql volatile security definer
set search_path = pg_catalog, public as $$
declare
  v public.video_projects%rowtype;
  r public.campaign_route_packages_v6%rowtype;
  b public.client_briefs%rowtype;
  v_idea text := nullif(btrim(p_idea), '');
  v_audience text := nullif(btrim(p_audience), '');
  v_hash text;
begin
  if auth.role() is distinct from 'authenticated' or auth.uid() is null
    or public.current_role_of() is null
    or not (coalesce(public.is_admin(), false)
      or coalesce(auth.uid() = public.active_video_approval_manager(p_client_id), false)) then
    raise exception 'A client video manager or admin must create a draft.'
      using errcode = '42501';
  end if;
  if p_client_id is null or v_idea is null
    or length(v_idea) not between 15 and 4000
    or (p_audience is not null and (v_audience is null or length(v_audience) > 200))
    or p_tone not in ('calm', 'confident', 'energetic')
    or p_target_length_sec not between 30 and 900
    or not public.video_aspects_valid_v1(p_aspects)
    or p_request_key is null
    or p_request_key !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' then
    raise exception 'Invalid video draft inputs or request key.' using errcode = '22023';
  end if;
  if (p_campaign_id is null) <> (p_route_package_id is null) then
    raise exception 'Campaign and route package must be supplied together.'
      using errcode = '22023';
  end if;
  if p_brief_id is not null then
    select * into b from public.client_briefs
      where id = p_brief_id and client_id = p_client_id;
    if not found or b.media_type <> 'video'
      or b.status not in ('approved', 'in_production', 'complete') then
      raise exception 'The video brief must be approved and belong to this client.'
        using errcode = '23514';
    end if;
  end if;
  if p_route_package_id is not null then
    select * into r from public.campaign_route_packages_v6
      where id = p_route_package_id and campaign_id = p_campaign_id
        and client_id = p_client_id;
    if not found or r.plan_fingerprint is distinct from
        (select public.campaign_plan_fingerprint(c)
           from public.client_campaigns c where c.id = p_campaign_id)
      or r.version <> (select max(version)
          from public.campaign_route_packages_v6
          where campaign_id = r.campaign_id and route = r.route) then
      raise exception 'The current campaign route package is required.'
        using errcode = '23514';
    end if;
  end if;
  v_hash := encode(sha256(convert_to(jsonb_build_object(
    'idea', v_idea, 'audience', v_audience, 'tone', p_tone,
    'target_length_sec', p_target_length_sec, 'aspects', to_jsonb(p_aspects),
    'brief_id', p_brief_id, 'campaign_id', p_campaign_id,
    'route_package_id', p_route_package_id)::text, 'UTF8')), 'hex');
  perform pg_advisory_xact_lock(hashtextextended(
    p_client_id::text || ':video_project:' || p_request_key, 0));
  select * into v from public.video_projects
    where client_id = p_client_id and request_key = p_request_key;
  if found then
    if v.request_hash <> v_hash then
      raise exception 'Video request key was reused for different inputs.'
        using errcode = '23514';
    end if;
    return v;
  end if;
  insert into public.video_projects(client_id, idea, audience, tone,
    target_length_sec, aspects, stage, brief_id, campaign_id,
    route_package_id, request_key, request_hash, created_by)
  values (p_client_id, v_idea, v_audience, p_tone,
    p_target_length_sec, p_aspects, 'draft', p_brief_id, p_campaign_id,
    p_route_package_id, p_request_key, v_hash, auth.uid())
  returning * into v;
  return v;
end;
$$;
revoke all on function public.create_video_project_draft_v1(
  uuid, text, text, text, integer, text[], uuid, uuid, uuid, text)
  from public, anon, authenticated, service_role;
grant execute on function public.create_video_project_draft_v1(
  uuid, text, text, text, integer, text[], uuid, uuid, uuid, text)
  to authenticated;

comment on function public.create_video_project_draft_v1(
  uuid, text, text, text, integer, text[], uuid, uuid, uuid, text) is
  'Creates or idempotently returns a video draft after manager and source checks; does not enqueue or publish.';
