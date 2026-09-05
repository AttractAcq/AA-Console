-- Separate the concept from the renders made of it.
--
-- A creative_generations row used to be one concept AND one image, which
-- made every iteration pay for the concept again — about $0.28 against 4c
-- for a medium render. The recommended workflow (several cheap concepts,
-- pick one, refine, one expensive final) was therefore unreachable, because
-- there was nowhere to put a second render of the same direction.
--
-- Now: a generation owns the concept, and creative_renders holds every
-- image made from it. Re-rendering costs a render. Editing the concept and
-- re-rendering also costs a render, because the prompt is recomposed from
-- the stored concept rather than regenerated.

create type render_status as enum ('queued', 'rendering', 'done', 'failed');

create table creative_renders (
  id             uuid primary key default gen_random_uuid(),
  generation_id  uuid not null references creative_generations(id) on delete cascade,
  client_id      uuid not null references clients(id) on delete cascade,
  job_id         uuid references agent_jobs(id) on delete set null,

  quality        text not null default 'medium',
  size           text not null default '1024x1536',
  -- Copied from the generation at creation, so changing the reference on a
  -- later render does not rewrite the history of earlier ones.
  reference_path text,

  status         render_status not null default 'queued',
  asset_id       uuid references client_media_assets(id) on delete set null,
  model          text,
  cost_usd       numeric(10,4),
  error          text,

  -- The operator's pick, for the "select one, refine it" step.
  selected       boolean not null default false,

  created_by     uuid references auth.users(id) on delete set null,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create index creative_renders_generation_idx on creative_renders (generation_id, created_at desc);
create index creative_renders_client_idx on creative_renders (client_id, created_at desc);

alter table creative_renders enable row level security;

create policy creative_renders_admin_all on creative_renders
  for all to authenticated using (is_admin()) with check (is_admin());
create policy creative_renders_scoped_read on creative_renders
  for select to authenticated using (can_access_client(client_id));

comment on table creative_renders is
  'Every image made from one concept. The concept is the expensive half; these are cheap, so iteration happens here.';
comment on column creative_renders.selected is
  'The operator has picked this one to refine or finalise. At most one per generation.';

-- Whether a human has edited the concept, so a rewrite does not silently
-- discard their work — the same rule persistRecords applies to records.
alter table creative_generations add column concept_edited_at timestamptz;

comment on column creative_generations.concept_edited_at is
  'Set when an operator edits the concept by hand. A re-render uses the edited version.';;
