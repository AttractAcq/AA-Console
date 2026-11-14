-- A stored credential is not permission to use it. Newly stored versions stay
-- unavailable until an exact AAL2 grant is decided in the client Inbox.
begin;
create table public.integration_grant_reviews_v6 (
 id uuid primary key default gen_random_uuid(),
 request_epoch bigint generated always as identity unique,
 client_id uuid not null references public.clients(id) on delete cascade,
 integration_id uuid not null references public.client_integrations(id) on delete cascade,
 enable_ingest boolean not null default false,
 request_token uuid not null default gen_random_uuid(),
 source_hash text not null default repeat('0',64) check(source_hash ~ '^[0-9a-f]{64}$'),
 canonical_request_id uuid unique references public.approval_requests_v6(id),
 applied_at timestamptz,
 applied_by uuid references auth.users(id),
 created_at timestamptz not null default now()
);
create index integration_grant_latest_v6 on public.integration_grant_reviews_v6
 (integration_id,request_epoch desc);
alter table public.integration_grant_reviews_v6 enable row level security;
revoke all on public.integration_grant_reviews_v6 from public,anon,authenticated,service_role;

create function public.integration_grant_preview_v6(q public.integration_grant_reviews_v6)
returns jsonb language sql stable security definer set search_path=pg_catalog,public as $$
 select jsonb_build_object(
  'client_id',q.client_id,'integration_id',q.integration_id,
  'request_token',q.request_token,'action','grant_provider_access',
  'provider',i.provider,'account_label',i.credential_label,
  'access_level',i.access_level,'recorded_status',i.status,
  'recorded_expiry',i.token_expires_at,
  'recorded_account_id',i.ad_account_id,
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
create function public.integration_grant_hash_v6(q public.integration_grant_reviews_v6)
returns text language sql stable security definer set search_path=pg_catalog,public as $$
 select encode(sha256(convert_to((public.integration_grant_preview_v6(q)-'request_token')::text,'UTF8')),'hex');
$$;
create function public.integration_grant_scope_v6(q public.integration_grant_reviews_v6)
returns jsonb language sql stable security definer set search_path=pg_catalog,public as $$
 select jsonb_build_object('client_id',q.client_id,'integration_id',q.integration_id,
  'review_id',q.id,'request_token',q.request_token,
  'content_hash',public.integration_grant_hash_v6(q),
  'enable_daily_ingest',q.enable_ingest,'effect','grant_client_provider_credential_use');
$$;

create function public.integration_grant_source_state_v6(p_request_id uuid)
returns text language plpgsql stable security definer set search_path=pg_catalog,public as $$
declare r public.approval_requests_v6%rowtype; q public.integration_grant_reviews_v6%rowtype;
 i public.client_integrations%rowtype; h text;
begin
 select * into r from public.approval_requests_v6 where id=p_request_id;
 if r.id is null or r.source_system<>'aa_console' or r.source_kind<>'integration_grant'
  or r.source_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  then return 'unverified'; end if;
 if auth.role() is distinct from 'service_role' and
  (auth.role() is distinct from 'authenticated' or not public.can_access_client(r.client_id))
  then return 'unverified'; end if;
 select * into q from public.integration_grant_reviews_v6
  where id=r.source_id::uuid and canonical_request_id=r.id and client_id=r.client_id;
 if q.id is null then return 'cancelled'; end if;
 if exists(select 1 from public.integration_grant_reviews_v6 n
  where n.integration_id=q.integration_id and n.request_epoch>q.request_epoch)
  then return 'superseded'; end if;
 select * into i from public.client_integrations where id=q.integration_id and client_id=q.client_id;
 if i.id is null then return 'cancelled'; end if;
 if q.applied_at is not null then
  if i.status in ('connected','active','expiring') and
   (not q.enable_ingest or i.ingest_enabled) and exists(
    select 1 from public.approval_decision_events_v6 d where d.request_id=r.id
     and d.decision='approved' and d.actor_aal='aal2' and d.actor_id=q.applied_by
     and d.artifact_hash=q.source_hash and r.artifact_hash=q.source_hash)
   then return 'source_decided'; end if;
  return 'source_held';
 end if;
 h:=public.integration_grant_hash_v6(q);
 if h is null or q.source_hash is distinct from h or r.artifact_hash is distinct from h
  or r.source_version is distinct from h||':'||q.request_token::text
  or r.preview is distinct from public.integration_grant_preview_v6(q)
  or r.scope is distinct from public.integration_grant_scope_v6(q)
  or r.destination is distinct from ('client:integration:'||q.client_id::text||':'||q.integration_id::text)
  or r.owner_role is distinct from 'admin' then return 'superseded'; end if;
 if i.credential_secret_id is null or coalesce(i.access_level,'') not in ('read','write','admin')
  or nullif(btrim(coalesce(i.credential_label,'')),'') is null
  or (i.token_expires_at is not null and i.token_expires_at<=now())
  then return 'source_held'; end if;
 if i.status='pending_grant' then return 'pending'; end if;
 if q.enable_ingest and i.provider in ('meta','instagram')
  and i.status in ('connected','active','expiring') and not i.ingest_enabled
  then return 'pending'; end if;
 return 'source_held';
end $$;

create function public.request_integration_grant_v6(p_integration_id uuid,p_enable_ingest boolean default false)
returns uuid language plpgsql volatile security definer set search_path=pg_catalog,public set timezone='UTC' as $$
declare i public.client_integrations%rowtype; q public.integration_grant_reviews_v6%rowtype; h text;
begin
 if auth.role()<>'authenticated' or auth.uid() is null or public.current_role_of() is null
  or not coalesce(public.is_admin(),false) then
  raise exception 'A provisioned admin must request integration access.' using errcode='42501'; end if;
 select * into i from public.client_integrations where id=p_integration_id for update;
 if i.id is null or i.credential_secret_id is null or
  coalesce(i.access_level,'') not in ('read','write','admin') or
  nullif(btrim(coalesce(i.credential_label,'')),'') is null or
  (i.token_expires_at is not null and i.token_expires_at<=now()) or
  (coalesce(p_enable_ingest,false) and i.provider not in ('meta','instagram')) or
  (i.status<>'pending_grant' and not
   (coalesce(p_enable_ingest,false) and i.status in ('connected','active','expiring') and not i.ingest_enabled))
  then raise exception 'Configure a current credential and disabled access before requesting review.' using errcode='23514'; end if;
 select * into q from public.integration_grant_reviews_v6
  where integration_id=i.id order by request_epoch desc limit 1;
 if q.id is not null and q.enable_ingest=coalesce(p_enable_ingest,false)
  and q.source_hash=public.integration_grant_hash_v6(q)
  and public.integration_grant_source_state_v6(q.canonical_request_id)='pending'
  and exists(select 1 from public.approval_inbox_v6 x
   where x.id=q.canonical_request_id and x.status='pending')
  then return q.canonical_request_id; end if;
 insert into public.integration_grant_reviews_v6(client_id,integration_id,enable_ingest)
  values(i.client_id,i.id,coalesce(p_enable_ingest,false)) returning * into q;
 h:=public.integration_grant_hash_v6(q);
 update public.integration_grant_reviews_v6 set source_hash=h where id=q.id returning * into q;
 q.canonical_request_id:=public.register_approval_request_v6(jsonb_build_object(
  'client_id',i.client_id,'source_system','aa_console','source_kind','integration_grant',
  'source_id',q.id::text,'source_version',h||':'||q.request_token::text,
  'title','Grant '||i.provider||' credential access for '||i.credential_label,
  'artifact_hash',h,'preview',public.integration_grant_preview_v6(q),
  'destination','client:integration:'||i.client_id::text||':'||i.id::text,
  'scope',public.integration_grant_scope_v6(q),'account_ref',i.credential_label,
  'owner_role','admin','requested_by',auth.uid(),'requester_kind','human',
  'expires_at',now()+interval '1 day',
  'owning_path','/clients/'||i.client_id::text||'/account/integrations'));
 update public.integration_grant_reviews_v6 set canonical_request_id=q.canonical_request_id where id=q.id;
 return q.canonical_request_id;
end $$;

create function public.guard_integration_grant_v6()
returns trigger language plpgsql security definer set search_path=pg_catalog,public as $$
declare rid uuid; q public.integration_grant_reviews_v6%rowtype;
 d public.approval_decision_events_v6%rowtype; prior_grant boolean;
begin
 if tg_op='INSERT' then
  if new.credential_secret_id is not null and
   (new.status<>'pending_grant' or new.ingest_enabled) then
   raise exception 'Stored credentials must await access approval.' using errcode='42501'; end if;
  return new;
 end if;
 if new.credential_secret_id is distinct from old.credential_secret_id then
  if current_setting('aa.integration_store',true) is distinct from 'on'
   or new.status<>'pending_grant' or new.ingest_enabled then
   raise exception 'Rotate credentials through the admin Vault RPC.' using errcode='42501'; end if;
 end if;
 if new.client_id is distinct from old.client_id or new.provider is distinct from old.provider
  or (new.access_level is distinct from old.access_level
   and current_setting('aa.integration_store',true) is distinct from 'on') then
  raise exception 'Change integration identity or declared access through credential reconnection.' using errcode='42501';
 end if;
 if old.status='revoked' and new.status not in ('revoked','pending_grant') then
  raise exception 'A revoked integration requires a new credential version.' using errcode='42501';
 end if;
 select exists(select 1 from public.integration_grant_reviews_v6 g
  join public.approval_requests_v6 r on r.id=g.canonical_request_id
  where g.integration_id=new.id and g.applied_at is not null
   and r.preview->>'credential_version_hash'=
    encode(sha256(convert_to(new.credential_secret_id::text,'UTF8')),'hex'))
  into prior_grant;
 if (new.status in ('connected','active','expiring')
    and old.status not in ('connected','active','expiring')
    and (old.status in ('pending_grant','revoked') or not prior_grant))
  or (not old.ingest_enabled and new.ingest_enabled) then
  if nullif(current_setting('aa.integration_grant_request_id',true),'') is null or
   current_setting('aa.integration_grant_request_id',true)
    !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
   then raise exception 'Grant provider access through its exact Approval Inbox decision.' using errcode='42501'; end if;
  rid:=current_setting('aa.integration_grant_request_id',true)::uuid;
  select * into q from public.integration_grant_reviews_v6
   where canonical_request_id=rid and integration_id=new.id and client_id=new.client_id;
  select * into d from public.approval_decision_events_v6
   where request_id=rid order by event_order desc limit 1;
  if q.id is null or q.applied_at is not null or d.decision<>'approved'
   or d.actor_aal<>'aal2' or d.actor_id is distinct from auth.uid()
   or d.artifact_hash is distinct from q.source_hash
   or public.integration_grant_source_state_v6(rid)<>'pending'
   or new.status<>'connected' or new.ingest_enabled is distinct from q.enable_ingest
   then raise exception 'The exact integration grant is missing or stale.' using errcode='42501'; end if;
 end if;
 return new;
end $$;
create trigger client_integration_grant_guard_v6 before insert or update
 on public.client_integrations for each row execute function public.guard_integration_grant_v6();

create function public.invalidate_integration_grant_v6()
returns trigger language plpgsql security definer set search_path=pg_catalog,public as $$
begin
 if tg_op='DELETE' then
  update public.integration_grant_reviews_v6 set request_token=gen_random_uuid()
   where integration_id=old.id and applied_at is null;
  return old;
 end if;
 if tg_op='INSERT' or to_jsonb(new)-array['updated_at','last_checked_at']
   is distinct from to_jsonb(old)-array['updated_at','last_checked_at'] then
  update public.integration_grant_reviews_v6 set request_token=gen_random_uuid()
   where integration_id=new.id and applied_at is null
    and canonical_request_id::text is distinct from
     nullif(current_setting('aa.integration_grant_request_id',true),'');
 end if;
 return new;
end $$;
create trigger client_integration_grant_invalidation_v6 after insert or update or delete
 on public.client_integrations for each row execute function public.invalidate_integration_grant_v6();

create function public.decide_integration_grant_v6(p_review_id uuid,p_request_id uuid,
 p_approved boolean,p_reason text default null)
returns uuid language plpgsql volatile security definer set search_path=pg_catalog,public set timezone='UTC' as $$
declare q public.integration_grant_reviews_v6%rowtype; i public.client_integrations%rowtype; h text;
begin
 if auth.role()<>'authenticated' or auth.uid() is null or public.current_role_of() is null
  or not coalesce(public.is_admin(),false) or coalesce(auth.jwt()->>'aal','')<>'aal2' then
  raise exception 'A provisioned AAL2 admin must decide integration access.' using errcode='42501'; end if;
 select * into q from public.integration_grant_reviews_v6 where id=p_review_id for update;
 if q.id is null or q.canonical_request_id is distinct from p_request_id then
  raise exception 'Integration grant review is unavailable.' using errcode='23514'; end if;
 select * into i from public.client_integrations where id=q.integration_id and client_id=q.client_id for update;
 h:=public.integration_grant_hash_v6(q);
 if public.integration_grant_source_state_v6(p_request_id)<>'pending' or
  not exists(select 1 from public.approval_inbox_v6 x where x.id=p_request_id
   and x.status='pending' and x.preview_blocker is null) then
  raise exception 'Review the current integration grant in Approval Inbox.' using errcode='23514'; end if;
 if not p_approved and nullif(btrim(coalesce(p_reason,'')),'') is null then
  raise exception 'A rejection reason is required.' using errcode='22023'; end if;
 perform public.record_approval_decision_v6(p_request_id,
  case when p_approved then 'approved' else 'rejected' end,h,
  'integration_grant:'||q.id::text||':'||q.request_token::text,p_reason);
 if p_approved then
  perform set_config('aa.integration_grant_request_id',p_request_id::text,true);
  update public.client_integrations set status='connected',ingest_enabled=q.enable_ingest
   where id=i.id and client_id=i.client_id;
  update public.integration_grant_reviews_v6 set applied_at=now(),applied_by=auth.uid()
   where id=q.id;
  perform set_config('aa.integration_grant_request_id','',true);
 end if;
 return q.id;
end $$;

create or replace function public.admin_store_integration_credential(
 p_client_id uuid,p_provider text,p_label text,p_secret text,p_access_level text default null)
returns uuid language plpgsql security definer set search_path=pg_catalog,public,vault as $$
declare v_secret uuid; v_row uuid;
begin
 if auth.role()<>'authenticated' or auth.uid() is null or public.current_role_of() is null
  or not coalesce(public.is_admin(),false) then
  raise exception 'A provisioned admin must store integration credentials.' using errcode='42501'; end if;
 if p_client_id is null or not exists(select 1 from public.clients where id=p_client_id)
  or nullif(btrim(coalesce(p_provider,'')),'') is null
  or nullif(btrim(coalesce(p_label,'')),'') is null
  or nullif(p_secret,'') is null or coalesce(p_access_level,'') not in ('read','write','admin') then
  raise exception 'Client, provider, account label, credential and access level are required.' using errcode='22023'; end if;
 v_secret:=vault.create_secret(p_secret,
  'integration:'||p_client_id::text||':'||p_provider||':'||p_label||':'||gen_random_uuid()::text,
  'AA Console integration credential');
 perform set_config('aa.integration_store','on',true);
 insert into public.client_integrations
  (client_id,provider,credential_label,credential_secret_id,access_level,status,ingest_enabled)
 values (p_client_id,p_provider,p_label,v_secret,p_access_level,'pending_grant',false)
 on conflict (client_id,provider,credential_label) do update
  set credential_secret_id=excluded.credential_secret_id,
      access_level=excluded.access_level,status='pending_grant',
      ingest_enabled=false,last_checked_at=null,updated_at=now()
 returning id into v_row;
 perform set_config('aa.integration_store','',true);
 return v_row;
end $$;
comment on function public.admin_store_integration_credential(uuid,text,text,text,text) is
 'Store a distinct Vault secret version in pending_grant, with scheduled ingest off. Exact AAL2 access review is required before credential use.';

revoke all on function public.integration_grant_preview_v6(public.integration_grant_reviews_v6) from public,anon,authenticated,service_role;
revoke all on function public.integration_grant_hash_v6(public.integration_grant_reviews_v6) from public,anon,authenticated,service_role;
revoke all on function public.integration_grant_scope_v6(public.integration_grant_reviews_v6) from public,anon,authenticated,service_role;
revoke all on function public.integration_grant_source_state_v6(uuid) from public,anon,authenticated,service_role;
grant execute on function public.integration_grant_source_state_v6(uuid) to authenticated,service_role;
revoke all on function public.request_integration_grant_v6(uuid,boolean) from public,anon,service_role;
grant execute on function public.request_integration_grant_v6(uuid,boolean) to authenticated;
revoke all on function public.decide_integration_grant_v6(uuid,uuid,boolean,text) from public,anon,service_role;
grant execute on function public.decide_integration_grant_v6(uuid,uuid,boolean,text) to authenticated;
revoke all on function public.guard_integration_grant_v6() from public,anon,authenticated,service_role;
revoke all on function public.invalidate_integration_grant_v6() from public,anon,authenticated,service_role;
select public.lock_down_definer_functions();
commit;
