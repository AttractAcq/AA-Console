-- An approved credential cannot silently acquire a new account, Page, Pixel
-- or later recorded expiry. Moving its scope returns it to pending review.
begin;
create function public.revoke_integration_grant_on_scope_change_v6()
returns trigger language plpgsql security definer set search_path=pg_catalog,public as $$
begin
 if current_setting('aa.integration_store',true)='on' then return new; end if;
 if old.status not in ('connected','active','expiring','error') then return new; end if;
 if new.credential_label is distinct from old.credential_label
  or new.ad_account_id is distinct from old.ad_account_id
  or new.google_ads_customer_id is distinct from old.google_ads_customer_id
  or new.meta_page_id is distinct from old.meta_page_id
  or new.meta_pixel_id is distinct from old.meta_pixel_id
  or (old.token_expires_at is not null and new.token_expires_at>old.token_expires_at) then
  new.status:='pending_grant';
  new.ingest_enabled:=false;
  new.last_checked_at:=null;
 end if;
 return new;
end $$;
create trigger client_integration_scope_revision_v6 before update on public.client_integrations
 for each row execute function public.revoke_integration_grant_on_scope_change_v6();

create or replace function public.integration_grant_preview_v6(q public.integration_grant_reviews_v6)
returns jsonb language sql stable security definer set search_path=pg_catalog,public as $$
 select jsonb_build_object(
  'client_id',q.client_id,'integration_id',q.integration_id,
  'request_token',q.request_token,'action','grant_provider_access',
  'provider',i.provider,'account_label',i.credential_label,
  'access_level',i.access_level,'recorded_status',i.status,
  'recorded_expiry',i.token_expires_at,
  'recorded_account_id',i.ad_account_id,
  'recorded_google_ads_customer_id',i.google_ads_customer_id,
  'recorded_meta_page_id',i.meta_page_id,
  'recorded_meta_pixel_id',i.meta_pixel_id,
  'credential_version_hash',encode(sha256(convert_to(i.credential_secret_id::text,'UTF8')),'hex'),
  'enable_daily_ingest',q.enable_ingest,
  'scope','Use this credential for this client and provider until revoked or expired',
  'consequence',case when q.enable_ingest then
   'Permit provider credential reads and recurring daily metrics pulls'
   else 'Permit provider credential reads; recurring metrics pulls remain off' end,
  'verification_note','Recorded metadata does not prove live provider identity or granted scopes; each external action needs a separate preflight and approval')
 from public.client_integrations i where i.id=q.integration_id and i.client_id=q.client_id;
$$;
comment on function public.revoke_integration_grant_on_scope_change_v6() is
 'Account/Page/Pixel changes and recorded expiry extension disable credential use and daily ingest until a new exact grant.';
revoke all on function public.revoke_integration_grant_on_scope_change_v6() from public,anon,authenticated,service_role;
select public.lock_down_definer_functions();
commit;
