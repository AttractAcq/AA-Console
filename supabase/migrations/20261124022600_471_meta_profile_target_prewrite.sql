-- Bind a Meta profile proposal to the recorded identity and credential
-- version. This is a prewrite gate only; the provider PATCH worker stays held.
begin;

alter table public.client_integrations
 add column profile_scope_epoch_v6 bigint not null default 0;
create function public.advance_meta_profile_scope_epoch_v6()
returns trigger language plpgsql security definer set search_path=pg_catalog,public as $$
begin
 if (new.client_id,new.provider,new.credential_label,new.credential_secret_id,
     new.access_level,new.meta_page_id) is distinct from
    (old.client_id,old.provider,old.credential_label,old.credential_secret_id,
     old.access_level,old.meta_page_id) then
  new.profile_scope_epoch_v6:=old.profile_scope_epoch_v6+1;
 elsif new.profile_scope_epoch_v6 is distinct from old.profile_scope_epoch_v6 then
  raise exception 'Meta profile scope epoch is system-owned.' using errcode='42501';
 end if;
 return new;
end $$;
create trigger client_integration_profile_scope_epoch_v6
 before update on public.client_integrations for each row
 execute function public.advance_meta_profile_scope_epoch_v6();
revoke all on function public.advance_meta_profile_scope_epoch_v6()
 from public,anon,authenticated,service_role;

create function public.meta_profile_target_snapshot_v6(p_client_id uuid,p_platform text)
returns jsonb language plpgsql stable security definer set search_path=pg_catalog,public as $$
declare i public.client_integrations%rowtype;
 q public.integration_grant_reviews_v6%rowtype;
 provider_name text; row_count integer;
begin
 provider_name:=case p_platform when 'facebook' then 'meta'
   when 'instagram' then 'instagram' else null end;
 if provider_name is null then return jsonb_build_object('binding_state','unsupported_platform'); end if;
 select count(*) into row_count from public.client_integrations
  where client_id=p_client_id and provider=provider_name;
 if row_count<>1 then
  return jsonb_build_object('binding_state','missing_or_ambiguous',
   'provider',provider_name);
 end if;
 select * into i from public.client_integrations
  where client_id=p_client_id and provider=provider_name;
 select * into q from public.integration_grant_reviews_v6
  where integration_id=i.id order by request_epoch desc limit 1;
 return jsonb_build_object('binding_state','recorded','provider',provider_name,
  'integration_id',i.id,
  'integration_scope_epoch',i.profile_scope_epoch_v6,
  'account_ref',case when p_platform='facebook' then i.meta_page_id
   else i.credential_label end,
  'credential_version_hash',case when i.credential_secret_id is null then null
   else encode(sha256(convert_to(i.credential_secret_id::text,'UTF8')),'hex') end,
  'grant_review_id',q.id,'grant_request_token',q.request_token);
end $$;
revoke all on function public.meta_profile_target_snapshot_v6(uuid,text)
 from public,anon,authenticated,service_role;

create or replace function public.meta_profile_review_preview_v6(q public.meta_profile_review_requests_v6)
returns jsonb language sql stable security definer set search_path=pg_catalog,public as $$
 select jsonb_build_object('client_id',m.client_id,'change_id',m.id,
  'request_token',q.request_token,'platform',m.platform,'field',m.field,
  'review_epoch',m.review_epoch_v6,
  'current_value',m.current_value,'proposed_value',m.proposed_value,
  'offer_version_id',m.offer_version_id,'reason',m.reason,
  'target',public.meta_profile_target_snapshot_v6(m.client_id,m.platform),
  'consequence','Approve these exact before/after words as a proposal; provider application remains held')
 from public.meta_profile_changes m where m.id=q.change_id and m.client_id=q.client_id;
$$;

create function public.meta_profile_write_credential_eligible_v6(p_client_id uuid)
returns boolean language plpgsql stable security definer set search_path=pg_catalog,public as $$
declare i public.client_integrations%rowtype;
 q public.integration_grant_reviews_v6%rowtype;
 r public.approval_requests_v6%rowtype;
 d public.approval_decision_events_v6%rowtype;
begin
 if auth.role() is distinct from 'service_role' then return false; end if;
 if (select count(*) from public.client_integrations
   where client_id=p_client_id and provider='meta')<>1 then return false; end if;
 select * into i from public.client_integrations
  where client_id=p_client_id and provider='meta';
 if i.id is null or i.credential_secret_id is null
  or i.access_level not in ('write','admin')
  or coalesce(i.meta_page_id,'') !~ '^[0-9]+$'
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
  or r.preview->>'recorded_meta_page_id' is distinct from i.meta_page_id
  or r.preview->>'access_level' is distinct from i.access_level
  or r.preview->'recorded_expiry' is distinct from
    coalesce(to_jsonb(i.token_expires_at),'null'::jsonb)
  or r.preview->>'credential_version_hash' is distinct from
    encode(sha256(convert_to(i.credential_secret_id::text,'UTF8')),'hex')
  then return false; end if;
 return true;
end $$;
revoke all on function public.meta_profile_write_credential_eligible_v6(uuid)
 from public,anon,authenticated,service_role;
grant execute on function public.meta_profile_write_credential_eligible_v6(uuid)
 to service_role;

create function public.meta_profile_prewrite_current_v6(p_change_id uuid)
returns boolean language plpgsql stable security definer set search_path=pg_catalog,public as $$
declare m public.meta_profile_changes%rowtype;
 q public.meta_profile_review_requests_v6%rowtype;
 r public.approval_requests_v6%rowtype;
 d public.approval_decision_events_v6%rowtype;
 target jsonb;
begin
 if auth.role() is distinct from 'service_role' then return false; end if;
 select * into m from public.meta_profile_changes where id=p_change_id;
 if m.id is null or m.status<>'approved' or m.platform<>'facebook'
  or m.approved_request_id is null then return false; end if;
 if not exists(select 1 from public.profile_field_support f
  where f.surface='meta' and f.platform='facebook'
   and f.field=m.field and f.writable) then return false; end if;
 select * into q from public.meta_profile_review_requests_v6
  where canonical_request_id=m.approved_request_id and change_id=m.id
   and client_id=m.client_id;
 if q.id is null or q.source_hash is distinct from m.approved_content_hash
  or public.meta_profile_review_source_state_v6(q.canonical_request_id)<>'source_decided'
  then return false; end if;
 select * into r from public.approval_requests_v6 where id=q.canonical_request_id;
 select * into d from public.approval_decision_events_v6
  where request_id=r.id order by event_order desc limit 1;
 target:=r.preview->'target';
 if r.id is null or r.client_id is distinct from m.client_id
  or r.artifact_hash is distinct from q.source_hash
  or target->>'provider' is distinct from 'meta'
  or coalesce(target->>'account_ref','') !~ '^[0-9]+$'
  or target is distinct from public.meta_profile_target_snapshot_v6(m.client_id,m.platform)
  or d.decision is distinct from 'approved' or d.actor_aal is distinct from 'aal2'
  or d.artifact_hash is distinct from q.source_hash
  or exists(select 1 from public.delivery_approval_invalidations_v6 x
    where x.approval_request_id=r.id)
  or not exists(select 1 from public.approval_inbox_v6 x
    where x.id=r.id and x.status='approved')
  then return false; end if;
 return public.meta_profile_write_credential_eligible_v6(m.client_id);
end $$;
revoke all on function public.meta_profile_prewrite_current_v6(uuid)
 from public,anon,authenticated,service_role;
grant execute on function public.meta_profile_prewrite_current_v6(uuid)
 to service_role;

select public.lock_down_definer_functions();
commit;
