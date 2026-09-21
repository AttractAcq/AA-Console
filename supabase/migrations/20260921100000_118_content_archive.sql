-- The content production archive.
--
-- 300 draft ideas, 33 already briefed, 26 briefs that have produced their
-- asset and are finished. The briefed ideas and the finished briefs are not
-- work any more — they are record — and leaving them in the working lists
-- is how the working lists stop being usable.
--
-- So a piece of work leaves the active list at the moment it is promoted:
-- an idea when its brief exists, a brief when its asset exists. Nothing is
-- copied and nothing is deleted. archived_at is a stamp on the same row, so
-- the archive is a different view of one set of records rather than a second
-- copy of them that can drift.
--
-- ARCHIVED MEANS HIDDEN, NOT DISABLED. An archived brief is still the brief
-- regenerate_asset and regenerate_frame build from, and rebuilding a frame
-- of a finished carousel must keep working. Nothing here revokes anything.
--
-- WHY THE STAMP IS A TRIGGER RATHER THAN A CONDITION IN THE PROMOTING CODE
--
-- There are several ways a brief comes into being — the brief agent, the
-- recruitment path, a campaign plan — and several ways an asset does. A rule
-- written into one of them is a rule the others do not follow, and the
-- symptom is an idea that stays in the list forever with no way to tell why.
-- The trigger fires on the fact, not on the route taken to it.

alter table client_ideas  add column archived_at timestamptz;
alter table client_briefs add column archived_at timestamptz;

comment on column client_ideas.archived_at is
  'When this idea stopped being active work, stamped as its brief was written. Record, not deletion: the idea is unchanged and still reachable from the archive.';
comment on column client_briefs.archived_at is
  'When this brief stopped being active work, stamped as its first asset was filed. The brief stays fully usable — regeneration builds from it.';

-- The active lists read these constantly and the archive grows without
-- bound, so both directions are worth an index.
create index client_ideas_active_idx on client_ideas (client_id, created_at desc)
  where archived_at is null;
create index client_briefs_active_idx on client_briefs (client_id, created_at desc)
  where archived_at is null;
create index client_ideas_archived_idx on client_ideas (client_id, archived_at desc)
  where archived_at is not null;
create index client_briefs_archived_idx on client_briefs (client_id, archived_at desc)
  where archived_at is not null;

-- ---------------------------------------------------------------------------
-- Promotion archives the stage behind it.

create or replace function archive_idea_on_brief()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.source_idea_id is not null then
    update client_ideas
       set archived_at = now()
     where id = new.source_idea_id
       -- Only the first brief stamps it. A second brief off the same idea
       -- must not rewrite when the idea stopped being worked on.
       and archived_at is null;
  end if;
  return null;
end;
$$;

create or replace function archive_brief_on_asset()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.brief_id is not null then
    update client_briefs
       set archived_at = now()
     where id = new.brief_id
       and archived_at is null;
  end if;
  return null;
end;
$$;

create trigger cb_archive_idea
  after insert on client_briefs
  for each row execute function archive_idea_on_brief();

create trigger cma_archive_brief
  after insert on client_media_assets
  for each row execute function archive_brief_on_asset();

-- ---------------------------------------------------------------------------
-- And deletion puts it back.
--
-- Without this, deleting the only brief off an idea leaves that idea
-- archived with nothing behind it — invisible in the list it belongs in, and
-- filed in the archive under a chain that no longer exists. The console can
-- delete both of these, so the reverse has to exist.

create or replace function unarchive_idea_without_brief()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if old.source_idea_id is not null
     and not exists (select 1 from client_briefs b where b.source_idea_id = old.source_idea_id) then
    update client_ideas set archived_at = null where id = old.source_idea_id;
  end if;
  return null;
end;
$$;

create or replace function unarchive_brief_without_asset()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if old.brief_id is not null
     and not exists (select 1 from client_media_assets a where a.brief_id = old.brief_id) then
    update client_briefs set archived_at = null where id = old.brief_id;
  end if;
  return null;
end;
$$;

create trigger cb_unarchive_idea
  after delete on client_briefs
  for each row execute function unarchive_idea_without_brief();

create trigger cma_unarchive_brief
  after delete on client_media_assets
  for each row execute function unarchive_brief_without_asset();

-- ---------------------------------------------------------------------------
-- What is already true.
--
-- Backfilled from the records rather than from status, because status is a
-- statement about intent and the join is a statement about fact. An idea
-- marked 'briefed' whose brief job failed has no brief, and belongs in the
-- list, not the archive.

update client_ideas i
   set archived_at = coalesce(
         (select min(b.created_at) from client_briefs b where b.source_idea_id = i.id),
         now())
 where i.archived_at is null
   and exists (select 1 from client_briefs b where b.source_idea_id = i.id);

update client_briefs b
   set archived_at = coalesce(
         (select min(a.created_at) from client_media_assets a where a.brief_id = b.id),
         now())
 where b.archived_at is null
   and exists (select 1 from client_media_assets a where a.brief_id = b.id);
