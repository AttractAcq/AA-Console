-- A campaign lead action sends no message. Record exactly which database
-- enrolment sweep committed, so a lost RPC response can be inspected without
-- guessing from lead creation times or current sequence membership.
begin;

create table public.campaign_lead_enrolment_runs_v6 (
  execution_id uuid primary key references public.campaign_action_executions(id) on delete cascade,
  client_id uuid not null references public.clients(id) on delete cascade,
  campaign_id uuid not null references public.client_campaigns(id) on delete cascade,
  sequence_id uuid not null references public.nurture_sequences(id) on delete restrict,
  sequence_hash text not null check (sequence_hash ~ '^[0-9a-f]{64}$'),
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  observed_count integer not null default 0 check (observed_count >= 0),
  skipped_count integer not null default 0 check (skipped_count >= 0)
);
create table public.campaign_lead_enrolment_items_v6 (
  execution_id uuid not null references public.campaign_lead_enrolment_runs_v6(execution_id)
    on delete cascade,
  client_id uuid not null references public.clients(id) on delete cascade,
  lead_id uuid not null references public.client_leads(id) on delete cascade,
  enrollment_id uuid references public.lead_sequence_enrollments(id) on delete set null,
  result text not null check (result in ('observed','skipped')),
  reason text,
  observed_at timestamptz not null default now(),
  primary key (execution_id,lead_id),
  check ((result='observed' and enrollment_id is not null and reason is null)
      or (result='skipped' and enrollment_id is null and reason is not null))
);
create index campaign_lead_enrolment_runs_client_idx
  on public.campaign_lead_enrolment_runs_v6(client_id,started_at desc);
create index campaign_lead_enrolment_items_client_idx
  on public.campaign_lead_enrolment_items_v6(client_id,execution_id);

alter table public.campaign_lead_enrolment_runs_v6 enable row level security;
alter table public.campaign_lead_enrolment_items_v6 enable row level security;
create policy campaign_lead_enrolment_runs_read_v6
  on public.campaign_lead_enrolment_runs_v6 for select to authenticated
  using (public.can_access_client(client_id));
create policy campaign_lead_enrolment_items_read_v6
  on public.campaign_lead_enrolment_items_v6 for select to authenticated
  using (public.may_manage_client_leads(client_id));
revoke all on public.campaign_lead_enrolment_runs_v6,
  public.campaign_lead_enrolment_items_v6 from public,anon,authenticated,service_role;
grant select on public.campaign_lead_enrolment_runs_v6 to authenticated;
grant select on public.campaign_lead_enrolment_items_v6 to authenticated;
grant all on public.campaign_lead_enrolment_runs_v6,
  public.campaign_lead_enrolment_items_v6 to service_role;

create or replace function public.enrol_campaign_leads_in_sequence_v6(p_execution_id uuid)
returns jsonb language plpgsql volatile security definer
set search_path = pg_catalog, public as $$
declare
  x public.campaign_action_executions%rowtype;
  a public.campaign_action_approvals%rowtype;
  v_sequence uuid;
  v_sequence_row public.nurture_sequences%rowtype;
  v_lines text[] := array[]::text[];
  v_hash text;
  v_step record;
  l record;
  v_enrollment public.lead_sequence_enrollments%rowtype;
  v_enrolled integer := 0;
  v_skipped jsonb := '[]'::jsonb;
  v_reason text;
begin
  if auth.role() <> 'service_role' then
    raise exception 'Only the internal service may perform a campaign action.';
  end if;
  select * into x from public.campaign_action_executions where id=p_execution_id;
  if not found then raise exception 'No such execution.'; end if;
  select * into a from public.campaign_action_approvals where id=x.approval_id;
  if a.action_key <> 'lead_message' or a.client_id <> x.client_id
    or a.campaign_id <> x.campaign_id then
    raise exception 'This execution does not bind a same-client lead action.';
  end if;
  v_sequence := nullif(a.scope->>'sequence_id','')::uuid;
  if v_sequence is null then raise exception 'That approval names no sequence.'; end if;
  select * into v_sequence_row from public.nurture_sequences where id=v_sequence;
  if not found or v_sequence_row.client_id <> x.client_id then
    raise exception 'The approved sequence no longer belongs to this client.';
  end if;
  if not public.nurture_sequence_approval_current_v6(v_sequence) then
    raise exception 'The sequence no longer has a current exact approval.';
  end if;
  for v_step in select position,delay_hours,template_version_id
      from public.nurture_sequence_steps where sequence_id=v_sequence order by position loop
    v_lines := v_lines || (v_step.position::text || ':' || v_step.delay_hours::text
      || ':' || v_step.template_version_id::text);
  end loop;
  if array_length(v_lines,1) is null then
    raise exception 'The approved sequence has no steps.';
  end if;
  v_hash := encode(sha256(convert_to(v_sequence::text || '|'
    || array_to_string(v_lines,'|'),'UTF8')),'hex');
  if v_hash is distinct from a.artifact_version_hash then
    raise exception 'The sequence shape or words changed after campaign approval.';
  end if;

  -- The unique run prevents a second invocation of the same execution from
  -- silently reusing or adding enrolments. This row and all items commit in
  -- the same transaction as the enrolments themselves.
  insert into public.campaign_lead_enrolment_runs_v6
    (execution_id,client_id,campaign_id,sequence_id,sequence_hash)
  values (x.id,x.client_id,x.campaign_id,v_sequence,v_hash);
  for l in select id from public.client_leads
      where source_client_campaign_id=a.campaign_id and client_id=a.client_id
        and not is_probe and stage=v_sequence_row.trigger_stage
      order by created_at loop
    v_reason := public.sequence_exit_reason_v6(l.id,v_sequence);
    v_enrollment := null;
    if v_reason is null then
      begin
        select * into v_enrollment from public.enroll_lead_in_sequence_v6(l.id,v_sequence);
        if v_enrollment.id is null then v_reason := 'No enrolment row returned.'; end if;
      exception when others then
        v_reason := sqlerrm;
      end;
    end if;
    if v_reason is not null then
      insert into public.campaign_lead_enrolment_items_v6
        (execution_id,client_id,lead_id,result,reason)
      values (x.id,x.client_id,l.id,'skipped',v_reason);
      v_skipped := v_skipped || jsonb_build_array(
        jsonb_build_object('lead_id',l.id,'reason',v_reason));
    else
      insert into public.campaign_lead_enrolment_items_v6
        (execution_id,client_id,lead_id,enrollment_id,result)
      values (x.id,x.client_id,l.id,v_enrollment.id,'observed');
      v_enrolled := v_enrolled+1;
    end if;
  end loop;
  update public.campaign_lead_enrolment_runs_v6
    set finished_at=now(),observed_count=v_enrolled,
      skipped_count=jsonb_array_length(v_skipped)
    where execution_id=x.id;
  return jsonb_build_object('enrolled',v_enrolled,'skipped',v_skipped,
    'sequence_id',v_sequence,'sequence_name',v_sequence_row.name);
end $$;
revoke all on function public.enrol_campaign_leads_in_sequence_v6(uuid)
  from public,anon,authenticated,service_role;

-- Read-only aggregate for the owning queue. A row proves the DB effect
-- transaction committed; 'observed' means the enrolment function returned a
-- row, which may also have been created concurrently by another caller.
create view public.campaign_lead_enrolment_source_v6
with (security_barrier=true) as
select x.id as execution_id,x.client_id,x.approval_id,
  a.scope->>'sequence_name' as sequence_name,
  a.artifact_version_hash as approved_sequence_hash,
  r.started_at,r.finished_at,r.observed_count,r.skipped_count,
  (select count(*)::integer from public.campaign_lead_enrolment_items_v6 i
    where i.execution_id=x.id and i.result='observed') as current_observation_rows
from public.campaign_action_executions x
join public.campaign_action_approvals a on a.id=x.approval_id and a.client_id=x.client_id
left join public.campaign_lead_enrolment_runs_v6 r
  on r.execution_id=x.id and r.client_id=x.client_id
where x.action_key='lead_message' and public.can_access_client(x.client_id);
revoke all on public.campaign_lead_enrolment_source_v6
  from public,anon,authenticated,service_role;
grant select on public.campaign_lead_enrolment_source_v6 to authenticated,service_role;

insert into public.approval_class_coverage_versions_v6
 (class_id,revision,class_key,title,source_state,source_evidence,
  decision_state,decision_evidence,executor_state,executor_evidence,blocker)
select c.class_id,c.revision+1,c.class_key,c.title,
 'verified','274 exact action Inbox source; 325 atomic handler-owned claim',
 'verified','274 AAL2 decision; 331 revocation',
 'blocked','328 per-attempt receipt; 490 uncertain terminal result; 495 proof release source; 496 lead enrolment source',
 'Owned runtime release, live provider preflight/receipt and external action reconciliation are outstanding.'
from public.approval_class_coverage_v6 c where c.class_id=6;

select public.lock_down_definer_functions();
commit;
