begin;

-- Enroll an exact reviewed brief privately. Release itself enrolls no client.
create table public.faceless_reel_previews_v1 (
  brief_id uuid primary key,
  client_id uuid not null,
  reviewed_updated_at timestamptz not null,
  project_id uuid unique,
  file_sha256 text check(file_sha256 ~ '^[0-9a-f]{64}$'),
  storage_path text unique,
  file_bytes bigint,
  filed_at timestamptz,
  foreign key (brief_id,client_id) references public.client_briefs(id,client_id),
  foreign key (project_id,client_id) references public.video_projects(id,client_id),
  check ((file_sha256 is null and storage_path is null and file_bytes is null and filed_at is null)
    or (file_sha256 is not null and project_id is not null and storage_path is not null and file_bytes > 100 and file_bytes is not null and filed_at is not null))
);
alter table public.faceless_reel_previews_v1 enable row level security;
create policy faceless_reel_read on public.faceless_reel_previews_v1 for select to authenticated
  using(public.can_access_client(client_id));
revoke all on public.faceless_reel_previews_v1 from public,anon,authenticated,service_role;
grant select on public.faceless_reel_previews_v1 to authenticated,service_role;

-- Keep narrated projects' length and release gates intact. A silent preview
-- cannot transition to any queue, accepted, attached or published stage.
alter table public.video_projects add column draft_renderer text;
alter table public.video_projects drop constraint video_projects_target_length_sec_check;
alter table public.video_projects add constraint video_project_length_and_renderer_v1 check(
  (draft_renderer is null and target_length_sec between 30 and 900)
  or (draft_renderer is not null and draft_renderer='workspace-diagram-v1'
      and brief_id is not null and stage='draft' and aspects=array['9:16']::text[]
      and target_length_sec between 21 and 105)
);
alter table public.video_scenes drop constraint video_scenes_narration_check;
alter table public.video_scenes add constraint video_scenes_narration_check check(
  length(btrim(narration)) between 1 and 600 or (component='WorkspaceDiagram' and narration='')
);

create function public.prepare_faceless_reel_preview_v1(p_client_id uuid,p_brief_id uuid,p_expected_updated_at timestamptz)
returns uuid language plpgsql security definer set search_path=pg_catalog,public as $$
declare
  e public.faceless_reel_previews_v1%rowtype;
  b public.client_briefs%rowtype;
  c public.client_campaigns%rowtype;
  p public.video_projects%rowtype;
  scene jsonb;
  scenes jsonb:='[]'::jsonb;
  captions text[];
  line text;
  caption text;
  seconds integer;
  total integer:=0;
  n integer;
  brand jsonb;
  snapshot jsonb;
begin
  if auth.role() is distinct from 'authenticated' or auth.uid() is null
    or not coalesce(public.can_access_client(p_client_id),false)
    or not (coalesce(public.is_admin(),false)
      or coalesce(auth.uid()=public.active_video_approval_manager(p_client_id),false)) then
    raise insufficient_privilege;
  end if;
  select * into e from public.faceless_reel_previews_v1 where client_id=p_client_id and brief_id=p_brief_id for update;
  if not found or p_expected_updated_at is distinct from e.reviewed_updated_at then
    raise exception 'The reviewed storyboard revision is unavailable.' using errcode='23514'; end if;
  if e.project_id is not null then return e.project_id; end if;
  select * into b from public.client_briefs where id=p_brief_id and client_id=p_client_id for update;
  if not found or b.updated_at is distinct from p_expected_updated_at or b.status<>'draft'
    or b.archived_at is not null or b.purpose is distinct from 'client' or b.media_type is distinct from 'video'
    or b.content_format is distinct from 'reel' or b.frame_count is distinct from 7
    or cardinality(b.frame_plan) is distinct from 7 or b.proof_asset_id is not null then
    raise exception 'Refresh and review the current independent seven-scene reel.' using errcode='23514'; end if;
  select cp.* into c from public.client_ideas i join public.client_campaigns cp
    on cp.client_id=i.client_id and cp.id=i.campaign_id
    where i.id=b.source_idea_id and i.client_id=b.client_id and cp.plan_approved_at is not null
    for share of cp,i;
  if not found or c.plan_approved_fingerprint is distinct from public.campaign_plan_fingerprint(c) then raise exception 'The source idea needs an approved campaign plan.' using errcode='23514'; end if;
  if exists(select 1 from public.video_projects where brief_id=b.id and client_id=b.client_id)
    or exists(select 1 from public.agent_jobs where client_id=b.client_id and input_table='client_briefs'
      and input_id=b.id and agent_key in ('video_build','creative_build'))
    or exists(select 1 from public.client_media_assets where client_id=b.client_id and brief_id=b.id)
    then raise exception 'Reconcile the existing video work before creating a project.'; end if;
  captions:=regexp_split_to_array(btrim(b.script),E'\r?\n');
  if cardinality(captions) is distinct from 7 then raise exception 'Expected seven caption lines.'; end if;
  for n in 1..7 loop
    scene:=b.frame_plan[n]::jsonb;
    line:='SHOT '||n||': ';
    caption:=substr(captions[n],length(line)+1);
    if left(captions[n],length(line))<>line or length(btrim(caption)) not between 1 and 60
      or coalesce(scene->>'duration_sec','') !~ '^([3-9]|1[0-5])$' then raise exception 'Invalid scene %.',n; end if;
    if n=1 and caption<>'Synthetic QA fixture · Illustrative example' then raise exception 'The first scene requires the synthetic disclosure.'; end if;
    if n=7 and caption is distinct from b.call_to_action then raise exception 'The closing caption and CTA differ.'; end if;
    seconds:=(scene->>'duration_sec')::integer;
    total:=total+seconds;
    scenes:=scenes||jsonb_build_array(jsonb_build_object('position',n,'caption',caption,'duration_sec',seconds));
  end loop;
  select jsonb_build_object('colour_primary',colour_primary,'colour_accent',colour_accent,
    'colour_background',colour_background,'colour_text',colour_text) into brand
    from public.client_brand_profiles where client_id=b.client_id for share;
  brand:=coalesce(brand,'{}'::jsonb);
  -- Lock and approve the exact saved revision in the same transaction as the project.
  update public.client_briefs set status='approved' where id=b.id and client_id=b.client_id returning * into b;
  snapshot:=jsonb_build_array(jsonb_build_object('brief_id',b.id,'source_idea_id',b.source_idea_id,
    'campaign_id',c.id,'offer_version_id',c.offer_version_id,'reviewed_updated_at',e.reviewed_updated_at,'approved_updated_at',b.updated_at));
  insert into public.video_projects(client_id,brief_id,idea,aspects,target_length_sec,draft_renderer,
    stage,ir_version,source_snapshot,source_digest,brand_snapshot,brand_snapshot_sha256,created_by)
  values(b.client_id,b.id,left('Reel storyboard · '||b.title,4000),array['9:16'],total,'workspace-diagram-v1','draft',1,snapshot,
    encode(sha256(convert_to(jsonb_build_array(snapshot,scenes,brand)::text,'UTF8')),'hex'),brand,
    encode(sha256(convert_to(brand::text,'UTF8')),'hex'),auth.uid()) returning * into p;
  insert into public.video_scenes(project_id,client_id,position,scene_key,component,props,narration,duration_sec)
    select p.id,p.client_id,(s->>'position')::integer,'s'||lpad(s->>'position',2,'0'),
      'WorkspaceDiagram',jsonb_build_object('caption',s->>'caption'),'',(s->>'duration_sec')::integer
      from jsonb_array_elements(scenes) s;
  update public.faceless_reel_previews_v1 set project_id=p.id where brief_id=b.id;
  return p.id;
end $$;
revoke all on function public.prepare_faceless_reel_preview_v1(uuid,uuid,timestamptz) from public,anon,authenticated,service_role;
grant execute on function public.prepare_faceless_reel_preview_v1(uuid,uuid,timestamptz) to authenticated;

-- Edit one storyboard scene before filing. A simultaneous edit or render
-- carries the old source digest and cannot replace the new revision.
create function public.edit_faceless_reel_scene_v1(p_client_id uuid,p_project_id uuid,p_source_digest text,
  p_position integer,p_caption text,p_duration_sec integer)
returns void language plpgsql security definer set search_path=pg_catalog,public as $$
declare p public.video_projects%rowtype; e public.faceless_reel_previews_v1%rowtype; scenes jsonb; total integer; cta text;
begin
  if auth.role() is distinct from 'authenticated' or auth.uid() is null
    or not coalesce(public.can_access_client(p_client_id),false)
    or not (coalesce(public.is_admin(),false)
      or coalesce(auth.uid()=public.active_video_approval_manager(p_client_id),false)) then raise insufficient_privilege; end if;
  select * into e from public.faceless_reel_previews_v1 where client_id=p_client_id and project_id=p_project_id for update;
  if not found or e.filed_at is not null then raise exception 'This storyboard is unavailable for editing.'; end if;
  select * into p from public.video_projects where id=e.project_id and client_id=e.client_id for update;
  select call_to_action into cta from public.client_briefs where id=e.brief_id and client_id=e.client_id;
  if p.draft_renderer is distinct from 'workspace-diagram-v1' or p.source_digest is distinct from p_source_digest
    or p_position is null or p_position not between 1 and 7 or p_duration_sec is null or p_duration_sec not between 3 and 15
    or p_caption is null or p_caption<>btrim(p_caption) or length(p_caption) not between 1 and 60 or p_caption ~ '[[:cntrl:]]'
    or (p_position=1 and p_caption<>'Synthetic QA fixture · Illustrative example')
    or (p_position=7 and p_caption is distinct from cta)
    then raise exception 'Refresh and check the caption, disclosure, CTA and timing.'; end if;
  update public.video_scenes set props=jsonb_build_object('caption',p_caption),duration_sec=p_duration_sec
    where client_id=p.client_id and project_id=p.id and position=p_position;
  if not found then raise exception 'Scene unavailable.'; end if;
  select jsonb_agg(jsonb_build_object('position',s.position,'caption',s.props->>'caption','duration_sec',s.duration_sec::integer)
    order by s.position),sum(duration_sec)::integer into scenes,total from public.video_scenes s where s.project_id=p.id and s.client_id=p.client_id;
  update public.video_projects set ir_version=ir_version+1,target_length_sec=total,
    source_digest=encode(sha256(convert_to(jsonb_build_array(source_snapshot,scenes,brand_snapshot)::text,'UTF8')),'hex')
    where id=p.id;
end $$;
revoke all on function public.edit_faceless_reel_scene_v1(uuid,uuid,text,integer,text,integer) from public,anon,authenticated,service_role;
grant execute on function public.edit_faceless_reel_scene_v1(uuid,uuid,text,integer,text,integer) to authenticated;

-- The trusted local renderer probes the MP4, hashes its bytes, uploads without
-- upsert, and verifies the downloaded bytes before filing this draft receipt.
create function public.file_faceless_reel_preview_v1(p_client_id uuid,p_project_id uuid,p_source_digest text,p_ir_version integer,
  p_sha256 text,p_bytes bigint,p_width integer,p_height integer,p_frames integer,p_fps integer)
returns text language plpgsql security definer set search_path=pg_catalog,public,storage as $$
declare p public.video_projects%rowtype; e public.faceless_reel_previews_v1%rowtype; dest text; scenes jsonb;
begin
  if auth.role() is distinct from 'service_role' then raise insufficient_privilege; end if;
  select * into e from public.faceless_reel_previews_v1 where client_id=p_client_id and project_id=p_project_id for update;
  if not found then raise exception 'No enrolled draft project.'; end if;
  select * into p from public.video_projects where id=e.project_id and client_id=e.client_id for share;
  if p.draft_renderer is distinct from 'workspace-diagram-v1' or p.stage is distinct from 'draft'
    or p.source_digest is distinct from p_source_digest or p.ir_version is distinct from p_ir_version or p.ir_version<1
    or p_width is distinct from 1080 or p_height is distinct from 1920 or p_fps is distinct from 30
    or p_frames is distinct from p.target_length_sec*30 or coalesce(p_sha256,'') !~ '^[0-9a-f]{64}$'
    or p_bytes is null or p_bytes not between 101 and 104857600 then raise exception 'The draft render receipt differs from the storyboard.'; end if;
  select jsonb_agg(jsonb_build_object('position',s.position,'caption',s.props->>'caption','duration_sec',s.duration_sec::integer)
    order by s.position) into scenes from public.video_scenes s where s.project_id=p.id and s.client_id=p.client_id;
  if encode(sha256(convert_to(jsonb_build_array(p.source_snapshot,scenes,p.brand_snapshot)::text,'UTF8')),'hex')
    is distinct from p.source_digest or not exists(select 1 from public.client_briefs b
      join public.client_ideas i on i.id=b.source_idea_id and i.client_id=b.client_id
      join public.client_campaigns c on c.id=i.campaign_id and c.client_id=i.client_id
      where b.id=e.brief_id and b.client_id=e.client_id and b.status='approved' and b.archived_at is null
        and b.updated_at=(p.source_snapshot->0->>'approved_updated_at')::timestamptz
        and c.id=(p.source_snapshot->0->>'campaign_id')::uuid and c.plan_approved_at is not null and c.plan_approved_fingerprint=public.campaign_plan_fingerprint(c)
        and c.offer_version_id is not distinct from (p.source_snapshot->0->>'offer_version_id')::uuid)
    then raise exception 'Storyboard or campaign source changed before filing.'; end if;
  dest:=p.client_id::text||'/video/projects/'||p.id::text||'/ir-v'||p.ir_version::text||'/draft-'||p.source_digest||'.mp4';
  if e.storage_path is not null then
    if e.storage_path=dest and e.file_bytes=p_bytes and e.file_sha256=p_sha256 then return dest; end if;
    raise exception 'A different draft has already been filed.'; end if;
  if not exists(select 1 from storage.objects where bucket_id='client-media' and name=dest
    and metadata->>'mimetype'='video/mp4' and (metadata->>'size')::bigint=p_bytes) then
    raise exception 'Exact private draft object is missing.'; end if;
  update public.faceless_reel_previews_v1 set storage_path=dest,file_bytes=p_bytes,file_sha256=p_sha256,filed_at=now()
    where brief_id=e.brief_id;
  return dest;
end $$;
revoke all on function public.file_faceless_reel_preview_v1(uuid,uuid,text,integer,text,bigint,integer,integer,integer,integer) from public,anon,authenticated,service_role;
grant execute on function public.file_faceless_reel_preview_v1(uuid,uuid,text,integer,text,bigint,integer,integer,integer,integer) to service_role;

create function public.guard_faceless_reel_build_v1() returns trigger
language plpgsql security definer set search_path=pg_catalog,public as $$
begin
  if exists(select 1 from public.faceless_reel_previews_v1 where brief_id=new.input_id and client_id=new.client_id) then
    raise exception 'Use the reviewed motion storyboard for this reel.' using errcode='23514';
  end if;
  return new;
end $$;
revoke all on function public.guard_faceless_reel_build_v1() from public,anon,authenticated,service_role;
create trigger guard_faceless_reel_build_v1 before insert on public.agent_jobs
  for each row when (new.agent_key in ('video_build','creative_build') and new.input_table='client_briefs')
  execute function public.guard_faceless_reel_build_v1();

commit;
