-- The Master AI runs as service_role, which has no auth.uid(), so the
-- can_access_client() check inside enqueue_agent_job can never pass. These
-- variants take the acting admin explicitly instead.
--
-- The authorisation is not skipped, it is relocated: the runtime verifies
-- the caller's JWT, and these re-verify that the actor really is an admin
-- against profiles. created_by still records the human who asked, so a job
-- queued through chat is attributable exactly like one queued by a click.

create or replace function enqueue_agent_job_as(
  p_actor       uuid,
  p_agent_key   text,
  p_client_id   uuid default null,
  p_input_table text default null,
  p_input_id    uuid default null
)
returns uuid
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  new_id uuid;
begin
  if not exists (select 1 from profiles where id = p_actor and role = 'admin') then
    raise exception 'Only an admin can queue agent work.';
  end if;
  if not exists (select 1 from agents where agent_key = p_agent_key) then
    raise exception 'Unknown agent: %', p_agent_key;
  end if;
  if (select paused from agents where agent_key = p_agent_key) then
    raise exception 'Agent % is paused', p_agent_key;
  end if;
  -- can_access_client is deliberately absent: an admin reaches every
  -- client, and the client fence for a scoped conversation is applied by
  -- the runtime before this is ever called.
  if p_client_id is not null and not can_run_agent(p_agent_key, p_client_id) then
    raise exception 'Agent % is missing required upstream intelligence', p_agent_key;
  end if;

  insert into agent_jobs (agent_key, client_id, input_table, input_id, created_by)
  values (p_agent_key, p_client_id, p_input_table, p_input_id, p_actor)
  returning id into new_id;

  insert into agent_job_events (job_id, description)
  values (new_id, 'Queued by the Master AI');

  return new_id;
end;
$$;

create or replace function start_master_run_as(p_actor uuid, p_client_id uuid)
returns uuid
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_run_id uuid := gen_random_uuid();
  v_count  integer;
begin
  if not exists (select 1 from profiles where id = p_actor and role = 'admin') then
    raise exception 'Only an admin can start a master run.';
  end if;

  insert into agent_jobs (agent_key, client_id, run_id, created_by)
  select a.agent_key, p_client_id, v_run_id, p_actor
  from agents a
  where a.paused = false
    and a.archived_at is null
    and a.agent_key <> 'brief'
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
$$;

revoke all on function enqueue_agent_job_as(uuid, text, uuid, text, uuid) from public, anon, authenticated;
revoke all on function start_master_run_as(uuid, uuid) from public, anon, authenticated;
grant execute on function enqueue_agent_job_as(uuid, text, uuid, text, uuid) to service_role;
grant execute on function start_master_run_as(uuid, uuid) to service_role;;
