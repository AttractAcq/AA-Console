-- Exact recipient/message approval for proof-capture requests. Legacy approvals
-- are intentionally unable to enter the sender claim.
begin;
create table public.proof_delivery_reviews_v6 (
 id uuid primary key default gen_random_uuid(),
 review_epoch bigint generated always as identity unique,
 delivery_id uuid not null references public.proof_request_deliveries(id) on delete cascade,
 client_id uuid not null references public.clients(id) on delete cascade,
 request_token uuid not null default gen_random_uuid(),
 source_hash text not null default repeat('0',64) check(source_hash ~ '^[0-9a-f]{64}$'),
 canonical_request_id uuid unique references public.approval_requests_v6(id),
 created_at timestamptz not null default now()
);
create index proof_delivery_reviews_latest_v6 on public.proof_delivery_reviews_v6(delivery_id,review_epoch desc);
alter table public.proof_delivery_reviews_v6 enable row level security;
revoke all on public.proof_delivery_reviews_v6 from public,anon,authenticated,service_role;

create function public.proof_delivery_preview_v6(q public.proof_delivery_reviews_v6)
returns jsonb language sql stable security definer set search_path=pg_catalog,public as $$
 select jsonb_build_object('client_id',d.client_id,'delivery_id',d.id,
 'request_token',q.request_token,'config_id',d.config_id,'link_id',d.link_id,
 'channel',d.channel,'recipient',d.recipient,'subject',d.subject,
 'message',d.message,'capture_url',d.capture_url,
 'template_sid',d.template_sid,'template_variables',d.template_variables,
 'scheduled_at',d.scheduled_at,'link_expires_at',l.expires_at,
 'link_revoked_at',l.revoked_at,'link_submissions',l.submissions,
 'link_max_submissions',l.max_submissions,
 'consequence','Send this exact proof request to this recipient through the configured provider')
 from public.proof_request_deliveries d
 join public.proof_capture_links l on l.id=d.link_id and l.client_id=d.client_id and l.config_id=d.config_id
 join public.proof_capture_configs c on c.id=d.config_id and c.client_id=d.client_id
 where d.id=q.delivery_id and d.client_id=q.client_id;
$$;
create function public.proof_delivery_hash_v6(q public.proof_delivery_reviews_v6)
returns text language sql stable security definer set search_path=pg_catalog,public as $$
 select encode(sha256(convert_to((public.proof_delivery_preview_v6(q)-'request_token')::text,'UTF8')),'hex');
$$;
create function public.proof_delivery_scope_v6(q public.proof_delivery_reviews_v6)
returns jsonb language sql stable security definer set search_path=pg_catalog,public as $$
 select jsonb_build_object('client_id',q.client_id,'delivery_id',q.delivery_id,
 'review_id',q.id,'request_token',q.request_token,
 'content_hash',public.proof_delivery_hash_v6(q),'effect','proof_request_send');
$$;
create function public.proof_delivery_source_state_v6(p_request_id uuid)
returns text language plpgsql stable security definer set search_path=pg_catalog,public as $$
declare r public.approval_requests_v6%rowtype; q public.proof_delivery_reviews_v6%rowtype;
 d public.proof_request_deliveries%rowtype; l public.proof_capture_links%rowtype; h text;
begin
 select * into r from public.approval_requests_v6 where id=p_request_id;
 if r.id is null or r.source_system<>'aa_console' or r.source_kind<>'proof_delivery'
  or r.source_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  then return 'unverified'; end if;
 if auth.role() is distinct from 'service_role' and
  (auth.role() is distinct from 'authenticated' or not public.can_review_approval_request_v6(r.client_id,r.owner_role))
  then return 'unverified'; end if;
 select * into q from public.proof_delivery_reviews_v6 where id=r.source_id::uuid
  and canonical_request_id=r.id and client_id=r.client_id;
 if q.id is null then return 'cancelled'; end if;
 select * into d from public.proof_request_deliveries where id=q.delivery_id and client_id=q.client_id;
 if d.id is null then return 'cancelled'; end if;
 select * into l from public.proof_capture_links where id=d.link_id and client_id=d.client_id and config_id=d.config_id;
 h:=public.proof_delivery_hash_v6(q);
 if h is null or q.source_hash is distinct from h or r.artifact_hash is distinct from h
  or r.source_version is distinct from h||':'||q.request_token::text
  or r.preview is distinct from public.proof_delivery_preview_v6(q)
  or r.scope is distinct from public.proof_delivery_scope_v6(q)
  or r.destination is distinct from d.channel||':'||d.recipient
  then return 'superseded'; end if;
 if d.status='cancelled' then return 'cancelled'; end if;
 if l.id is null or l.revoked_at is not null or l.expires_at<=now()
  or l.submissions>=l.max_submissions or d.recipient=''
  or d.message='' or d.capture_url='' or d.channel not in ('email','sms','whatsapp')
  then return 'source_held'; end if;
 if d.status in ('approved','sending','sent','uncertain') then return 'source_decided'; end if;
 if d.status not in ('pending_approval','failed') then return 'source_held'; end if;
 return 'pending';
end $$;

create function public.request_proof_delivery_review_v6(p_delivery_id uuid)
returns uuid language plpgsql volatile security definer set search_path=pg_catalog,public set timezone='UTC' as $$
declare d public.proof_request_deliveries%rowtype; q public.proof_delivery_reviews_v6%rowtype; h text;
begin
 if auth.role()<>'authenticated' or auth.uid() is null or public.current_role_of() is null
  then raise exception 'A provisioned human must request proof delivery review.' using errcode='42501'; end if;
 select * into d from public.proof_request_deliveries where id=p_delivery_id for update;
 if d.id is null or not (coalesce(public.is_admin(),false)
  or coalesce(auth.uid()=public.active_video_approval_manager(d.client_id),false))
  then raise exception 'The delivery owner is unavailable.' using errcode='42501'; end if;
 if d.status not in ('pending_approval','failed') then
  raise exception 'This delivery is not awaiting review.' using errcode='23514'; end if;
 select * into q from public.proof_delivery_reviews_v6 where delivery_id=d.id order by review_epoch desc limit 1;
 if q.id is not null and q.canonical_request_id is not null
  and q.source_hash=public.proof_delivery_hash_v6(q)
  and public.proof_delivery_source_state_v6(q.canonical_request_id)='pending'
  and exists(select 1 from public.approval_inbox_v6 i where i.id=q.canonical_request_id and i.status='pending')
  then return q.canonical_request_id; end if;
 insert into public.proof_delivery_reviews_v6(delivery_id,client_id) values(d.id,d.client_id) returning * into q;
 h:=public.proof_delivery_hash_v6(q);
 if h is null then raise exception 'Proof delivery or its capture link is unavailable.' using errcode='23514'; end if;
 update public.proof_delivery_reviews_v6 set source_hash=h where id=q.id returning * into q;
 q.canonical_request_id:=public.register_approval_request_v6(jsonb_build_object(
  'client_id',q.client_id,'source_system','aa_console','source_kind','proof_delivery',
  'source_id',q.id::text,'source_version',h||':'||q.request_token::text,
  'title','Send proof request: '||d.channel||' to '||d.recipient,
  'artifact_hash',h,'preview',public.proof_delivery_preview_v6(q),
  'destination',d.channel||':'||d.recipient,'scope',public.proof_delivery_scope_v6(q),
  'owner_role','admin_or_active_client_manager','requested_by',auth.uid(),
  'requester_kind','human','expires_at',least(now()+interval '7 days',
    (select expires_at from public.proof_capture_links where id=d.link_id)),
  'owning_path','/clients/'||d.client_id::text||'/delivery/approval-inbox?tab=unified'));
 update public.proof_delivery_reviews_v6 set canonical_request_id=q.canonical_request_id where id=q.id;
 return q.canonical_request_id;
end $$;

create function public.decide_proof_delivery_inbox_v6(p_review_id uuid,p_request_id uuid,p_approved boolean,p_reason text default null)
returns uuid language plpgsql volatile security definer set search_path=pg_catalog,public set timezone='UTC' as $$
declare q public.proof_delivery_reviews_v6%rowtype; d public.proof_request_deliveries%rowtype; h text;
begin
 if auth.role()<>'authenticated' or auth.uid() is null or public.current_role_of() is null
  or coalesce(auth.jwt()->>'aal','')<>'aal2' then
  raise exception 'A provisioned AAL2 human must decide proof delivery.' using errcode='42501'; end if;
 select * into q from public.proof_delivery_reviews_v6 where id=p_review_id for update;
 select * into d from public.proof_request_deliveries where id=q.delivery_id for update;
 if q.id is null or d.id is null or d.client_id<>q.client_id
  or not (coalesce(public.is_admin(),false)
    or coalesce(auth.uid()=public.active_video_approval_manager(d.client_id),false))
  then raise exception 'The delivery decision owner is unavailable.' using errcode='42501'; end if;
 h:=public.proof_delivery_hash_v6(q);
 if q.canonical_request_id is distinct from p_request_id
  or public.proof_delivery_source_state_v6(p_request_id)<>'pending'
  or not exists(select 1 from public.approval_inbox_v6 i
    where i.id=p_request_id and i.status='pending' and i.preview_blocker is null)
  then raise exception 'Review the current proof delivery in Approval Inbox.' using errcode='23514'; end if;
 if not p_approved and nullif(btrim(coalesce(p_reason,'')),'') is null then
  raise exception 'A rejection reason is required.' using errcode='22023'; end if;
 perform public.record_approval_decision_v6(p_request_id,
  case when p_approved then 'approved' else 'rejected' end,h,
  'proof_delivery:'||q.id::text||':'||q.request_token::text,p_reason);
 update public.proof_request_deliveries set status=case when p_approved then 'approved' else 'cancelled' end,
  approved_by=case when p_approved then auth.uid() else null end,
  approved_at=case when p_approved then now() else null end,
  error=case when p_approved then null else p_reason end where id=d.id;
 return d.id;
end $$;

create or replace function public.decide_proof_delivery(p_delivery_id uuid,p_approve boolean)
returns void language plpgsql security definer set search_path=pg_catalog,public as $$
declare d public.proof_request_deliveries%rowtype;
begin
 select * into d from public.proof_request_deliveries where id=p_delivery_id for update;
 if d.id is null or auth.role()<>'authenticated' or not (coalesce(public.is_admin(),false)
  or coalesce(auth.uid()=public.active_video_approval_manager(d.client_id),false))
  then raise exception 'Not permitted' using errcode='42501'; end if;
 if p_approve then raise exception 'Approve this exact delivery in Approval Inbox.' using errcode='42501'; end if;
 if d.status not in ('pending_approval','approved','failed') then
  raise exception 'This delivery can no longer be cancelled.' using errcode='23514'; end if;
 update public.proof_request_deliveries set status='cancelled',approved_by=null,approved_at=null,
  error='Cancelled by delivery owner' where id=d.id;
end $$;

create function public.proof_delivery_send_ready_v6(p_delivery_id uuid)
returns boolean language plpgsql stable security definer set search_path=pg_catalog,public as $$
declare d public.proof_request_deliveries%rowtype; q public.proof_delivery_reviews_v6%rowtype;
begin
 select * into d from public.proof_request_deliveries where id=p_delivery_id;
 select * into q from public.proof_delivery_reviews_v6 where delivery_id=p_delivery_id
  order by review_epoch desc limit 1;
 return coalesce(d.status in ('approved','sending') and d.approved_by is not null
  and q.canonical_request_id is not null
  and public.proof_delivery_source_state_v6(q.canonical_request_id)='source_decided'
  and exists(select 1 from public.approval_decision_events_v6 e
   where e.request_id=q.canonical_request_id and e.decision='approved'
    and e.actor_aal='aal2' and e.actor_id=d.approved_by and e.artifact_hash=q.source_hash)
  and exists(select 1 from public.proof_capture_links l where l.id=d.link_id
   and l.client_id=d.client_id and l.config_id=d.config_id and l.revoked_at is null
   and l.expires_at>now() and l.submissions<l.max_submissions),false);
end $$;

create or replace function public.claim_proof_delivery() returns public.proof_request_deliveries
language plpgsql security definer set search_path=pg_catalog,public as $$
declare d public.proof_request_deliveries;
begin
 if auth.role()<>'service_role' then raise exception 'Service role required'; end if;
 update public.proof_request_deliveries set status='uncertain',error='Delivery confirmation was interrupted; check provider history before sending again.'
  where status='sending' and lease_until<now();
 select * into d from public.proof_request_deliveries where status='approved'
  and scheduled_at<=now() order by scheduled_at for update skip locked limit 1;
 if d.id is null then return null; end if;
 if not public.proof_delivery_send_ready_v6(d.id) then
  update public.proof_request_deliveries set status='cancelled',
   error='Current exact Inbox approval or capture link is unavailable.' where id=d.id;
  return null;
 end if;
 update public.proof_request_deliveries set status='sending',attempts=attempts+1,
  lease_until=now()+interval '2 minutes' where id=d.id returning * into d;
 return d;
end $$;

revoke all on function public.proof_delivery_preview_v6(public.proof_delivery_reviews_v6) from public,anon,authenticated,service_role;
revoke all on function public.proof_delivery_hash_v6(public.proof_delivery_reviews_v6) from public,anon,authenticated,service_role;
revoke all on function public.proof_delivery_scope_v6(public.proof_delivery_reviews_v6) from public,anon,authenticated,service_role;
revoke all on function public.proof_delivery_source_state_v6(uuid) from public,anon,authenticated,service_role;
grant execute on function public.proof_delivery_source_state_v6(uuid) to authenticated,service_role;
revoke all on function public.request_proof_delivery_review_v6(uuid) from public,anon,service_role;
grant execute on function public.request_proof_delivery_review_v6(uuid) to authenticated;
revoke all on function public.decide_proof_delivery_inbox_v6(uuid,uuid,boolean,text) from public,anon,service_role;
grant execute on function public.decide_proof_delivery_inbox_v6(uuid,uuid,boolean,text) to authenticated;
revoke all on function public.proof_delivery_send_ready_v6(uuid) from public,anon,authenticated,service_role;
grant execute on function public.proof_delivery_send_ready_v6(uuid) to service_role;
select public.lock_down_definer_functions();
commit;
