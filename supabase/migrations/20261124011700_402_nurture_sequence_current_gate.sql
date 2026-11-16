-- Existing enrolments and the sequencer both recheck current exact approval.
begin;
create function public.nurture_sequence_approval_current_v6(p_sequence_id uuid)
returns boolean language plpgsql stable security definer set search_path=pg_catalog,public as $$
declare s public.nurture_sequences%rowtype;
 q public.nurture_sequence_review_requests_v6%rowtype;
 e public.approval_decision_events_v6%rowtype;
begin
 select * into s from public.nurture_sequences where id=p_sequence_id;
 if s.id is null or s.approved_at is null or s.approved_request_id is null
  or s.archived_at is not null then return false; end if;
 select * into q from public.nurture_sequence_review_requests_v6
  where canonical_request_id=s.approved_request_id and sequence_id=s.id and client_id=s.client_id;
 select * into e from public.approval_decision_events_v6 where request_id=s.approved_request_id
  order by event_order desc limit 1;
 if q.id is null or e.id is null or e.decision<>'approved' or e.actor_aal<>'aal2'
  or e.artifact_hash is distinct from q.source_hash
  or s.approved_content_hash is distinct from q.source_hash
  or not public.nurture_sequence_steps_ready_v6(s.id)
  or not exists(select 1 from public.approval_inbox_v6 i
   where i.id=s.approved_request_id and i.status='approved'
    and i.source_state='source_decided' and i.preview_blocker is null)
  then return false; end if;
 return true;
end $$;
revoke all on function public.nurture_sequence_approval_current_v6(uuid) from public,anon,authenticated,service_role;
grant execute on function public.nurture_sequence_approval_current_v6(uuid) to authenticated,service_role;

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
  if not public.nurture_sequence_approval_current_v6(s.id) then
    return 'The sequence lacks a current exact Inbox approval or a step approval changed.';
  end if;
  return null;
end $$;
select public.lock_down_definer_functions();
commit;
