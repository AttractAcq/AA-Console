-- ============================================================
-- AA Console · 15 · Briefs get a reference; jobs point at one
--
-- Admin runs ideation -> a brief is generated -> the brief is attached to
-- an avatar's or editor's job -> they open it from their Current Jobs
-- table. The reference comes from the same per-client counter that mints
-- media asset refs, so one client has one reference space.
-- ============================================================

alter table client_briefs add column if not exists brief_ref text;
create unique index if not exists cb_ref_idx
  on client_briefs (client_id, brief_ref) where brief_ref is not null;

create or replace function assign_brief_ref()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.brief_ref is null then
    new.brief_ref := next_ref_number(new.client_id);
  end if;
  return new;
end;
$$;
revoke execute on function assign_brief_ref() from authenticated, anon, public;

drop trigger if exists cb_assign_ref on client_briefs;
create trigger cb_assign_ref before insert on client_briefs
  for each row execute function assign_brief_ref();

-- backfill anything created before this migration
update client_briefs set brief_ref = next_ref_number(client_id) where brief_ref is null;

-- ---------- the job -> brief link ----------
alter table job_assignments
  add column if not exists brief_id uuid references client_briefs(id) on delete set null;
create index if not exists ja_brief_idx on job_assignments (brief_id);

comment on column job_assignments.brief_id is
  'The production brief this job delivers against. Surfaced to the assignee as the Brief button on their Current Jobs table.';;
