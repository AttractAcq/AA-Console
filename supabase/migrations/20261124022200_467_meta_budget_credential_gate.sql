-- A reviewed spend change also needs a current grant for its Meta write token.
begin;

create function public.meta_budget_credential_eligible_v6(p_client_id uuid)
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
     where client_id=p_client_id and provider='meta') <> 1 then return false; end if;
 select * into i from public.client_integrations
  where client_id=p_client_id and provider='meta';
 if i.id is null or i.credential_secret_id is null
  or i.access_level not in ('write','admin')
  or coalesce(i.ad_account_id,'') !~ '^act_[0-9]+$'
  or not public.integration_state_eligible(i.status,i.token_expires_at)
  or public.integration_secret(p_client_id,'meta') is null
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
  or r.preview->>'provider' is distinct from 'meta'
  or r.preview->>'account_label' is distinct from i.credential_label
  or r.preview->>'recorded_account_id' is distinct from i.ad_account_id
  or r.preview->>'access_level' is distinct from i.access_level
  or r.preview->'recorded_expiry' is distinct from
    coalesce(to_jsonb(i.token_expires_at),'null'::jsonb)
  or r.preview->>'credential_version_hash' is distinct from
    encode(sha256(convert_to(i.credential_secret_id::text,'UTF8')),'hex')
  then return false; end if;
 return true;
end $$;

revoke all on function public.meta_budget_credential_eligible_v6(uuid)
 from public,anon,authenticated,service_role;
grant execute on function public.meta_budget_credential_eligible_v6(uuid)
 to service_role;

select public.lock_down_definer_functions();
commit;
