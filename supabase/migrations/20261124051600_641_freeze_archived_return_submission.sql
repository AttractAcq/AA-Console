-- A held consent/source packet cannot be rewritten or promoted by a direct
-- service update. Only the exact recorded AAL2 resolution may promote it.
begin;
create function public.guard_archived_return_submission_v11()
returns trigger language plpgsql security definer
set search_path=pg_catalog,public as $$
begin
  if old.archive_match_lead_id is null then
    if new.archive_match_lead_id is not null
       and (old.status<>'received' or new.status<>'received'
         or new.lead_id is not null) then
      raise exception 'An archived match may only hold a received submission.'
        using errcode='23514';
    end if;
    return new;
  end if;
  if new.archive_match_lead_id is distinct from old.archive_match_lead_id
     or new.client_id is distinct from old.client_id
     or new.endpoint_id is distinct from old.endpoint_id
     or new.name is distinct from old.name
     or new.email is distinct from old.email
     or new.phone is distinct from old.phone
     or new.message is distinct from old.message
     or new.consent_wording is distinct from old.consent_wording
     or new.consent_given_at is distinct from old.consent_given_at
     or new.consent_evidence is distinct from old.consent_evidence
     or new.click_id is distinct from old.click_id
     or new.utm is distinct from old.utm
     or new.idempotency_key is distinct from old.idempotency_key
     or new.route_package_id is distinct from old.route_package_id then
    raise exception 'Held return source and consent are immutable.'
      using errcode='23514';
  end if;
  if new.status is distinct from old.status
     or new.lead_id is distinct from old.lead_id then
    if old.status<>'received' or old.lead_id is not null
       or new.status<>'promoted' or new.lead_id is null
       or not exists (
         select 1 from public.lead_return_resolutions_v11 r
         where r.submission_id=old.id and r.client_id=old.client_id
           and r.archived_lead_id=old.archive_match_lead_id
           and r.resolved_lead_id=new.lead_id and r.reviewer_aal='aal2'
       ) then
      raise exception 'Held return needs its exact AAL2 resolution.'
        using errcode='23514';
    end if;
  end if;
  return new;
end $$;
revoke all on function public.guard_archived_return_submission_v11()
  from public,anon,authenticated,service_role;
create trigger lead_submission_archived_return_guard_v11
  before update on public.lead_submissions
  for each row execute function public.guard_archived_return_submission_v11();
select public.lock_down_definer_functions();
commit;
