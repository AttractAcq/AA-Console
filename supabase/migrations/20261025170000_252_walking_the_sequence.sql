-- G11, the engine: approving a sequence, enrolling leads, and walking them.
--
-- The one thing in here worth reading twice is `sequence_exit_reason_v6`.
-- Everything else is bookkeeping; that function is what stops the system
-- asking somebody who booked a call on Tuesday whether they are still
-- thinking it over.

-- ---------------------------------------------------------------------------
-- Approving the shape
-- ---------------------------------------------------------------------------

create or replace function public.approve_nurture_sequence_v6(p_sequence_id uuid)
returns public.nurture_sequences language plpgsql security definer
set search_path = pg_catalog, public as $$
declare
  s public.nurture_sequences%rowtype;
  v_steps integer;
  v_unapproved text;
begin
  select * into s from public.nurture_sequences where id = p_sequence_id for update;
  if not found then raise exception 'No such sequence.' using errcode = 'P0001'; end if;
  if auth.role() is distinct from 'authenticated'
     or not (coalesce(public.is_admin(), false)
             or coalesce(auth.uid() = public.active_video_approval_manager(s.client_id), false)) then
    raise exception 'A signed-in admin or the assigned client manager must approve a sequence.'
      using errcode = 'P0001';
  end if;

  select count(*)::int into v_steps from public.nurture_sequence_steps
   where sequence_id = p_sequence_id;
  if v_steps = 0 then
    raise exception 'That sequence has no steps.' using errcode = 'P0001';
  end if;

  -- Approving the shape must not quietly authorise unapproved words.
  select string_agg('step ' || st.position::text, ', ' order by st.position)
    into v_unapproved
    from public.nurture_sequence_steps st
   where st.sequence_id = p_sequence_id
     and not exists (
       select 1 from public.message_template_approvals a
        where a.template_version_id = st.template_version_id and a.status = 'approved');
  if v_unapproved is not null then
    raise exception 'These steps carry words nobody has approved: %. Approve each message version first.',
      v_unapproved using errcode = 'P0001';
  end if;

  update public.nurture_sequences
     set approved_at = now(), approved_by = auth.uid()
   where id = p_sequence_id returning * into s;
  return s;
end $$;

revoke all on function public.approve_nurture_sequence_v6(uuid) from public, anon;
grant execute on function public.approve_nurture_sequence_v6(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- The exit check, run before every step
-- ---------------------------------------------------------------------------

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

  select * into l from public.client_leads where id = p_lead_id;
  if not found then return 'The lead no longer exists.'; end if;

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

comment on function public.sequence_exit_reason_v6(uuid, uuid) is
  'Why this lead should stop receiving this sequence, or null. Run immediately before every step rather than only at enrolment: a lead who books a call on Tuesday must not be asked on Wednesday whether they are still thinking.';

revoke all on function public.sequence_exit_reason_v6(uuid, uuid) from public, anon;
grant execute on function public.sequence_exit_reason_v6(uuid, uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Enrolling
-- ---------------------------------------------------------------------------

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
              or coalesce(public.can_access_client(l.client_id), false)) then
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

revoke all on function public.enroll_lead_in_sequence_v6(uuid, uuid) from public, anon;
grant execute on function public.enroll_lead_in_sequence_v6(uuid, uuid)
  to authenticated, service_role;

-- Automatic enrolment, for sequences that asked for it.
create or replace function public.enroll_due_leads_v6(p_limit integer default 50)
returns integer language plpgsql security definer
set search_path = pg_catalog, public as $$
declare
  r record;
  v_count integer := 0;
begin
  if auth.role() <> 'service_role' then
    raise exception 'Only the internal service may enrol leads automatically.';
  end if;

  for r in
    select l.id as lead_id, s.id as sequence_id
      from public.nurture_sequences s
      join public.client_leads l on l.client_id = s.client_id
     where s.enrolled_automatically
       and s.approved_at is not null
       and s.archived_at is null
       and l.stage = s.trigger_stage
       and l.stage_at <= now() - make_interval(hours => s.trigger_after_hours)
       and not l.is_probe
       and not exists (
         select 1 from public.lead_sequence_enrollments e
          where e.lead_id = l.id and e.sequence_id = s.id)
     limit greatest(coalesce(p_limit, 50), 1)
  loop
    -- Per-lead, because one lead failing its exit check must not stop the
    -- rest of the sweep.
    begin
      perform public.enroll_lead_in_sequence_v6(r.lead_id, r.sequence_id);
      v_count := v_count + 1;
    exception when others then
      null;
    end;
  end loop;
  return v_count;
end $$;

revoke all on function public.enroll_due_leads_v6(integer) from public, anon, authenticated;
grant execute on function public.enroll_due_leads_v6(integer) to service_role;

-- ---------------------------------------------------------------------------
-- Walking it
-- ---------------------------------------------------------------------------

create or replace function public.advance_sequences_v6(p_limit integer default 50)
returns integer language plpgsql security definer
set search_path = pg_catalog, public as $$
declare
  r record;
  v_reason text;
  v_step public.nurture_sequence_steps%rowtype;
  v_next public.nurture_sequence_steps%rowtype;
  v_sent integer := 0;
begin
  if auth.role() <> 'service_role' then
    raise exception 'Only the internal service may advance sequences.';
  end if;

  for r in
    select e.* from public.lead_sequence_enrollments e
     where e.status = 'active' and e.next_due_at <= now()
     order by e.next_due_at
     limit greatest(coalesce(p_limit, 50), 1)
  loop
    -- The check that matters, immediately before the step.
    v_reason := public.sequence_exit_reason_v6(r.lead_id, r.sequence_id);
    if v_reason is not null then
      -- Exited, not skipped: skipping would leave them enrolled and exposed
      -- to the step after this one.
      update public.lead_sequence_enrollments
         set status = 'exited', exit_reason = v_reason, exited_at = now(), next_due_at = null
       where id = r.id;
      continue;
    end if;

    select * into v_step from public.nurture_sequence_steps
     where sequence_id = r.sequence_id
       and position > coalesce(r.last_step, 0)
     order by position limit 1;

    if not found then
      update public.lead_sequence_enrollments
         set status = 'completed', next_due_at = null
       where id = r.id;
      continue;
    end if;

    -- queue_lead_message_v6 can refuse for reasons that are temporary -- the
    -- client's daily cap, most often. That must not exit the lead or burn
    -- the step; it leaves them due and the next sweep tries again.
    begin
      perform public.queue_lead_message_v6(r.lead_id, v_step.template_version_id);
    exception when others then
      update public.lead_sequence_enrollments
         set next_due_at = now() + interval '1 hour'
       where id = r.id;
      continue;
    end;

    select * into v_next from public.nurture_sequence_steps
     where sequence_id = r.sequence_id and position > v_step.position
     order by position limit 1;

    update public.lead_sequence_enrollments
       set last_step = v_step.position,
           last_sent_at = now(),
           status = case when v_next.id is null then 'completed' else 'active' end,
           next_due_at = case when v_next.id is null then null
                              else now() + make_interval(hours => v_next.delay_hours) end
     where id = r.id;
    v_sent := v_sent + 1;
  end loop;
  return v_sent;
end $$;

comment on function public.advance_sequences_v6(integer) is
  'Queues the next due step for each active enrolment, exiting any lead whose exit condition has become true. A temporary refusal from the send path delays the step rather than exiting the lead or burning it.';

revoke all on function public.advance_sequences_v6(integer) from public, anon, authenticated;
grant execute on function public.advance_sequences_v6(integer) to service_role;

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
              or coalesce(public.can_access_client(e.client_id), false)) then
    raise exception 'Not permitted for this client.' using errcode = 'P0001';
  end if;
  if nullif(btrim(coalesce(p_reason, '')), '') is null then
    raise exception 'Say why they were taken out.' using errcode = 'P0001';
  end if;
  update public.lead_sequence_enrollments
     set status = 'exited', exit_reason = btrim(p_reason), exited_at = now(), next_due_at = null
   where id = p_enrollment_id;
end $$;

revoke all on function public.exit_lead_from_sequence_v6(uuid, text) from public, anon;
grant execute on function public.exit_lead_from_sequence_v6(uuid, text)
  to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- What is happening, and what is stopping it
-- ---------------------------------------------------------------------------

drop view if exists nurture_sequence_due;

create view nurture_sequence_due with (security_invoker = true) as
select
  s.id as sequence_id,
  s.client_id,
  s.name,
  s.purpose,
  s.campaign_id,
  s.trigger_stage,
  s.enrolled_automatically,
  s.approved_at,
  (select count(*) from public.nurture_sequence_steps st where st.sequence_id = s.id)::int as steps,
  (select count(*) from public.lead_sequence_enrollments e
    where e.sequence_id = s.id and e.status = 'active')::int as active,
  (select count(*) from public.lead_sequence_enrollments e
    where e.sequence_id = s.id and e.status = 'completed')::int as completed,
  (select count(*) from public.lead_sequence_enrollments e
    where e.sequence_id = s.id and e.status = 'exited')::int as exited,
  case
    when s.archived_at is not null then 'Archived.'
    when (select count(*) from public.nurture_sequence_steps st
           where st.sequence_id = s.id) = 0 then 'It has no steps.'
    when s.approved_at is null
      then 'Nobody has approved the shape of this sequence' ||
           case when exists (
             select 1 from public.nurture_sequence_steps st
              where st.sequence_id = s.id and not exists (
                select 1 from public.message_template_approvals a
                 where a.template_version_id = st.template_version_id
                   and a.status = 'approved'))
           then ', and some of its steps carry words nobody has approved either.'
           else '.' end
    when not coalesce(ces.outbound_messaging_enabled, false)
      then 'Outbound messaging is off for this client, so no step will leave.'
    when not s.enrolled_automatically
      then 'Approved, and nobody is enrolled automatically. Leads have to be added by hand.'
    else null
  end as blocker
from public.nurture_sequences s
left join public.client_engine_settings ces on ces.client_id = s.client_id;

comment on view nurture_sequence_due is
  'Each sequence, how many people are walking it, and what is stopping it. The blocker distinguishes an unapproved shape from unapproved words inside it, because they are fixed in different places.';

grant select on nurture_sequence_due to authenticated;

-- ---------------------------------------------------------------------------
-- The sweep
-- ---------------------------------------------------------------------------

create or replace function public.enqueue_sequence_sweep()
returns uuid language plpgsql security definer
set search_path to 'public' as $$
declare v_job uuid;
begin
  if exists (select 1 from agent_jobs
              where agent_key = 'nurture_sequencer'
                and status in ('queued', 'claimed', 'running')) then
    return null;
  end if;
  -- Something to enrol, or something due. Otherwise the cron costs one query.
  if not exists (
       select 1 from lead_sequence_enrollments
        where status = 'active' and next_due_at <= now())
     and not exists (
       select 1 from nurture_sequences s
        where s.enrolled_automatically and s.approved_at is not null
          and s.archived_at is null) then
    return null;
  end if;
  insert into agent_jobs (agent_key, params)
  values ('nurture_sequencer', jsonb_build_object('limit', 50))
  returning id into v_job;
  return v_job;
end $$;

revoke all on function public.enqueue_sequence_sweep() from public, anon;
grant execute on function public.enqueue_sequence_sweep() to authenticated, service_role;

insert into agents (agent_key, name, initials, domain, description, requires_upstream) values
  ('nurture_sequencer', 'Nurture Sequencer', 'NS', null,
   'Enrols leads into approved sequences and queues each due step, checking before every step whether the sequence has stopped being relevant to that person.',
   array[]::text[])
on conflict (agent_key) do update
  set name = excluded.name, initials = excluded.initials,
      description = excluded.description, requires_upstream = excluded.requires_upstream;

-- Every fifteen minutes. A step's delay is in hours, so this lands it within
-- fifteen minutes of its hour, which is closer than a person would manage.
select cron.unschedule('nurture-sequence-sweep')
 where exists (select 1 from cron.job where jobname = 'nurture-sequence-sweep');
select cron.schedule('nurture-sequence-sweep', '*/15 * * * *',
  $cron$ select public.enqueue_sequence_sweep(); $cron$);

select lock_down_definer_functions();
