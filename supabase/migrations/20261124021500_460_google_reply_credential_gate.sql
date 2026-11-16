-- A legacy connected credential is not enough authority to answer a review.
-- The sender requires a current exact access grant for write use, then probes
-- the target Google account before the provider write.
begin;

create function public.google_reply_credential_eligible_v6(p_client_id uuid)
returns boolean language plpgsql stable security definer
set search_path=pg_catalog,public as $$
declare
  i public.client_integrations%rowtype;
  q public.integration_grant_reviews_v6%rowtype;
  r public.approval_requests_v6%rowtype;
  d public.approval_decision_events_v6%rowtype;
begin
  if auth.role() is distinct from 'service_role' then return false; end if;
  if (select count(*) from public.client_integrations
      where client_id=p_client_id and provider='google_business') <> 1 then return false; end if;
  select * into i from public.client_integrations
    where client_id=p_client_id and provider='google_business';
  if i.id is null or i.credential_secret_id is null
    or i.access_level not in ('write','admin')
    or not public.integration_state_eligible(i.status,i.token_expires_at)
    or public.integration_secret(p_client_id,'google_business') is null
    then return false; end if;
  select * into q from public.integration_grant_reviews_v6
    where integration_id=i.id order by request_epoch desc limit 1;
  if q.id is null or q.applied_at is null or q.client_id is distinct from p_client_id
    or q.canonical_request_id is null then return false; end if;
  select * into r from public.approval_requests_v6 where id=q.canonical_request_id;
  select * into d from public.approval_decision_events_v6
    where request_id=r.id order by event_order desc limit 1;
  if r.id is null or r.client_id is distinct from p_client_id
    or r.source_kind<>'integration_grant' or r.source_id is distinct from q.id::text
    or r.artifact_hash is distinct from q.source_hash
    or d.decision is distinct from 'approved' or d.actor_aal is distinct from 'aal2'
    or d.actor_id is distinct from q.applied_by
    or d.artifact_hash is distinct from q.source_hash
    or exists(select 1 from public.delivery_approval_invalidations_v6 x
      where x.approval_request_id=r.id)
    or r.preview->>'provider' is distinct from 'google_business'
    or r.preview->>'account_label' is distinct from i.credential_label
    or r.preview->>'access_level' is distinct from i.access_level
    or r.preview->'recorded_expiry' is distinct from
      coalesce(to_jsonb(i.token_expires_at),'null'::jsonb)
    or r.preview->>'credential_version_hash' is distinct from
      encode(sha256(convert_to(i.credential_secret_id::text,'UTF8')),'hex')
    then return false; end if;
  return true;
end $$;

revoke all on function public.google_reply_credential_eligible_v6(uuid)
  from public,anon,authenticated,service_role;
grant execute on function public.google_reply_credential_eligible_v6(uuid)
  to service_role;

insert into public.approval_class_coverage_versions_v6
 (class_id,revision,class_key,title,source_state,source_evidence,
  decision_state,decision_evidence,executor_state,executor_evidence,blocker)
values (21,4,'google_review_reply','Google review reply',
 'verified','278 exact reply, review and location preview',
 'verified','278 source-owned AAL2 Inbox decision',
 'blocked','456 current prewrite; 457 one-shot attempt/readback ledger; 458 controlled job; 459 current write-grant predicate and provider account probe',
 'Audit legacy replies and credential grants, verify the Google account and scopes live, then observe an authorized provider readback receipt.');

select public.lock_down_definer_functions();
commit;
