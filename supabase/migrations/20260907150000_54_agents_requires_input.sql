-- Master runs queued agents that cannot possibly succeed.
--
-- `start_master_run` excluded `brief` by matching its agent_key as a string.
-- That looked like leftover scruffiness next to the newer `scheduled_only`
-- flag, and the audit recorded it as redundant. It was not: brief's
-- scheduled_only is false, so the string was the only thing excluding it.
--
-- Worse, it only ever covered brief. `creative_build` and `landing_page` have
-- the same shape — they act on a row a person created — and both were being
-- queued by every master run, where they fail on their first line:
--   creative_build: "No render to produce."
--   landing_page:   "This agent builds a page created by Build Page..."
-- So "Run All Agents" produced two guaranteed failures every time.
--
-- scheduled_only is the wrong flag to reuse: it means "driven by a schedule
-- rather than by a person", which is true of metrics_ingest and brief_dispatch
-- and false of all three of these. They are excluded for a different reason —
-- they need an input row that a master run has no way to supply — so they get
-- a column that says that.

alter table agents add column requires_input boolean not null default false;

comment on column agents.requires_input is
  'Acts on a specific row a person chose (a brief, a render, a page). Excluded from master runs, which have no such row to pass; still runnable on demand with an input.';

update agents
   set requires_input = true
 where agent_key in ('brief', 'creative_build', 'landing_page');

-- Recreated from the live definition, changing exactly one predicate:
-- `a.agent_key <> 'brief'` becomes `a.requires_input = false`.
create or replace function start_master_run(p_client_id uuid)
returns uuid
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_run_id uuid := gen_random_uuid();
  v_count  integer;
begin
  if not can_access_client(p_client_id) then
    raise exception 'Not permitted for this client';
  end if;

  insert into agent_jobs (agent_key, client_id, run_id, created_by)
  select a.agent_key, p_client_id, v_run_id, auth.uid()
  from agents a
  where a.paused = false
    and a.archived_at is null
    and a.scheduled_only = false
    and a.requires_input = false
    and not exists (
      select 1 from agent_jobs j
       where j.agent_key = a.agent_key
         and j.client_id = p_client_id
         and j.status in ('queued', 'claimed', 'running')
    );

  get diagnostics v_count = row_count;
  if v_count = 0 then
    raise exception 'Nothing to run - every agent is already queued or running for this client.';
  end if;

  return v_run_id;
end;
$function$;
