-- Data-preserving foundation for code-rendered video. The legacy motion
-- tables, their exact review rows and attachments remain intact. New writes
-- are service-owned until create/stage/attach RPCs and workers are reviewed.

create function public.video_aspects_valid_v1(p_aspects text[])
returns boolean language sql immutable set search_path = pg_catalog as $$
  select p_aspects is not null
    and cardinality(p_aspects) between 1 and 3
    and not exists (
      select 1 from unnest(p_aspects) as item(value)
      where value is null or value not in ('16:9', '9:16', '1:1')
    )
    and cardinality(p_aspects) = (
      select count(distinct value)::integer from unnest(p_aspects) as item(value)
    );
$$;

create table public.video_projects (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients(id) on delete cascade,
  idea text not null check (length(btrim(idea)) between 15 and 4000),
  audience text check (audience is null or length(btrim(audience)) between 1 and 200),
  tone text not null default 'confident' check (tone in ('calm', 'confident', 'energetic')),
  target_length_sec integer not null default 180 check (target_length_sec between 30 and 900),
  aspects text[] not null default array['16:9']::text[] check (public.video_aspects_valid_v1(aspects)),
  stage text not null default 'queued' check (stage in (
    'queued', 'scripting', 'scripted', 'timing', 'timed', 'rendering',
    'rendered', 'attached', 'published', 'failed', 'needs_human'
  )),
  research jsonb check (research is null or jsonb_typeof(research) = 'object'),
  script jsonb check (script is null or jsonb_typeof(script) = 'object'),
  ir jsonb check (ir is null or jsonb_typeof(ir) = 'object'),
  ir_version integer not null default 0 check (ir_version >= 0),
  music_path text,
  music_prompt text,
  critic_reports jsonb not null default '[]'::jsonb check (jsonb_typeof(critic_reports) = 'array'),
  cost_usd numeric(12,4) not null default 0 check (cost_usd >= 0),
  stage_error text,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, client_id)
);

create index video_projects_client_stage_idx
  on public.video_projects (client_id, stage, updated_at desc);
create trigger video_projects_updated_at before update on public.video_projects
  for each row execute function public.set_updated_at();
alter table public.video_projects enable row level security;
create policy video_projects_read on public.video_projects
  for select to authenticated using (public.can_access_client(client_id));
revoke all on public.video_projects from public, anon, authenticated, service_role;
grant select on public.video_projects to authenticated;
grant all on public.video_projects to service_role;

create table public.video_scenes (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null,
  client_id uuid not null,
  position integer not null check (position between 1 and 40),
  scene_key text not null check (scene_key ~ '^s[0-9]{2}$'),
  component text not null check (length(btrim(component)) between 1 and 60),
  props jsonb not null check (jsonb_typeof(props) = 'object'),
  narration text not null check (length(btrim(narration)) between 1 and 600),
  transition_in text not null default 'cut'
    check (transition_in in ('cut', 'fade', 'slideLeft', 'slideUp', 'wipeBrand')),
  min_duration_sec numeric(5,2) check (min_duration_sec is null or min_duration_sec between 2 and 25),
  chapter boolean not null default false,
  locked boolean not null default false,
  audio_path text,
  alignment jsonb check (alignment is null or jsonb_typeof(alignment) = 'array'),
  duration_sec numeric(5,2) check (duration_sec is null or duration_sec between 2 and 25),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (project_id, client_id) references public.video_projects(id, client_id) on delete cascade,
  unique (project_id, position),
  unique (project_id, scene_key)
);

create index video_scenes_client_project_idx on public.video_scenes (client_id, project_id, position);
create trigger video_scenes_updated_at before update on public.video_scenes
  for each row execute function public.set_updated_at();
alter table public.video_scenes enable row level security;
create policy video_scenes_read on public.video_scenes
  for select to authenticated using (public.can_access_client(client_id));
revoke all on public.video_scenes from public, anon, authenticated, service_role;
grant select on public.video_scenes to authenticated;
grant all on public.video_scenes to service_role;

create table public.video_project_costs (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null,
  client_id uuid not null,
  job_id uuid references public.agent_jobs(id) on delete set null,
  stage text not null check (length(btrim(stage)) between 1 and 40),
  provider text not null check (length(btrim(provider)) between 1 and 80),
  units numeric(14,4) not null check (units >= 0),
  unit text not null check (length(btrim(unit)) between 1 and 40),
  usd numeric(12,6) not null check (usd >= 0),
  created_at timestamptz not null default now(),
  foreign key (project_id, client_id) references public.video_projects(id, client_id) on delete cascade
);

create index video_project_costs_project_idx on public.video_project_costs (project_id, created_at);
alter table public.video_project_costs enable row level security;
create policy video_project_costs_read on public.video_project_costs
  for select to authenticated using (public.can_access_client(client_id));
revoke all on public.video_project_costs from public, anon, authenticated, service_role;
grant select on public.video_project_costs to authenticated;
grant all on public.video_project_costs to service_role;

comment on table public.video_projects is
  'Code-rendered video projects. Legacy motion_design_projects and exact render decisions are retained separately during migration.';
comment on table public.video_scenes is
  'Code-rendered scenes for a project IR version. Client identity is constrained by the parent project composite key.';
comment on table public.video_project_costs is
  'Per-stage cost events for the code-rendered video route; only service writers may insert.';
