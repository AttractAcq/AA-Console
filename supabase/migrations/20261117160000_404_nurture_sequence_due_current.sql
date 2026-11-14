-- Show legacy and stale sequence approvals as blocked.
begin;
create or replace view nurture_sequence_due with (security_invoker = true) as
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
    when not public.nurture_sequence_approval_current_v6(s.id)
      then 'The sequence lacks a current exact Inbox approval' ||
           case when exists (
             select 1 from public.nurture_sequence_steps st
              where st.sequence_id = s.id and not exists (
                select 1 from public.message_template_approvals a
                 where a.template_version_id = st.template_version_id
                   and public.message_template_approval_current_v6(a.id)))
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
commit;
