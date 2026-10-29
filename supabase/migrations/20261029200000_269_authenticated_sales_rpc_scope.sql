-- B005 continuation: authenticated RPCs that bypass sales table RLS.
-- Migration 268 remains a partial dormant privacy slice until this migration
-- and its role matrix are reviewed together.

-- The sweep is a global worker enqueue. Cron and the trusted service keep it;
-- an assigned editor must not be able to start an outbound sequence sweep.
revoke execute on function public.enqueue_sequence_sweep() from authenticated;

-- Authenticated SECURITY DEFINER functions below bypass their source tables'
-- RLS. Keep their latest argument/return contracts, but use the same explicit
-- sales/client/admin/service boundary as client_leads. A creative assignment
-- alone cannot enrol, suppress, book, capture, or retrieve commercial outcomes.
-- The exact-version send approval and entitlement activation remain closed
-- until the unified Approval Inbox binds a reviewed decision (B008).
-- B005 guarded RPC: suppress_lead_v6 (latest definition from 20261025130000_248_a_message_can_be_sent_to_a_person.sql).
create or replace function public.suppress_lead_v6(
  p_client_id uuid, p_dedupe_key text, p_reason text, p_detail text default null)
returns uuid language plpgsql security definer
set search_path = pg_catalog, public as $$
declare v_id uuid;
begin
  if coalesce(auth.role(), '') <> 'service_role'
     and not (coalesce(public.is_admin(), false)
              or coalesce(public.may_manage_client_leads(p_client_id), false)) then
    raise exception 'Not permitted for this client.' using errcode = 'P0001';
  end if;
  if nullif(btrim(coalesce(p_dedupe_key, '')), '') is null then
    raise exception 'Say who is being suppressed.' using errcode = 'P0001';
  end if;
  if p_reason not in ('unsubscribed','complained','bounced','asked_by_client','manual') then
    raise exception 'Unknown suppression reason.' using errcode = 'P0001';
  end if;

  insert into public.lead_suppressions (client_id, dedupe_key, reason, detail, created_by)
  values (p_client_id, btrim(p_dedupe_key), p_reason, p_detail,
          case when auth.role() = 'service_role' then null else auth.uid() end)
  on conflict (client_id, dedupe_key) do update
    set reason = excluded.reason, detail = coalesce(excluded.detail, lead_suppressions.detail)
  returning id into v_id;
  return v_id;
end $$;

-- B005 guarded RPC: sequence_exit_reason_v6 (latest definition from 20261025170000_252_walking_the_sequence.sql).
create or replace function public.sequence_exit_reason_v6(
  p_lead_id uuid, p_sequence_id uuid)
returns text language plpgsql stable security definer
set search_path = pg_catalog, public as $$
declare
  l public.client_leads%rowtype;
  s public.nurture_sequences%rowtype;
begin
  select * into s from public.nurture_sequences where id = p_sequence_id;
  if not found then return 'The sequence no longer exists.'; end if;
  if not coalesce(public.may_manage_client_leads(s.client_id), false) then
    return 'The sequence no longer exists.';
  end if;

  select * into l from public.client_leads where id = p_lead_id;
  if not found then return 'The lead no longer exists.'; end if;
  if l.client_id <> s.client_id then return 'The lead no longer exists.'; end if;

  -- The three that no sequence may opt out of.
  if exists (select 1 from public.lead_suppressions sup
              where sup.client_id = l.client_id and sup.dedupe_key = l.dedupe_key) then
    return 'They unsubscribed or complained.';
  end if;
  if l.consent_given_at is null then
    return 'Their consent is no longer recorded.';
  end if;
  if l.is_probe then
    return 'It is a probe lead.';
  end if;

  -- And the ones the sequence declares.
  if l.stage = any (s.exit_stages) then
    return 'They reached ' || l.stage::text || ', so this sequence is no longer relevant.';
  end if;

  if s.archived_at is not null then
    return 'The sequence was archived.';
  end if;
  if s.approved_at is null then
    return 'The sequence''s approval was dropped, so no further step may go.';
  end if;
  return null;
end $$;

-- B005 guarded RPC: enroll_lead_in_sequence_v6 (latest definition from 20261025170000_252_walking_the_sequence.sql).
create or replace function public.enroll_lead_in_sequence_v6(
  p_lead_id uuid, p_sequence_id uuid)
returns public.lead_sequence_enrollments language plpgsql security definer
set search_path = pg_catalog, public as $$
declare
  l public.client_leads%rowtype;
  s public.nurture_sequences%rowtype;
  e public.lead_sequence_enrollments%rowtype;
  v_first public.nurture_sequence_steps%rowtype;
  v_reason text;
begin
  select * into l from public.client_leads where id = p_lead_id;
  if not found then raise exception 'No such lead.' using errcode = 'P0001'; end if;
  if coalesce(auth.role(), '') <> 'service_role'
     and not (coalesce(public.is_admin(), false)
              or coalesce(public.may_manage_client_leads(l.client_id), false)) then
    raise exception 'Not permitted for this client.' using errcode = 'P0001';
  end if;

  select * into s from public.nurture_sequences where id = p_sequence_id;
  if not found then raise exception 'No such sequence.' using errcode = 'P0001'; end if;
  if s.client_id <> l.client_id then
    raise exception 'That sequence belongs to a different client.' using errcode = 'P0001';
  end if;
  if s.approved_at is null then
    raise exception 'That sequence is not approved.' using errcode = 'P0001';
  end if;

  v_reason := public.sequence_exit_reason_v6(p_lead_id, p_sequence_id);
  if v_reason is not null then
    raise exception 'This lead cannot be enrolled: %', v_reason using errcode = 'P0001';
  end if;

  select * into v_first from public.nurture_sequence_steps
   where sequence_id = p_sequence_id order by position limit 1;

  insert into public.lead_sequence_enrollments (
    client_id, lead_id, sequence_id, next_due_at, enrolled_by)
  values (
    l.client_id, p_lead_id, p_sequence_id,
    now() + make_interval(hours => coalesce(v_first.delay_hours, 0)),
    case when auth.role() = 'service_role' then null else auth.uid() end)
  on conflict (lead_id, sequence_id) do nothing
  returning * into e;

  if e.id is null then
    select * into e from public.lead_sequence_enrollments
     where lead_id = p_lead_id and sequence_id = p_sequence_id;
  end if;
  return e;
end $$;

-- B005 guarded RPC: exit_lead_from_sequence_v6 (latest definition from 20261025170000_252_walking_the_sequence.sql).
create or replace function public.exit_lead_from_sequence_v6(
  p_enrollment_id uuid, p_reason text)
returns void language plpgsql security definer
set search_path = pg_catalog, public as $$
declare e public.lead_sequence_enrollments%rowtype;
begin
  select * into e from public.lead_sequence_enrollments where id = p_enrollment_id for update;
  if not found then raise exception 'No such enrolment.' using errcode = 'P0001'; end if;
  if coalesce(auth.role(), '') <> 'service_role'
     and not (coalesce(public.is_admin(), false)
              or coalesce(public.may_manage_client_leads(e.client_id), false)) then
    raise exception 'Not permitted for this client.' using errcode = 'P0001';
  end if;
  if nullif(btrim(coalesce(p_reason, '')), '') is null then
    raise exception 'Say why they were taken out.' using errcode = 'P0001';
  end if;
  update public.lead_sequence_enrollments
     set status = 'exited', exit_reason = btrim(p_reason), exited_at = now(), next_due_at = null
   where id = p_enrollment_id;
end $$;

-- B005 guarded RPC: book_appointment_v6 (latest definition from 20261025210000_256_taking_a_slot.sql).
create or replace function public.book_appointment_v6(
  p_lead_id uuid, p_starts_at timestamptz, p_booked_via text,
  p_campaign_id uuid default null)
returns public.client_appointments
language plpgsql security definer
set search_path = pg_catalog, public as $$
declare
  l public.client_leads%rowtype;
  s public.client_booking_settings%rowtype;
  a public.client_appointments%rowtype;
  v_ends timestamptz;
begin
  select * into l from public.client_leads where id = p_lead_id;
  if not found then raise exception 'No such lead.' using errcode = 'P0001'; end if;

  if p_booked_via not in ('public_link', 'sales_agent', 'person') then
    raise exception 'Unknown booking route.' using errcode = 'P0001';
  end if;
  -- A person or an agent books on the client's behalf; the public link books
  -- as the prospect. Only the first needs a signed-in caller.
  if p_booked_via = 'person'
     and not (coalesce(public.is_admin(), false)
              or coalesce(public.may_manage_client_leads(l.client_id), false)) then
    raise exception 'Not permitted for this client.' using errcode = 'P0001';
  end if;
  if p_booked_via <> 'person' and coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'Only the internal service books on a prospect''s behalf.'
      using errcode = 'P0001';
  end if;
  if p_campaign_id is not null and not exists (
    select 1 from public.client_campaigns c
     where c.id = p_campaign_id and c.client_id = l.client_id) then
    raise exception 'That campaign belongs to a different client.' using errcode = 'P0001';
  end if;

  if l.is_probe then
    raise exception 'That is a probe lead. Booking it would put a fake call in the diary.'
      using errcode = 'P0001';
  end if;

  select * into s from public.client_booking_settings where client_id = l.client_id;
  if not found or not s.enabled then
    raise exception 'This client is not taking bookings.' using errcode = 'P0001';
  end if;

  -- One lock per client for the whole check-and-insert. Two requests in the
  -- same millisecond cannot both find the slot free.
  perform pg_advisory_xact_lock(hashtextextended(l.client_id::text, 0));

  v_ends := p_starts_at + make_interval(mins => s.slot_minutes);

  -- The slot has to be one the computation would actually offer. Checked
  -- here rather than trusted from whatever the caller was shown, because
  -- what they were shown may be minutes old.
  if not exists (
    select 1 from public.available_slots_v6(l.client_id, s.max_days_ahead) av
     where av.starts_at = p_starts_at) then
    raise exception 'That slot is not available. Read the free slots again and choose another.'
      using errcode = 'P0001';
  end if;

  insert into public.client_appointments (
    client_id, lead_id, campaign_id, starts_at, ends_at, booked_via, booked_by)
  values (
    l.client_id, p_lead_id, coalesce(p_campaign_id, l.source_client_campaign_id),
    p_starts_at, v_ends, p_booked_via,
    case when p_booked_via = 'person' then auth.uid() else null end)
  returning * into a;

  -- The pipeline moves with it. An appointment that left the lead at `lead`
  -- is the state Sales OS could never tell apart from a booking that had not
  -- happened.
  update public.client_leads
     set stage = 'appointment', stage_at = now(), appointment_at = p_starts_at
   where id = p_lead_id
     and stage not in ('appointment', 'qualified_appointment', 'shown', 'sale', 'cash');

  insert into public.lead_events (lead_id, client_id, kind, detail)
  values (p_lead_id, l.client_id, 'appointment',
          'Booked for ' || to_char(p_starts_at at time zone s.timezone, 'FMDay DD FMMonth, HH24:MI')
          || ' (' || p_booked_via || ').');
  return a;
end $$;

-- B005 guarded RPC: record_appointment_outcome_v6 (latest definition from 20261025210000_256_taking_a_slot.sql).
create or replace function public.record_appointment_outcome_v6(
  p_appointment_id uuid, p_status text, p_note text default null)
returns public.client_appointments
language plpgsql security definer
set search_path = pg_catalog, public as $$
declare a public.client_appointments%rowtype;
begin
  select * into a from public.client_appointments where id = p_appointment_id for update;
  if not found then raise exception 'No such appointment.' using errcode = 'P0001'; end if;
  if not (coalesce(public.is_admin(), false)
          or coalesce(public.may_manage_client_leads(a.client_id), false)) then
    raise exception 'Not permitted for this client.' using errcode = 'P0001';
  end if;
  if p_status not in ('attended', 'no_show', 'cancelled') then
    raise exception 'An outcome is attended, no_show or cancelled.' using errcode = 'P0001';
  end if;
  if p_status = 'cancelled' and nullif(btrim(coalesce(p_note, '')), '') is null then
    raise exception 'Say why it was cancelled.' using errcode = 'P0001';
  end if;

  update public.client_appointments
     set status = p_status,
         outcome_note = coalesce(nullif(btrim(coalesce(p_note, '')), ''), outcome_note),
         cancelled_reason = case when p_status = 'cancelled'
                                 then btrim(p_note) else cancelled_reason end
   where id = p_appointment_id returning * into a;

  -- Attending is its own stage, because the gap between booked and attended
  -- is the no-show rate and it is usually the cheapest thing to fix.
  if p_status = 'attended' then
    update public.client_leads set stage = 'shown', stage_at = now()
     where id = a.lead_id and stage in ('appointment', 'qualified_appointment');
  end if;

  insert into public.lead_events (lead_id, client_id, kind, detail)
  values (a.lead_id, a.client_id, 'outcome',
          'Appointment ' || p_status || coalesce(': ' || btrim(p_note), '') || '.');
  return a;
end $$;

-- B005 guarded RPC: create_booking_link_v6 (latest definition from 20261025210000_256_taking_a_slot.sql).
create or replace function public.create_booking_link_v6(
  p_client_id uuid, p_purpose text, p_token_hash text,
  p_campaign_id uuid default null, p_expires_at timestamptz default null)
returns public.booking_links
language plpgsql security definer
set search_path = pg_catalog, public as $$
declare v public.booking_links%rowtype;
begin
  if not (coalesce(public.is_admin(), false)
          or coalesce(public.may_manage_client_leads(p_client_id), false)) then
    raise exception 'Not permitted for this client.' using errcode = 'P0001';
  end if;
  if p_campaign_id is not null and not exists (
    select 1 from public.client_campaigns c
     where c.id = p_campaign_id and c.client_id = p_client_id) then
    raise exception 'That campaign belongs to a different client.' using errcode = 'P0001';
  end if;
  if p_token_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'A booking token hash is 64 hex characters.' using errcode = 'P0001';
  end if;
  insert into public.booking_links (
    client_id, campaign_id, purpose, token_hash, expires_at, created_by)
  values (
    p_client_id, p_campaign_id, btrim(p_purpose), p_token_hash, p_expires_at, auth.uid())
  returning * into v;
  return v;
end $$;

-- B005 guarded RPC: capture_sales_agent_lead (latest definition from 20260908192515_67_sales_agents.sql).
create or replace function public.capture_sales_agent_lead(
  p_conversation_id uuid,
  p_opportunity_value numeric default null
)
returns uuid
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_conv   sales_agent_conversations%rowtype;
  v_lead   uuid;
  v_stage  lead_stage;
begin
  select * into v_conv from sales_agent_conversations where id = p_conversation_id;
  if v_conv.id is null then
    raise exception 'That conversation no longer exists.';
  end if;

  -- The runtime and the MCP gateway both reach this as service_role, and
  -- the sales helper admits service_role explicitly.
  if not coalesce(public.may_manage_client_leads(v_conv.client_id), false) then
    raise exception 'Not permitted for this client';
  end if;

  -- Already captured. Return what exists rather than duplicating a person.
  if v_conv.lead_id is not null then
    return v_conv.lead_id;
  end if;

  -- A lead is a name someone can contact. Without a way to reach them there
  -- is nothing for Sales Ops to do, and a pipeline padded with unreachable
  -- rows stops being a measure of anything.
  if coalesce(trim(v_conv.contact_email), '') = ''
     and coalesce(trim(v_conv.contact_phone), '') = '' then
    raise exception 'That conversation captured no way to contact anyone.';
  end if;

  -- A conversation happened, by definition — that is what this table is. So
  -- the floor is 'conversation', never 'lead', and a fit judged by the agent
  -- lifts it one stage. Nothing here claims an appointment: booking is a
  -- separate event with its own outcome.
  v_stage := case when v_conv.qualified then 'qualified_conversation' else 'conversation' end;

  insert into client_leads (
    client_id, name, email, phone, source, source_channel,
    source_page_id, source_sales_agent_id,
    stage, stage_at, opportunity_value, notes
  )
  values (
    v_conv.client_id,
    nullif(trim(coalesce(v_conv.contact_name, '')), ''),
    nullif(trim(coalesce(v_conv.contact_email, '')), ''),
    nullif(trim(coalesce(v_conv.contact_phone, '')), ''),
    'sales_agent',
    'sales_agent',
    v_conv.page_id,
    v_conv.sales_agent_id,
    v_stage,
    now(),
    p_opportunity_value,
    nullif(trim(coalesce(v_conv.outcome, '')), '')
  )
  returning id into v_lead;

  update sales_agent_conversations set lead_id = v_lead where id = p_conversation_id;

  insert into lead_events (lead_id, client_id, kind, body, from_stage, to_stage, created_by)
  values (v_lead, v_conv.client_id, 'stage_change',
          'Captured from a sales agent conversation.', null, v_stage, auth.uid());

  return v_lead;
end;
$$;

-- B005 guarded RPC: workflow_run_outcomes (latest definition from 20261012150000_196_v5_outcome_attribution.sql).
create or replace function public.workflow_run_outcomes(p_run_id uuid) returns jsonb
language plpgsql stable security definer set search_path to 'public' as $$
declare v_run workflow_runs; v_jobs record; v_leads record;
  v_assets integer; v_accepted integer; v_rejections integer;
begin
  select * into v_run from workflow_runs where id = p_run_id;
  if not found then raise exception 'No such workflow run.'; end if;
  if not coalesce(public.may_manage_client_leads(v_run.client_id), false) then
    raise exception 'Not permitted for this client.';
  end if;
  select count(*)::integer as jobs, coalesce(sum(cost_usd), 0)::numeric as cost_usd,
    count(*) filter (where status = 'failed')::integer as failed_jobs
    into v_jobs from agent_jobs where run_id = p_run_id;
  select count(*)::integer into v_assets from workflow_artifacts
    where run_id = p_run_id and artifact_kind = 'asset';
  select count(*)::integer into v_accepted from workflow_artifacts a
    join client_media_assets m on m.id = a.record_id
    where a.run_id = p_run_id and a.artifact_kind = 'asset'
      and m.human_approved_at is not null;
  select count(*)::integer into v_rejections from workflow_artifacts a
    join client_asset_reviews r on r.asset_id = a.record_id
    where a.run_id = p_run_id and a.artifact_kind = 'asset'
      and r.decision = 'rejected';
  select count(*)::integer as leads,
    count(*) filter (where a.label = 'observed')::integer as observed,
    count(*) filter (where a.label = 'estimated')::integer as estimated,
    count(*) filter (where a.label = 'unknown')::integer as unknown,
    coalesce(sum(l.cash_collected) filter (where a.label = 'observed'), 0)::numeric as observed_cash,
    coalesce(sum(l.cash_collected) filter (where a.label = 'estimated'), 0)::numeric as estimated_cash
    into v_leads from workflow_lead_attribution a
    join client_leads l on l.id = a.lead_id where a.run_id = p_run_id;
  return jsonb_build_object(
    'run_id', p_run_id, 'kind', v_run.kind, 'status', v_run.status,
    'deadline_at', v_run.deadline_at,
    'review_ready_at', v_run.review_ready_at,
    'deadline_met', case when v_run.review_ready_at is not null
      then v_run.review_ready_at <= v_run.deadline_at else null end,
    'job_count', v_jobs.jobs, 'failed_jobs', v_jobs.failed_jobs,
    'total_job_cost_usd', v_jobs.cost_usd,
    'accepted_asset_versions', v_assets,
    'human_approved_assets', v_accepted,
    'rejection_events', v_rejections,
    'linked_leads', v_leads.leads, 'observed_leads', v_leads.observed,
    'estimated_leads', v_leads.estimated, 'unknown_leads', v_leads.unknown,
    'attribution_coverage', case when v_leads.leads = 0 then null
      else round(v_leads.observed::numeric / v_leads.leads, 4) end,
    'observed_cash', case when v_leads.leads = 0 then null else v_leads.observed_cash end,
    'estimated_cash', case when v_leads.leads = 0 then null else v_leads.estimated_cash end);
end;
$$;
