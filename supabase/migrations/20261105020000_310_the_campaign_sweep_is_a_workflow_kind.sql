-- v6.1 / 2.8: the campaign sweep is a workflow kind.
--
-- The notes ask for "one run driving every asset to ready-to-distribute by
-- calling the factories, each process individually". The plan called this the
-- heart of phase 2 and the biggest remaining piece.
--
-- THE ENGINE ALREADY EXISTS, SO THIS IS NOT ONE
--
-- create_workflow_run already takes a campaign_id. add_workflow_agent_step
-- takes dependencies and an input_from_step_key, so one step's output feeds the
-- next. reconcile_workflow_runs drives them every fifteen seconds from the
-- runtime. enqueue_workflow_step_job queues each step's agent job, with
-- agent_jobs still the only execution queue. accept_workflow_step records a
-- step's artifact and its QA evidence. That is the notes' sweep component for
-- component, and it carries 10 runs and 140 steps of real data.
--
-- So what was missing is a kind, a way to ask for one, and a composer. Building
-- a second orchestrator beside a working one would have been the worst mistake
-- available in this phase.
--
-- WHY BOTH THE CONSTRAINT AND THE FUNCTION
--
-- workflow_runs_kind_check lists the permitted kinds, and
-- create_workflow_run repeats that list in its own body. Changing only the
-- constraint would leave the function refusing every campaign_sweep with
-- "Unknown workflow kind", which is the kind of half-change that looks applied
-- and is not. So the function is reproduced with one list extended and nothing
-- else touched.
--
-- WHY THE COMPOSER IS AN AGENT RATHER THAN AN RPC
--
-- create_workflow_run and add_workflow_agent_step both require
-- auth.role() = 'service_role'. A definer function does not change auth.role()
-- -- it reads the caller's JWT claim -- so a browser cannot compose a run
-- however the function is declared. That is a deliberate property of the
-- engine and not something to work around.
--
-- So request_campaign_sweep_v6 is a narrow writer that checks the gate and
-- queues the campaign_sweep agent, and the runtime composes the run as
-- service_role. Same shape as request_opportunity_discovery_v6 and 306's
-- request functions.
--
-- WHAT THE SWEEP DOES NOT DO
--
-- It does not create the landing page or the sales agent. provision_campaign
-- already does that, is tested, has a button, and is now gated by 309. A sweep
-- that added the same two steps would duplicate it -- and this phase has
-- already removed three duplications of exactly that shape. The sweep covers
-- the content pieces, which are the genuinely multi-step part, and the build
-- artifacts keep their own path.

alter table public.workflow_runs
  drop constraint if exists workflow_runs_kind_check;
alter table public.workflow_runs
  add constraint workflow_runs_kind_check check (
    kind = any (array['daily_content_package', 'client_launch_package', 'campaign_sweep'])
  );

-- Reproduced from migration 190's definition with 'campaign_sweep' added to the
-- kind list. Nothing else is changed, signature and search_path included.
-- The header is 190's, character for character, including the three defaults
-- and the search_path. `create or replace` refuses to remove a parameter
-- default ("cannot remove parameter defaults from existing function"), so a
-- reproduction that tidies the signature does not apply at all -- and a test
-- whose scaffold declares the function without those defaults will not notice.
create or replace function public.create_workflow_run(
  p_client_id uuid, p_kind text, p_workflow_version text, p_idempotency_key text,
  p_input_snapshot jsonb, p_deadline_at timestamptz,
  p_campaign_id uuid default null, p_root_request_id text default null,
  p_created_by uuid default null
) returns public.workflow_runs
language plpgsql security definer set search_path to 'public'
as $$
declare v_run workflow_runs;
begin
  if auth.role() <> 'service_role' then raise exception 'AUTH: service role required'; end if;
  if p_client_id is null or not exists (select 1 from clients where id = p_client_id) then
    raise exception 'A real client is required.';
  end if;
  if p_kind not in ('daily_content_package', 'client_launch_package', 'campaign_sweep') then
    raise exception 'Unknown workflow kind.';
  end if;
  if nullif(btrim(coalesce(p_workflow_version, '')), '') is null
     or nullif(btrim(coalesce(p_idempotency_key, '')), '') is null
     or p_input_snapshot is null or jsonb_typeof(p_input_snapshot) <> 'object'
     or p_deadline_at is null then
    raise exception 'Workflow version, key, object snapshot and deadline are required.';
  end if;
  if p_campaign_id is not null and not exists (
    select 1 from client_campaigns c where c.id = p_campaign_id and c.client_id = p_client_id
  ) then raise exception 'Campaign does not belong to this client.'; end if;

  insert into workflow_runs (
    client_id, campaign_id, kind, workflow_version, idempotency_key,
    root_request_id, input_snapshot, deadline_at, created_by
  ) values (
    p_client_id, p_campaign_id, p_kind, btrim(p_workflow_version), btrim(p_idempotency_key),
    p_root_request_id, p_input_snapshot, p_deadline_at, p_created_by
  ) on conflict (client_id, kind, idempotency_key) do nothing
  returning * into v_run;
  if not found then
    select * into v_run from workflow_runs
    where client_id = p_client_id and kind = p_kind and idempotency_key = btrim(p_idempotency_key);
    if v_run.workflow_version is distinct from btrim(p_workflow_version)
       or v_run.input_snapshot is distinct from p_input_snapshot
       or v_run.deadline_at is distinct from p_deadline_at
       or v_run.campaign_id is distinct from p_campaign_id
       or v_run.root_request_id is distinct from p_root_request_id then
      raise exception 'idempotency_conflict';
    end if;
  end if;
  return v_run;
end;
$$;

-- ---------------------------------------------------------------------------
-- Asking for a sweep
-- ---------------------------------------------------------------------------

create or replace function public.request_campaign_sweep_v6(
  p_campaign_id uuid
) returns uuid
language plpgsql security definer
set search_path = pg_catalog, public
as $$
declare
  c public.client_campaigns%rowtype;
  v_running integer;
begin
  if public.current_role_of() is null then
    raise exception 'A provisioned console account is required.' using errcode = '42501';
  end if;
  select * into c from public.client_campaigns where id = p_campaign_id;
  if c.id is null then
    raise exception 'That campaign no longer exists.' using errcode = 'P0001';
  end if;
  if not public.can_access_client(c.client_id) then
    raise exception 'Not permitted for this client' using errcode = '42501';
  end if;
  if c.built_at is null then
    raise exception 'This campaign has no plan yet. There is nothing to sweep.'
      using errcode = 'P0001';
  end if;

  -- The gate 309 built. A sweep is the moment a plan becomes work, so it is
  -- exactly what that gate exists to stand in front of, and the same two
  -- refusals apply.
  if c.plan_approved_at is null then
    raise exception 'This plan has not been reviewed. Approve it before sweeping it into work.'
      using errcode = 'P0001';
  end if;
  if c.plan_approved_fingerprint is distinct from public.campaign_plan_fingerprint(c) then
    raise exception 'This plan changed after it was approved. Review the change and approve it again.'
      using errcode = 'P0001';
  end if;
  if c.content_count < 1 then
    raise exception 'This plan asks for no content, so there is nothing for a sweep to drive.'
      using errcode = 'P0001';
  end if;

  -- One sweep at a time per campaign. Two concurrent sweeps would compose two
  -- runs of the same steps against the same plan, and the second to finish
  -- would silently look like the considered one.
  select count(*) into v_running from public.agent_jobs j
   where j.agent_key = 'campaign_sweep'
     and j.input_table = 'client_campaigns'
     and j.input_id = p_campaign_id
     and j.status in ('queued', 'claimed', 'running');
  if v_running > 0 then
    raise exception 'A sweep of this campaign is already queued or running.'
      using errcode = 'P0001';
  end if;

  return public.enqueue_agent_job_internal(
    'campaign_sweep', c.client_id, 'client_campaigns', p_campaign_id,
    auth.uid(), '{}'::jsonb,
    'Queued: sweep ' || c.name || ' into work'
  );
end $$;

comment on function public.request_campaign_sweep_v6(uuid) is
  'Queues one sweep of an approved campaign plan into a workflow run. Refuses an unreviewed plan and one changed after approval, because a sweep is the moment a plan becomes work. The run itself is composed by the runtime, since create_workflow_run requires service_role.';

revoke all on function public.request_campaign_sweep_v6(uuid) from public, anon;
grant execute on function public.request_campaign_sweep_v6(uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Re-checking at compose time
-- ---------------------------------------------------------------------------
--
-- request_campaign_sweep_v6 checks the gate when the sweep is ASKED FOR. The
-- runtime composes the run later, and a plan can be corrected in between --
-- which is the whole point of 309's gate being correctable. So the composer
-- re-checks immediately before it writes, rather than trusting a decision that
-- may be minutes old.
--
-- Returns null when a sweep may proceed, or the reason it may not, so the agent
-- can fail with something a person can act on instead of a constraint error.
create or replace function public.campaign_sweep_blocker_v6(
  p_campaign_id uuid
) returns text
language plpgsql stable security definer
set search_path = pg_catalog, public
as $$
declare c public.client_campaigns%rowtype;
begin
  select * into c from public.client_campaigns where id = p_campaign_id;
  if c.id is null then return 'That campaign no longer exists.'; end if;
  if c.built_at is null then return 'This campaign has no plan.'; end if;
  if c.plan_approved_at is null then
    return 'This plan has not been reviewed. Approve it before sweeping it into work.';
  end if;
  if c.plan_approved_fingerprint is distinct from public.campaign_plan_fingerprint(c) then
    return 'This plan changed after it was approved. Review the change and approve it again.';
  end if;
  if c.content_count < 1 then
    return 'This plan asks for no content, so there is nothing for a sweep to drive.';
  end if;
  return null;
end $$;

comment on function public.campaign_sweep_blocker_v6(uuid) is
  'Why a campaign sweep may not proceed right now, or null. Re-checked by the composer immediately before it writes, because 309 makes a plan correctable and the approval may have been withdrawn since the sweep was asked for.';

revoke all on function public.campaign_sweep_blocker_v6(uuid) from public, anon;
grant execute on function public.campaign_sweep_blocker_v6(uuid) to authenticated, service_role;

insert into public.agents (agent_key, name, initials, domain, description,
                           requires_upstream, requires_input)
values
  ('campaign_sweep', 'Campaign Sweep', 'CS', 'orchestration',
   'Composes one workflow run for an approved campaign plan: a step chain per planned content piece, carrying its route, driven by the existing reconciler. Does not create the landing page or sales agent -- provision_campaign already owns those.',
   array['campaign_plan'], true)
on conflict (agent_key) do nothing;

select lock_down_definer_functions();
