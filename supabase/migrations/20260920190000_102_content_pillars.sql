-- The content pillars a brand posts within.
--
-- client_ideas.content_territory already held a pillar-shaped value, written
-- by the ideation agent, which was asked to say "which content territory from
-- the brand strategy this sits in". The brand strategy names no territories,
-- so the model read three sections of prose and invented a set — a different
-- set every run. 54 distinct territories across two clients, every one of
-- them from exactly one run, with pairs like "Continuity and certainty" and
-- "Continuity and Certainty" sitting side by side.
--
-- Pillars are not a fourth brand_strategy section for the same reason. Those
-- are regenerated on every run, so a pillar living there drifts whenever the
-- strategist is re-run, which is the same problem with a better name on it.
-- A pillar has to survive a brand strategy refresh, so it is a row.
--
-- Per client, not an enum. Sixteen campaign templates are universal because
-- the funnel is the same everywhere; pillars belong to a brand, and a
-- hard-coded set would produce exactly the generic output the ideation
-- architecture exists to avoid.

create table client_content_pillars (
  id         uuid primary key default gen_random_uuid(),
  client_id  uuid not null references clients (id) on delete cascade,

  -- Stable across a rename, so renaming a pillar does not orphan its ideas.
  slug       text not null check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  name       text not null check (btrim(name) <> ''),

  -- What this pillar argues, in one line.
  premise    text not null check (btrim(premise) <> ''),

  -- Both boundaries. does_not_belong is the half people skip and the half
  -- that actually decides where an idea lands: a pillar defined only by what
  -- belongs in it absorbs anything, and the model is the one sorting.
  belongs         text not null check (btrim(belongs) <> ''),
  does_not_belong text not null check (btrim(does_not_belong) <> ''),

  -- Roughly what fraction of the calendar this should carry. The organic
  -- equivalent of the build-and-spend split: it turns "is the mix balanced"
  -- from an opinion into something measurable.
  target_share integer not null default 0 check (target_share between 0 and 100),

  -- Retired pillars keep their history rather than being deleted; ideas
  -- already filed under one stay filed.
  active     boolean not null default true,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  unique (client_id, slug)
);

create trigger ccp_set_updated_at before update on client_content_pillars
  for each row execute function set_updated_at();

create index client_content_pillars_client_idx
  on client_content_pillars (client_id, active, target_share desc);

-- Six active pillars is the cap. Three is the floor, and a floor cannot be a
-- row-level rule — it would refuse the first pillar of every new set — so the
-- minimum is checked where a whole set is proposed and only the maximum is
-- enforced here. Twenty-two labels is what an uncapped set becomes.
create or replace function enforce_pillar_cap()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_active integer;
begin
  if new.active then
    select count(*) into v_active
      from client_content_pillars
     where client_id = new.client_id
       and active
       and id <> new.id;
    if v_active >= 6 then
      raise exception 'A brand may have at most 6 active content pillars. Retire one before adding another.';
    end if;
  end if;
  return new;
end;
$$;

create trigger ccp_enforce_cap before insert or update on client_content_pillars
  for each row execute function enforce_pillar_cap();

comment on table client_content_pillars is
  'The three to six things a brand posts about. Proposed by an agent once, then owned and edited by a person — regenerating them on every run is the drift this table exists to stop.';
comment on column client_content_pillars.does_not_belong is
  'What does NOT go in this pillar. The boundary is what makes the model''s sorting checkable; without it a pillar absorbs anything.';
comment on column client_content_pillars.target_share is
  'Roughly what percentage of the calendar this pillar should carry. Shares across a client''s active pillars are intended to total 100.';

-- Ideas point at a pillar by id, so a rename carries.
alter table client_ideas
  add column pillar_id uuid references client_content_pillars (id) on delete set null;

create index client_ideas_pillar_idx on client_ideas (client_id, pillar_id)
  where pillar_id is not null;

comment on column client_ideas.pillar_id is
  'The content pillar this idea sits in. content_territory is left as written: it is the only record of what the model was thinking on runs made before pillars existed, and overwriting it with a guess would destroy that.';

alter table client_content_pillars enable row level security;

create policy ccp_admin_all on client_content_pillars
  for all to authenticated using (is_admin()) with check (is_admin());
create policy ccp_scoped_read on client_content_pillars
  for select to authenticated using (can_access_client(client_id));
