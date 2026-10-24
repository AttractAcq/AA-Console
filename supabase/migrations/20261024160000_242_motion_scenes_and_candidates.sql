-- Motion Design: change scene three without regenerating the other three.
--
-- v1 works. A prompt, a preset, an aspect and a duration go in; Claude writes
-- a constrained scene plan into `scene_plan`; code renders owned SVG frames
-- and FFmpeg assembles them. What it cannot do is iterate: the scene plan is
-- a jsonb blob on the project, so changing one beat means a new project and a
-- new render of everything, and the only way to compare two attempts is to
-- remember what the last one looked like.
--
-- Nor can anybody say whether the output is good enough. The v6 plan is blunt
-- about this: "do not assume model name alone yields quality", and asks for a
-- benchmark against direct Claude output on the same brief, plus brand and
-- claim QA, plus human acceptance. None of those have anywhere to live.
--
-- SO: SCENES AS ROWS, CANDIDATES AS ROWS
--
-- A scene is editable on its own and knows whether it is locked. A candidate
-- is one render of one project with its own QA verdicts, kept rather than
-- overwritten — because the interesting question after the fourth attempt is
-- which way the quality moved and what changed.
--
-- `scene_plan` stays exactly where it is. v1 reads it, the worker writes it,
-- and nothing here touches that path: scenes are seeded from it rather than
-- replacing it, so a project made yesterday still renders.
--
-- AN AI VERDICT IS NOT AN ACCEPTANCE
--
-- Brand QA and claim QA are recorded per candidate because they catch
-- different things — an off-palette frame and an unevidenced "cheapest in
-- Portsmouth" are both wrong and only one is a design problem. Neither is a
-- sign-off: `accepted_by` is a person, and the plan's gate is a human
-- judging the output good enough for a premium service business.

-- ---------------------------------------------------------------------------
-- Scenes
-- ---------------------------------------------------------------------------

create table public.motion_scenes (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.motion_design_projects(id) on delete cascade,
  client_id uuid not null references public.clients(id) on delete cascade,

  position integer not null check (position >= 1),
  beat text not null check (length(btrim(beat)) between 1 and 200),
  script text check (script is null or length(btrim(script)) <= 2000),
  start_sec numeric(5,2) not null default 0 check (start_sec >= 0),
  duration_sec numeric(5,2) not null check (duration_sec > 0 and duration_sec <= 60),

  -- What this scene rests on, where it rests on something. A proof-citing
  -- scene is the one that has to be re-checked when rights change, and
  -- finding it by reading scripts is not a plan.
  proof_asset_id uuid references public.client_proof_assets(id) on delete set null,

  -- Locked means "do not regenerate this one". The whole point of scenes as
  -- rows: scene three can be reworked while one, two and four stay as they
  -- were approved.
  locked boolean not null default false,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (project_id, position)
);

comment on table public.motion_scenes is
  'One beat of a motion design, editable on its own. scene_plan on the project is untouched: scenes are seeded from it, so a project made before this still renders.';

create index motion_scenes_project_idx on public.motion_scenes (project_id, position);

create trigger motion_scenes_updated_at before update on public.motion_scenes
  for each row execute function public.set_updated_at();

alter table public.motion_scenes enable row level security;
create policy motion_scenes_read on public.motion_scenes
  for select to authenticated using (public.can_access_client(client_id));
create policy motion_scenes_write on public.motion_scenes
  for all to authenticated
  using (public.is_admin() or auth.uid() = public.active_video_approval_manager(client_id))
  with check (public.is_admin() or auth.uid() = public.active_video_approval_manager(client_id));
grant select, insert, update, delete on public.motion_scenes to authenticated;
grant all on public.motion_scenes to service_role;

-- Seeding from what v1 already writes, so the first thing a person sees on a
-- project made last week is its actual beats rather than an empty timeline.
create function public.seed_motion_scenes_v6(p_project_id uuid)
returns integer language plpgsql security definer
set search_path = pg_catalog, public as $$
declare
  v_project public.motion_design_projects%rowtype;
  v_scene jsonb;
  v_position integer := 0;
  v_start numeric(5,2) := 0;
  v_duration numeric(5,2);
begin
  select * into v_project from public.motion_design_projects where id = p_project_id;
  if not found then raise exception 'No such motion project.' using errcode = 'P0001'; end if;
  if coalesce(auth.role(), '') <> 'service_role'
     and not (coalesce(public.is_admin(), false)
              or coalesce(auth.uid() = public.active_video_approval_manager(v_project.client_id), false)) then
    raise exception 'Only an admin or the assigned client manager can shape a motion design.'
      using errcode = 'P0001';
  end if;
  if exists (select 1 from public.motion_scenes where project_id = p_project_id) then
    -- Seeding twice would overwrite edits somebody made to a scene, which is
    -- the one thing this table exists to protect.
    return 0;
  end if;
  if v_project.scene_plan is null or jsonb_typeof(v_project.scene_plan) <> 'array' then
    return 0;
  end if;

  for v_scene in select * from jsonb_array_elements(v_project.scene_plan) loop
    v_position := v_position + 1;
    v_duration := coalesce((v_scene->>'duration_sec')::numeric,
                           v_project.duration_sec::numeric /
                           greatest(jsonb_array_length(v_project.scene_plan), 1));
    insert into public.motion_scenes (
      project_id, client_id, position, beat, script, start_sec, duration_sec)
    values (
      p_project_id, v_project.client_id, v_position,
      coalesce(nullif(btrim(coalesce(v_scene->>'beat', v_scene->>'title', '')), ''),
               'Scene ' || v_position::text),
      nullif(btrim(coalesce(v_scene->>'script', v_scene->>'caption', '')), ''),
      v_start, v_duration);
    v_start := v_start + v_duration;
  end loop;
  return v_position;
end $$;

revoke all on function public.seed_motion_scenes_v6(uuid) from public, anon;
grant execute on function public.seed_motion_scenes_v6(uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Candidates
-- ---------------------------------------------------------------------------

create table public.motion_render_candidates (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.motion_design_projects(id) on delete cascade,
  client_id uuid not null references public.clients(id) on delete cascade,

  attempt integer not null check (attempt >= 1),
  render_path text,
  poster_path text,
  duration_sec numeric(5,2),
  job_id uuid references public.agent_jobs(id) on delete set null,

  -- Two QA passes, because they catch different things: an off-palette frame
  -- is a design problem and an unevidenced claim is a legal one.
  brand_qa text check (brand_qa is null or brand_qa in ('pass', 'fail')),
  brand_qa_detail text,
  claim_qa text check (claim_qa is null or claim_qa in ('pass', 'fail')),
  claim_qa_detail text,

  -- And neither of them is a sign-off. A person accepts the cut that ships.
  accepted_by uuid references public.profiles(id) on delete set null,
  accepted_at timestamptz,
  rejected_reason text,

  -- The benchmark the plan asks for: the same brief, rendered elsewhere, so
  -- "a newer model" has to show its work.
  benchmark_note text,

  created_at timestamptz not null default now(),
  unique (project_id, attempt)
);

comment on table public.motion_render_candidates is
  'One render of one motion project, kept rather than overwritten. The interesting question after the fourth attempt is which way the quality moved, and that needs the earlier three to still exist.';

create index motion_render_candidates_project_idx
  on public.motion_render_candidates (project_id, attempt desc);

alter table public.motion_render_candidates enable row level security;
create policy motion_render_candidates_read on public.motion_render_candidates
  for select to authenticated using (public.can_access_client(client_id));
grant select on public.motion_render_candidates to authenticated;
grant all on public.motion_render_candidates to service_role;

create function public.accept_motion_candidate_v6(
  p_candidate_id uuid, p_accepted boolean, p_reason text default null)
returns public.motion_render_candidates language plpgsql security definer
set search_path = pg_catalog, public as $$
declare v_candidate public.motion_render_candidates%rowtype;
begin
  select * into v_candidate from public.motion_render_candidates
   where id = p_candidate_id for update;
  if not found then raise exception 'No such candidate.' using errcode = 'P0001'; end if;
  if auth.role() is distinct from 'authenticated'
     or not (coalesce(public.is_admin(), false)
             or coalesce(auth.uid() = public.active_video_approval_manager(v_candidate.client_id), false)) then
    raise exception 'A signed-in admin or the assigned client manager must accept a cut.'
      using errcode = 'P0001';
  end if;
  if v_candidate.accepted_at is not null then
    raise exception 'That candidate was already accepted.' using errcode = 'P0001';
  end if;
  if v_candidate.render_path is null then
    raise exception 'That candidate has no render to accept.' using errcode = 'P0001';
  end if;

  if not coalesce(p_accepted, false) then
    if nullif(btrim(coalesce(p_reason, '')), '') is null then
      raise exception 'Say why it was rejected.' using errcode = 'P0001';
    end if;
    update public.motion_render_candidates
       set rejected_reason = btrim(p_reason) where id = p_candidate_id
     returning * into v_candidate;
    return v_candidate;
  end if;

  -- One accepted cut per project. A second is two things claiming to be the
  -- finished video.
  if exists (select 1 from public.motion_render_candidates c
              where c.project_id = v_candidate.project_id and c.accepted_at is not null) then
    raise exception 'This project already has an accepted cut.' using errcode = 'P0001';
  end if;

  update public.motion_render_candidates
     set accepted_by = auth.uid(), accepted_at = now(), rejected_reason = null
   where id = p_candidate_id returning * into v_candidate;
  return v_candidate;
end $$;

revoke all on function public.accept_motion_candidate_v6(uuid, boolean, text) from public, anon;
grant execute on function public.accept_motion_candidate_v6(uuid, boolean, text) to authenticated;

-- ---------------------------------------------------------------------------
-- What is stopping a cut from shipping
-- ---------------------------------------------------------------------------

create or replace view motion_candidate_due with (security_invoker = true) as
select
  c.id as candidate_id,
  c.client_id,
  c.project_id,
  p.prompt,
  p.preset,
  c.attempt,
  c.render_path,
  c.brand_qa,
  c.brand_qa_detail,
  c.claim_qa,
  c.claim_qa_detail,
  c.accepted_at,
  c.rejected_reason,
  c.benchmark_note,
  (select count(*) from public.motion_scenes s where s.project_id = c.project_id) as scenes,
  (select count(*) from public.motion_scenes s
    where s.project_id = c.project_id and s.proof_asset_id is not null) as scenes_citing_proof,
  -- A scene citing proof whose permission has gone is the expensive case: the
  -- cut is wrong and nothing about the render says so.
  (select count(*) from public.motion_scenes s
    join public.client_proof_assets pa on pa.id = s.proof_asset_id
   where s.project_id = c.project_id
     and (pa.usage_rights <> 'approved'
          or (pa.expires_on is not null and pa.expires_on < current_date))) as scenes_citing_lost_proof,
  case
    when c.render_path is null then 'Still rendering, or the render failed.'
    when (select count(*) from public.motion_scenes s
           join public.client_proof_assets pa on pa.id = s.proof_asset_id
          where s.project_id = c.project_id
            and (pa.usage_rights <> 'approved'
                 or (pa.expires_on is not null and pa.expires_on < current_date))) > 0
      then 'A scene cites proof that is no longer usable. The cut is wrong whatever the QA says.'
    when c.brand_qa = 'fail'
      then 'Brand QA failed: ' || coalesce(c.brand_qa_detail, 'no detail recorded') || '.'
    when c.claim_qa = 'fail'
      then 'Claim QA failed: ' || coalesce(c.claim_qa_detail, 'no detail recorded') || '.'
    when c.brand_qa is null or c.claim_qa is null
      then 'QA has not run on this candidate yet.'
    when c.rejected_reason is not null then 'A person rejected it: ' || c.rejected_reason
    when c.accepted_at is not null then 'Accepted.'
    else null
  end as blocker
from public.motion_render_candidates c
join public.motion_design_projects p on p.id = c.project_id;

comment on view motion_candidate_due is
  'Each render candidate and what stops it shipping. A null blocker means QA passed and it is waiting for a person — an AI verdict is never the acceptance.';

grant select on motion_candidate_due to authenticated;

select lock_down_definer_functions();
