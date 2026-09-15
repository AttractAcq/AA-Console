-- Phase 10.9: version history, findings, and revert.
--
-- client_pages.html is one column and the landing page agent overwrites it. The
-- moment a second thing revises a page, the previous version is gone — so an
-- agent that polishes pages without history is a one-way door, and the first
-- pass that makes a page worse loses the good version.
--
-- This is deliberately not a git inside Postgres. Whole HTML per revision, an
-- integer that counts up, and a revert that writes a NEW revision rather than
-- rewinding. History is append-only; nothing here ever deletes a version.

create table client_page_revisions (
  id              uuid primary key default gen_random_uuid(),
  client_id       uuid not null references clients (id) on delete cascade,
  page_id         uuid not null references client_pages (id) on delete cascade,
  revision_number integer not null check (revision_number > 0),

  html            text not null,
  meta_title      text,
  meta_description text,
  body            text,

  source          text not null
                    check (source in ('initial_generation', 'agent_revision', 'manual_edit', 'revert')),
  reason          text,
  summary         text,

  job_id          uuid references agent_jobs (id) on delete set null,
  created_by      uuid references profiles (id) on delete set null,
  created_at      timestamptz not null default now(),

  unique (page_id, revision_number)
);

create index client_page_revisions_page_idx
  on client_page_revisions (page_id, revision_number desc);

comment on table client_page_revisions is
  'Every version of a page, append-only. A revert writes a new revision rather than removing later ones, so the history of what was tried is never lost.';
comment on column client_page_revisions.source is
  'Where this version came from: the original build, an agent revision, a hand edit, or a revert of an earlier version.';
comment on column client_page_revisions.summary is
  'What changed, in the words of whatever made the change. The reason a person can read the history without diffing HTML.';

alter table client_pages
  add column current_revision integer;

comment on column client_pages.current_revision is
  'Which revision client_pages.html currently holds. The page row stays the single place to read the live HTML; this says which version that is.';

-- What an audit found. Persisted rather than left in job output because an
-- unresolved NEEDS_PERSON gap is a standing piece of work — it outlives the job
-- that found it, and re-auditing should not lose what was already known.
create table client_page_findings (
  id                uuid primary key default gen_random_uuid(),
  client_id         uuid not null references clients (id) on delete cascade,
  page_id           uuid not null references client_pages (id) on delete cascade,
  -- Which version was audited. A finding against revision 3 says nothing
  -- reliable about revision 4, which is what makes staleness detectable.
  revision_number   integer not null,

  category          text not null,
  severity          text not null default 'medium'
                      check (severity in ('low', 'medium', 'high')),
  title             text not null,
  explanation       text not null,
  suggested_direction text,

  -- The load-bearing column. A finding needing real-world evidence must never
  -- be FIXABLE, because "fix this" applied to a missing testimonial is an
  -- instruction to invent one.
  classification    text not null
                      check (classification in ('FIXABLE', 'NEEDS_PERSON')),

  status            text not null default 'open'
                      check (status in ('open', 'selected', 'applied', 'dismissed', 'stale')),

  job_id            uuid references agent_jobs (id) on delete set null,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create index client_page_findings_page_idx
  on client_page_findings (page_id, status, classification);

comment on table client_page_findings is
  'What an audit found on one revision of a page. Persisted because an unresolved gap is standing work that outlives the job that found it.';
comment on column client_page_findings.classification is
  'FIXABLE means copy, structure or clarity an agent can change safely. NEEDS_PERSON means it needs a real testimonial, price, guarantee or credential — something only a person can supply. Never let the second become the first.';
comment on column client_page_findings.status is
  'open, selected (queued for the reviser), applied, dismissed, or stale (found against an older revision).';

-- Write a new version and make it current, in one statement.
--
-- The revision number is allocated here under a row lock rather than read then
-- written, because two revisions racing would otherwise both claim the same
-- number and one would be lost to the unique index.
create or replace function record_page_revision(
  p_page_id  uuid,
  p_html     text,
  p_source   text,
  p_summary  text default null,
  p_reason   text default null,
  p_meta_title text default null,
  p_meta_description text default null,
  p_body     text default null,
  p_job_id   uuid default null
)
returns integer
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_client uuid;
  v_next   integer;
begin
  -- Lock the page row so concurrent revisions serialise on it.
  --
  -- SECURITY DEFINER bypasses RLS on this select, so the explicit check below
  -- is the only thing protecting the row — it is not redundant with the
  -- policies. A caller who cannot see the page through RLS still reaches it
  -- here, and must be refused by name rather than by accident.
  select client_id into v_client from client_pages where id = p_page_id for update;
  if v_client is null then
    raise exception 'That page no longer exists.';
  end if;
  if not (auth.role() = 'service_role' or can_access_client(v_client)) then
    raise exception 'Not permitted for this client';
  end if;
  if p_html is null or length(p_html) = 0 then
    raise exception 'A revision needs HTML.';
  end if;

  select coalesce(max(revision_number), 0) + 1 into v_next
    from client_page_revisions where page_id = p_page_id;

  insert into client_page_revisions (
    client_id, page_id, revision_number, html, meta_title, meta_description,
    body, source, reason, summary, job_id, created_by
  ) values (
    v_client, p_page_id, v_next, p_html, p_meta_title, p_meta_description,
    p_body, p_source, p_reason, p_summary, p_job_id, auth.uid()
  );

  -- The page row remains the one place to read the live HTML.
  update client_pages
     set html = p_html,
         meta_title = coalesce(p_meta_title, meta_title),
         meta_description = coalesce(p_meta_description, meta_description),
         body = coalesce(p_body, body),
         current_revision = v_next,
         updated_at = now()
   where id = p_page_id;

  return v_next;
end;
$$;

revoke execute on function record_page_revision(uuid, text, text, text, text, text, text, text, uuid)
  from public, anon;
grant execute on function record_page_revision(uuid, text, text, text, text, text, text, text, uuid)
  to authenticated, service_role;

comment on function record_page_revision(uuid, text, text, text, text, text, text, text, uuid) is
  'Writes a new page version and makes it current. The revision number is allocated under a row lock, so two revisions racing cannot claim the same number.';

-- Go back to an earlier version by moving forward.
--
-- Deliberately writes a NEW revision holding the old HTML rather than deleting
-- what came after. Reverting is a decision worth keeping a record of, and the
-- versions being reverted away from are often the ones somebody wants to look
-- at again.
create or replace function revert_page_to_revision(
  p_page_id uuid,
  p_revision_number integer
)
returns integer
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_client uuid;
  r        client_page_revisions%rowtype;
begin
  select client_id into v_client from client_pages where id = p_page_id;
  if v_client is null then
    raise exception 'That page no longer exists.';
  end if;
  if not (auth.role() = 'service_role' or can_access_client(v_client)) then
    raise exception 'Not permitted for this client';
  end if;

  select * into r from client_page_revisions
   where page_id = p_page_id and revision_number = p_revision_number;
  if r.id is null then
    raise exception 'There is no revision % for this page.', p_revision_number;
  end if;

  return record_page_revision(
    p_page_id, r.html, 'revert',
    format('Reverted to revision %s.', p_revision_number),
    null, r.meta_title, r.meta_description, r.body, null
  );
end;
$$;

revoke execute on function revert_page_to_revision(uuid, integer) from public, anon;
grant execute on function revert_page_to_revision(uuid, integer) to authenticated, service_role;

comment on function revert_page_to_revision(uuid, integer) is
  'Reverts by writing a new revision holding the earlier HTML. Nothing later is deleted — the versions being reverted away from are often the ones somebody wants back.';

-- Any page that already has HTML gets revision 1, so history does not start
-- with a hole where the original build was.
insert into client_page_revisions (client_id, page_id, revision_number, html, meta_title, meta_description, body, source, summary, created_at)
select p.client_id, p.id, 1, p.html, p.meta_title, p.meta_description, p.body,
       'initial_generation', 'Original build, recorded when version history was added.',
       coalesce(p.built_at, p.created_at)
from client_pages p
where p.html is not null and length(p.html) > 0
  and not exists (select 1 from client_page_revisions r where r.page_id = p.id);

update client_pages p
   set current_revision = 1
 where p.html is not null and length(p.html) > 0 and p.current_revision is null;

alter table client_page_revisions enable row level security;
alter table client_page_findings enable row level security;

create policy cpr_admin_all on client_page_revisions
  for all to authenticated using (is_admin()) with check (is_admin());
create policy cpr_client_read on client_page_revisions
  for select to authenticated using (is_client_user(client_id));

create policy cpf_admin_all on client_page_findings
  for all to authenticated using (is_admin()) with check (is_admin());
create policy cpf_client_read on client_page_findings
  for select to authenticated using (is_client_user(client_id));
