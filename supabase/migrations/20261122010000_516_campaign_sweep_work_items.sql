-- Phase 4: materialize approved route plans as versioned packages and connect
-- each produced piece to the workflow artifact that must pass internal QA.

create function public.ensure_campaign_route_packages_v7(
  p_campaign_id uuid, p_run_id uuid
)
returns setof public.campaign_route_packages_v6
language plpgsql volatile security definer
set search_path = pg_catalog, public as $$
declare
  c public.client_campaigns%rowtype;
  r record;
  p public.campaign_route_packages_v6%rowtype;
  v_fingerprint text;
  v_run public.workflow_runs%rowtype;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'A trusted module worker is required.' using errcode = '42501';
  end if;
  select * into c from public.client_campaigns where id = p_campaign_id for update;
  if not found then raise exception 'Campaign not found.'; end if;
  select * into v_run from public.workflow_runs where id = p_run_id;
  if v_run.id is null or v_run.campaign_id is distinct from c.id
     or v_run.client_id <> c.client_id or v_run.kind <> 'campaign_sweep' then
    raise exception 'Sweep run does not belong to this campaign.';
  end if;
  if c.acquisition_mode = 'legacy' then
    raise exception 'Legacy campaigns have no route package.';
  end if;
  if public.campaign_sweep_blocker_v6(c.id) is not null then
    raise exception 'Campaign plan is not approved for preparation.';
  end if;
  v_fingerprint := public.campaign_plan_fingerprint(c);
  for r in select route from (values
    ('organic'::text, c.runs_organic), ('paid'::text, c.runs_paid)
  ) x(route, enabled) where enabled loop
    select * into p from public.campaign_route_packages_v6
      where campaign_id = c.id and route = r.route
      order by version desc limit 1;
    if not found or p.plan_fingerprint <> v_fingerprint or exists (
      select 1 from public.delivery_work_items_v6 w
      where w.route_package_id = p.id
        and w.input_snapshot->>'workflow_run_id' is distinct from p_run_id::text
    ) then
      insert into public.campaign_route_packages_v6
        (client_id, campaign_id, route, paid_platform, version, plan_fingerprint)
      values (c.client_id, c.id, r.route,
        case when r.route = 'paid' then c.paid_platform else null end,
        coalesce(p.version, 0) + 1, v_fingerprint)
      returning * into p;
    end if;
    return next p;
  end loop;
end $$;

revoke all on function public.ensure_campaign_route_packages_v7(uuid,uuid)
  from public, anon, authenticated;
grant execute on function public.ensure_campaign_route_packages_v7(uuid,uuid) to service_role;

create table public.campaign_sweep_work_bindings_v7 (
  work_item_id uuid primary key references public.delivery_work_items_v6(id) on delete cascade,
  run_id uuid not null references public.workflow_runs(id) on delete cascade,
  piece_key text not null check (piece_key ~ '^piece[1-9][0-9]*$'),
  final_step_key text not null,
  created_at timestamptz not null default now(),
  unique (run_id, piece_key),
  unique (run_id, final_step_key),
  foreign key (run_id, final_step_key)
    references public.workflow_steps(run_id, step_key) on delete cascade
);

alter table public.campaign_sweep_work_bindings_v7 enable row level security;
create policy campaign_sweep_work_bindings_v7_read
  on public.campaign_sweep_work_bindings_v7 for select to authenticated
  using (exists (select 1 from public.delivery_work_items_v6 w
    where w.id = work_item_id and public.can_access_client(w.client_id)));
revoke all on public.campaign_sweep_work_bindings_v7 from public, anon, authenticated;
grant select on public.campaign_sweep_work_bindings_v7 to authenticated;
grant all on public.campaign_sweep_work_bindings_v7 to service_role;

create function public.bind_campaign_sweep_work_v7(
  p_work_item_id uuid, p_run_id uuid, p_piece_key text, p_final_step_key text
) returns public.campaign_sweep_work_bindings_v7
language plpgsql volatile security definer
set search_path = pg_catalog, public as $$
declare
  w public.delivery_work_items_v6%rowtype;
  r public.workflow_runs%rowtype;
  b public.campaign_sweep_work_bindings_v7%rowtype;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'A trusted module worker is required.' using errcode = '42501';
  end if;
  select * into w from public.delivery_work_items_v6 where id = p_work_item_id;
  select * into r from public.workflow_runs where id = p_run_id;
  if w.id is null or r.id is null or w.campaign_id is distinct from r.campaign_id
     or w.client_id <> r.client_id or r.kind <> 'campaign_sweep'
     or w.owner_module <> 'content_production_factory'
     or w.item_key <> 'content_' || p_piece_key
     or p_final_step_key not in (p_piece_key || '_create', p_piece_key || '_edit') then
    raise exception 'Work item does not match the campaign sweep piece.';
  end if;
  insert into public.campaign_sweep_work_bindings_v7
    (work_item_id, run_id, piece_key, final_step_key)
  values (w.id, r.id, p_piece_key, p_final_step_key)
  on conflict (work_item_id) do nothing returning * into b;
  if not found then
    select * into b from public.campaign_sweep_work_bindings_v7
      where work_item_id = w.id;
    if (b.run_id, b.piece_key, b.final_step_key) is distinct from
       (r.id, p_piece_key, p_final_step_key) then
      raise exception 'Work binding belongs to a different workflow step.';
    end if;
  end if;
  return b;
end $$;

revoke all on function public.bind_campaign_sweep_work_v7(uuid,uuid,text,text)
  from public, anon, authenticated;
grant execute on function public.bind_campaign_sweep_work_v7(uuid,uuid,text,text)
  to service_role;

-- Reconcile only the piece whose own graph changed. An accepted final artifact
-- moves it to human review; a blocked step holds that piece with its reason.
create function public.sync_campaign_sweep_work_v7(p_limit integer default 100)
returns integer language plpgsql volatile security definer
set search_path = pg_catalog, public as $$
declare
  b record;
  v_step public.workflow_steps%rowtype;
  v_blocked public.workflow_steps%rowtype;
  v_artifact public.workflow_artifacts%rowtype;
  v_fingerprint text;
  v_count integer := 0;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'A trusted module worker is required.' using errcode = '42501';
  end if;
  for b in
    select x.*, w.state from public.campaign_sweep_work_bindings_v7 x
    join public.delivery_work_items_v6 w on w.id = x.work_item_id
    join public.workflow_runs r on r.id = x.run_id
    where r.sealed_at is not null and w.state in ('draft','prepared','held')
      and (w.state = 'draft'
        or exists (select 1 from public.workflow_artifacts a
          join public.workflow_steps s on s.id = a.step_id
          where s.run_id = x.run_id and s.step_key = x.final_step_key
            and s.status = 'completed')
        or (w.state = 'prepared' and exists (
          select 1 from public.workflow_steps s where s.run_id = x.run_id
            and left(s.step_key, length(x.piece_key) + 1) = x.piece_key || '_'
            and s.status in ('blocked','failed')))
        or (w.state = 'held' and not exists (
          select 1 from public.workflow_steps s where s.run_id = x.run_id
            and left(s.step_key, length(x.piece_key) + 1) = x.piece_key || '_'
            and s.status in ('blocked','failed'))))
    order by x.created_at limit greatest(1, least(coalesce(p_limit, 100), 500))
  loop
    select * into v_step from public.workflow_steps
      where run_id = b.run_id and step_key = b.final_step_key;
    if v_step.status = 'completed' then
      select * into v_artifact from public.workflow_artifacts
        where step_id = v_step.id;
      if v_artifact.id is null then continue; end if;
      v_fingerprint := encode(sha256(convert_to(jsonb_build_object(
        'kind', v_artifact.artifact_kind, 'record_id', v_artifact.record_id,
        'version', v_artifact.version_key, 'qa', v_artifact.qa_evidence
      )::text, 'UTF8')), 'hex');
      if b.state = 'draft' or b.state = 'held' then
        perform public.advance_delivery_work_item_v6(b.work_item_id,
          'content_production_factory', 'prepared', '{"blocker":null}'::jsonb);
      end if;
      perform public.advance_delivery_work_item_v6(b.work_item_id,
        'content_production_factory', 'ready_for_review',
        jsonb_build_object('qa_state','passed', 'blocker', null,
          'job_id', v_step.job_id,
          'output_fingerprint', v_fingerprint,
          'output_refs', jsonb_build_array(jsonb_build_object(
            'kind', v_artifact.artifact_kind, 'record_id', v_artifact.record_id,
            'version', v_artifact.version_key, 'qa', v_artifact.qa_evidence))));
      v_count := v_count + 1;
    else
      select * into v_blocked from public.workflow_steps s
        where s.run_id = b.run_id
          and left(s.step_key, length(b.piece_key) + 1) = b.piece_key || '_'
          and s.status in ('blocked','failed')
        order by s.created_at limit 1;
      if v_blocked.id is not null and b.state <> 'held' then
        if b.state = 'draft' then
          perform public.advance_delivery_work_item_v6(b.work_item_id,
            'content_production_factory', 'prepared');
        end if;
        perform public.advance_delivery_work_item_v6(b.work_item_id,
          'content_production_factory', 'held',
          jsonb_build_object('blocker', coalesce(nullif(v_blocked.blocker,''),
            'Workflow step ' || v_blocked.step_key || ' is blocked.'),
            'job_id', v_blocked.job_id,
            'remediation', 'Retry the blocked workflow step after correcting its cause.'));
        v_count := v_count + 1;
      elsif v_blocked.id is null and b.state in ('draft','held') then
        perform public.advance_delivery_work_item_v6(b.work_item_id,
          'content_production_factory', 'prepared', '{"blocker":null}'::jsonb);
        v_count := v_count + 1;
      end if;
    end if;
  end loop;
  return v_count;
end $$;

revoke all on function public.sync_campaign_sweep_work_v7(integer)
  from public, anon, authenticated;
grant execute on function public.sync_campaign_sweep_work_v7(integer) to service_role;

select public.lock_down_definer_functions();
