-- A completed dependent row survives lead archive. Changing its status must
-- not put an archived lead back into an operational queue.
begin;
create function public.guard_archived_lead_reactivation_v11()
returns trigger language plpgsql security definer
set search_path=pg_catalog,public as $$
declare v_lead uuid; v_actionable boolean;
begin
  if new.status is not distinct from old.status then return new; end if;
  if tg_table_name='proof_request_deliveries' then
    v_lead:=new.outcome_lead_id;
  else
    v_lead:=new.lead_id;
  end if;
  if v_lead is null then return new; end if;
  v_actionable:=case tg_table_name
    when 'outbound_messages' then new.status not in ('sent','cancelled')
    when 'lead_sequence_enrollments' then new.status='active'
    when 'client_appointments' then new.status='booked'
    when 'lead_magnet_deliveries' then new.status not in ('sent','cancelled')
    when 'proof_request_deliveries' then new.status not in ('sent','cancelled')
    when 'dm_conversations' then new.status='open'
    else false end;
  if not v_actionable then return new; end if;
  -- Serialize this status change with archive_lead's FOR UPDATE lock.
  if not exists (select 1 from public.client_leads l
      where l.id=v_lead and l.client_id=new.client_id for key share) then
    raise exception 'An archived lead cannot be returned to active work.'
      using errcode='23503';
  end if;
  return new;
end $$;
revoke all on function public.guard_archived_lead_reactivation_v11()
  from public,anon,authenticated,service_role;
create trigger outbound_messages_status_active_guard_v11
  before update of status on public.outbound_messages
  for each row execute function public.guard_archived_lead_reactivation_v11();
create trigger lead_sequence_enrollments_status_active_guard_v11
  before update of status on public.lead_sequence_enrollments
  for each row execute function public.guard_archived_lead_reactivation_v11();
create trigger client_appointments_status_active_guard_v11
  before update of status on public.client_appointments
  for each row execute function public.guard_archived_lead_reactivation_v11();
create trigger lead_magnet_deliveries_status_active_guard_v11
  before update of status on public.lead_magnet_deliveries
  for each row execute function public.guard_archived_lead_reactivation_v11();
create trigger proof_request_deliveries_status_active_guard_v11
  before update of status on public.proof_request_deliveries
  for each row execute function public.guard_archived_lead_reactivation_v11();
create trigger dm_conversations_status_active_guard_v11
  before update of status on public.dm_conversations
  for each row execute function public.guard_archived_lead_reactivation_v11();
select public.lock_down_definer_functions();
commit;
