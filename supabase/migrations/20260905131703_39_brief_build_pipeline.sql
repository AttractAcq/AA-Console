-- Approve & Build: the step between a brief and a finished asset.
--
-- Two routes out of one button. The AI route generates the asset; the human
-- route hands the brief to an editor or an avatar. Both move the brief to
-- in_production, and both end up in the same place — client_media_assets —
-- so the assets page does not care which route produced a file.
--
-- Video is human-only by policy, not by omission. The check below enforces
-- it in the database rather than trusting the UI to hide the option.

create type build_route as enum ('ai', 'human');
create type creative_stage as enum ('concept', 'render', 'done', 'failed');

-- ---------------------------------------------------------------------------
-- AI route
-- ---------------------------------------------------------------------------

create table creative_generations (
  id            uuid primary key default gen_random_uuid(),
  client_id     uuid not null references clients(id) on delete cascade,
  brief_id      uuid not null references client_briefs(id) on delete cascade,
  job_id        uuid references agent_jobs(id) on delete set null,

  media_type    media_type not null,
  stage         creative_stage not null default 'concept',

  -- Stage one. The creative direction, written before anything is rendered:
  -- what the asset actually is, so the renderer is given a description
  -- rather than a business brief. Kept because it is the part worth editing
  -- and re-running without paying to regenerate the reasoning.
  concept       jsonb,
  -- The exact string handed to the image model, composed from the concept.
  image_prompt  text,

  quality       text not null default 'medium',
  size          text not null default '1024x1536',
  concept_model text,
  image_model   text,

  -- Stage two's output, once it exists.
  asset_id      uuid references client_media_assets(id) on delete set null,

  cost_usd      numeric(10,4),
  error         text,
  created_by    uuid references auth.users(id) on delete set null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),

  -- Video is never AI-generated here. Enforced in the schema so a UI bug
  -- cannot queue one.
  constraint creative_generations_no_ai_video check (media_type <> 'video')
);

create index creative_generations_brief_idx on creative_generations (brief_id, created_at desc);
create index creative_generations_client_idx on creative_generations (client_id, created_at desc);

alter table creative_generations enable row level security;

create policy creative_generations_admin_all on creative_generations
  for all to authenticated using (is_admin()) with check (is_admin());

create policy creative_generations_scoped_read on creative_generations
  for select to authenticated using (can_access_client(client_id));

comment on table creative_generations is
  'One row per AI build attempt on a brief. Stage one writes the creative concept, stage two renders it. Kept per attempt so versions are comparable.';
comment on column creative_generations.concept is
  'Stage one output: the described asset, written so the renderer receives a creative direction rather than a business brief.';

-- ---------------------------------------------------------------------------
-- Human route
-- ---------------------------------------------------------------------------

create table brief_dispatches (
  id           uuid primary key default gen_random_uuid(),
  client_id    uuid not null references clients(id) on delete cascade,
  brief_id     uuid not null references client_briefs(id) on delete cascade,
  member_id    uuid not null references team_members(id) on delete cascade,
  assignment_id uuid references job_assignments(id) on delete set null,
  job_id       uuid references agent_jobs(id) on delete set null,

  -- The dashboard hand-off always happens; the email is best-effort and
  -- says so, so a missing Resend key degrades to "assigned, not emailed"
  -- rather than losing the assignment.
  email_status text not null default 'pending'
    check (email_status in ('pending', 'sent', 'failed', 'skipped')),
  email_error  text,
  emailed_at   timestamptz,

  sent_by      uuid references auth.users(id) on delete set null,
  created_at   timestamptz not null default now(),

  unique (brief_id, member_id)
);

create index brief_dispatches_member_idx on brief_dispatches (member_id, created_at desc);

alter table brief_dispatches enable row level security;

create policy brief_dispatches_admin_all on brief_dispatches
  for all to authenticated using (is_admin()) with check (is_admin());

-- An employee can see that a brief was sent to them, and nothing about
-- dispatches to anyone else.
create policy brief_dispatches_self_read on brief_dispatches
  for select to authenticated using (is_member(member_id));

comment on table brief_dispatches is
  'A brief handed to a person. The job_assignments row is the work; this records the hand-off and whether the email got out.';

-- ---------------------------------------------------------------------------
-- The two runners
-- ---------------------------------------------------------------------------

insert into agents (agent_key, name, initials, domain, description, requires_upstream, scheduled_only) values
  ('creative_build', 'Creative Build', 'CB', 'content',
   'Builds an asset from an approved brief in two stages: writes the creative concept, then renders it. Image and text only - video is produced by people.',
   '{}', false),
  ('brief_dispatch', 'Brief Dispatch', 'BD', 'content',
   'Emails an assigned brief to the editor or avatar it was handed to. The dashboard assignment does not depend on it.',
   '{}', true)
on conflict (agent_key) do update
  set description = excluded.description,
      scheduled_only = excluded.scheduled_only;;
