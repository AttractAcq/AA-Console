-- Review the ordered sequence shape and every exact message version before enrolment.
begin;
alter table public.nurture_sequences
 add column approved_request_id uuid references public.approval_requests_v6(id),
 add column approved_content_hash text check(approved_content_hash is null or approved_content_hash ~ '^[0-9a-f]{64}$');

create table public.nurture_sequence_review_requests_v6 (
 id uuid primary key default gen_random_uuid(),
 request_epoch bigint generated always as identity unique,
 sequence_id uuid not null references public.nurture_sequences(id) on delete cascade,
 client_id uuid not null references public.clients(id) on delete cascade,
 request_token uuid not null default gen_random_uuid(),
 source_hash text not null default repeat('0',64) check(source_hash ~ '^[0-9a-f]{64}$'),
 canonical_request_id uuid unique references public.approval_requests_v6(id),
 created_at timestamptz not null default now()
);
create index nurture_sequence_review_latest_v6 on
 public.nurture_sequence_review_requests_v6(sequence_id,request_epoch desc);
alter table public.nurture_sequence_review_requests_v6 enable row level security;
revoke all on public.nurture_sequence_review_requests_v6 from public,anon,authenticated,service_role;

create function public.nurture_sequence_review_preview_v6(q public.nurture_sequence_review_requests_v6)
returns jsonb language sql stable security definer set search_path=pg_catalog,public as $$
 select jsonb_build_object('client_id',s.client_id,'sequence_id',s.id,
  'request_token',q.request_token,'name',s.name,'purpose',s.purpose,
  'campaign_id',s.campaign_id,'trigger_stage',s.trigger_stage,
  'trigger_after_hours',s.trigger_after_hours,'exit_stages',s.exit_stages,
  'enrolled_automatically',s.enrolled_automatically,'archived_at',s.archived_at,
  'steps',coalesce((select jsonb_agg(jsonb_build_object(
    'step_id',st.id,'position',st.position,'delay_hours',st.delay_hours,
    'template_version_id',v.id,'template_name',t.name,'template_purpose',t.purpose,
    'channel',t.channel_key,'subject',v.subject,'body',v.body,
    'placeholders',v.placeholders,'payload_hash',v.payload_hash,
    'approval_id',a.id,'approval_request_id',a.approved_request_id,
    'approval_content_hash',a.approved_content_hash)
    order by st.position) from public.nurture_sequence_steps st
    join public.message_template_versions v on v.id=st.template_version_id and v.client_id=st.client_id
    join public.message_templates t on t.id=v.template_id and t.client_id=st.client_id
    left join public.message_template_approvals a on a.template_version_id=v.id and a.channel_key=t.channel_key
    where st.sequence_id=s.id and st.client_id=s.client_id),'[]'::jsonb),
  'consequence','May automatically enrol eligible consenting leads and queue the approved steps; every send retains its own exact consent and Inbox gate')
 from public.nurture_sequences s where s.id=q.sequence_id and s.client_id=q.client_id;
$$;
create function public.nurture_sequence_review_hash_v6(q public.nurture_sequence_review_requests_v6)
returns text language sql stable security definer set search_path=pg_catalog,public as $$
 select encode(sha256(convert_to((public.nurture_sequence_review_preview_v6(q)-'request_token')::text,'UTF8')),'hex');
$$;
create function public.nurture_sequence_review_scope_v6(q public.nurture_sequence_review_requests_v6)
returns jsonb language sql stable security definer set search_path=pg_catalog,public as $$
 select jsonb_build_object('client_id',q.client_id,'sequence_id',q.sequence_id,
  'review_id',q.id,'request_token',q.request_token,
  'content_hash',public.nurture_sequence_review_hash_v6(q),
  'effect','standing_sequence_enrolment_permission');
$$;
create function public.nurture_sequence_steps_ready_v6(p_sequence_id uuid)
returns boolean language plpgsql stable security definer set search_path=pg_catalog,public as $$
declare n integer;
begin
 select count(*) into n from public.nurture_sequence_steps where sequence_id=p_sequence_id;
 if n=0 then return false; end if;
 return not exists(select 1 from public.nurture_sequence_steps st
  left join public.message_template_versions v on v.id=st.template_version_id
  left join public.message_templates t on t.id=v.template_id
  left join public.message_template_approvals a on a.template_version_id=v.id and a.channel_key=t.channel_key
  where st.sequence_id=p_sequence_id and
   (v.id is null or t.id is null or a.id is null or st.client_id<>v.client_id
    or st.client_id<>t.client_id or not public.message_template_approval_current_v6(a.id)));
end $$;

create function public.nurture_sequence_review_source_state_v6(p_request_id uuid)
returns text language plpgsql stable security definer set search_path=pg_catalog,public as $$
declare r public.approval_requests_v6%rowtype;
 q public.nurture_sequence_review_requests_v6%rowtype;
 s public.nurture_sequences%rowtype; h text;
begin
 select * into r from public.approval_requests_v6 where id=p_request_id;
 if r.id is null or r.source_system<>'aa_console' or r.source_kind<>'nurture_sequence'
  or r.source_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  then return 'unverified'; end if;
 if auth.role() is distinct from 'service_role' and
  (auth.role() is distinct from 'authenticated' or not public.can_access_client(r.client_id))
  then return 'unverified'; end if;
 select * into q from public.nurture_sequence_review_requests_v6
  where id=r.source_id::uuid and canonical_request_id=r.id and client_id=r.client_id;
 if q.id is null then return 'cancelled'; end if;
 if exists(select 1 from public.nurture_sequence_review_requests_v6 newer
  where newer.sequence_id=q.sequence_id and newer.request_epoch>q.request_epoch)
  then return 'superseded'; end if;
 select * into s from public.nurture_sequences where id=q.sequence_id and client_id=q.client_id;
 if s.id is null then return 'cancelled'; end if;
 h:=public.nurture_sequence_review_hash_v6(q);
 if h is null or q.source_hash is distinct from h or r.artifact_hash is distinct from h
  or r.source_version is distinct from h||':'||q.request_token::text
  or r.preview is distinct from public.nurture_sequence_review_preview_v6(q)
  or r.scope is distinct from public.nurture_sequence_review_scope_v6(q)
  or r.destination is distinct from 'nurture_sequence:'||s.id::text
  then return 'superseded'; end if;
 if s.archived_at is not null or not public.nurture_sequence_steps_ready_v6(s.id)
  then return 'source_held'; end if;
 if s.approved_at is not null and s.approved_request_id=r.id
  and s.approved_content_hash=h then return 'source_decided'; end if;
 return 'pending';
end $$;

create function public.invalidate_nurture_sequence_reviews_v6()
returns trigger language plpgsql security definer set search_path=pg_catalog,public as $$
begin
 if (new.name,new.purpose,new.campaign_id,new.trigger_stage,new.trigger_after_hours,
  new.exit_stages,new.enrolled_automatically,new.archived_at) is distinct from
  (old.name,old.purpose,old.campaign_id,old.trigger_stage,old.trigger_after_hours,
   old.exit_stages,old.enrolled_automatically,old.archived_at) then
  update public.nurture_sequence_review_requests_v6 set request_token=gen_random_uuid()
   where sequence_id=new.id;
 end if;
 return new;
end $$;
create trigger nurture_sequence_review_invalidation_v6
 after update on public.nurture_sequences for each row
 execute function public.invalidate_nurture_sequence_reviews_v6();
create function public.invalidate_nurture_sequence_step_reviews_v6()
returns trigger language plpgsql security definer set search_path=pg_catalog,public as $$
begin
 update public.nurture_sequence_review_requests_v6 set request_token=gen_random_uuid()
  where sequence_id=coalesce(new.sequence_id,old.sequence_id);
 return coalesce(new,old);
end $$;
create trigger nurture_sequence_step_review_invalidation_v6
 after insert or update or delete on public.nurture_sequence_steps for each row
 execute function public.invalidate_nurture_sequence_step_reviews_v6();

create function public.request_nurture_sequence_review_v6(p_sequence_id uuid)
returns uuid language plpgsql volatile security definer set search_path=pg_catalog,public set timezone='UTC' as $$
declare s public.nurture_sequences%rowtype;
 q public.nurture_sequence_review_requests_v6%rowtype; h text;
begin
 if auth.role()<>'authenticated' or auth.uid() is null or public.current_role_of() is null
  then raise exception 'A provisioned human must request sequence review.' using errcode='42501'; end if;
 select * into s from public.nurture_sequences where id=p_sequence_id for update;
 if s.id is null or not (coalesce(public.is_admin(),false)
  or coalesce(auth.uid()=public.active_video_approval_manager(s.client_id),false))
  then raise exception 'The sequence or review owner is unavailable.' using errcode='42501'; end if;
 if s.archived_at is not null or not public.nurture_sequence_steps_ready_v6(s.id)
  then raise exception 'Every step needs a current exact message approval before sequence review.' using errcode='23514'; end if;
 select * into q from public.nurture_sequence_review_requests_v6
  where sequence_id=s.id order by request_epoch desc limit 1;
 if q.id is not null and q.source_hash=public.nurture_sequence_review_hash_v6(q)
  and public.nurture_sequence_review_source_state_v6(q.canonical_request_id)='pending'
  and exists(select 1 from public.approval_inbox_v6 i
   where i.id=q.canonical_request_id and i.status='pending')
  then return q.canonical_request_id; end if;
 insert into public.nurture_sequence_review_requests_v6(sequence_id,client_id)
  values(s.id,s.client_id) returning * into q;
 h:=public.nurture_sequence_review_hash_v6(q);
 update public.nurture_sequence_review_requests_v6 set source_hash=h where id=q.id returning * into q;
 q.canonical_request_id:=public.register_approval_request_v6(jsonb_build_object(
  'client_id',s.client_id,'source_system','aa_console','source_kind','nurture_sequence',
  'source_id',q.id::text,'source_version',h||':'||q.request_token::text,
  'title','Approve nurture sequence: '||s.name,
  'artifact_hash',h,'preview',public.nurture_sequence_review_preview_v6(q),
  'destination','nurture_sequence:'||s.id::text,
  'scope',public.nurture_sequence_review_scope_v6(q),
  'owner_role','admin_or_active_client_manager','requested_by',auth.uid(),
  'requester_kind','human','expires_at',now()+interval '7 days',
  'owning_path','/clients/'||s.client_id::text||'/delivery/approval-inbox?tab=unified'));
 update public.nurture_sequence_review_requests_v6
  set canonical_request_id=q.canonical_request_id where id=q.id;
 return q.canonical_request_id;
end $$;

create function public.guard_nurture_sequence_approval_v6()
returns trigger language plpgsql security definer set search_path=pg_catalog,public as $$
declare q public.nurture_sequence_review_requests_v6%rowtype;
 e public.approval_decision_events_v6%rowtype;
begin
 if new.approved_at is null then return new; end if;
 if old.approved_at is not null and
  (new.approved_at,new.approved_by,new.approved_request_id,new.approved_content_hash)
  is not distinct from
  (old.approved_at,old.approved_by,old.approved_request_id,old.approved_content_hash)
  then return new; end if;
 select * into q from public.nurture_sequence_review_requests_v6
  where canonical_request_id=new.approved_request_id and sequence_id=new.id and client_id=new.client_id;
 select * into e from public.approval_decision_events_v6 where request_id=q.canonical_request_id
  order by event_order desc limit 1;
 if q.id is null or e.id is null or e.decision<>'approved' or e.actor_aal<>'aal2'
  or e.actor_id is distinct from auth.uid() or e.artifact_hash is distinct from q.source_hash
  or new.approved_by is distinct from auth.uid()
  or new.approved_content_hash is distinct from q.source_hash
  or public.nurture_sequence_review_source_state_v6(q.canonical_request_id)<>'pending'
  then raise exception 'Approve this exact sequence in Approval Inbox.' using errcode='42501'; end if;
 return new;
end $$;
create trigger nurture_sequence_approval_guard_v6
 before update on public.nurture_sequences for each row
 execute function public.guard_nurture_sequence_approval_v6();

create function public.decide_nurture_sequence_inbox_v6(
 p_review_id uuid,p_request_id uuid,p_approved boolean,p_reason text default null)
returns uuid language plpgsql volatile security definer set search_path=pg_catalog,public set timezone='UTC' as $$
declare q public.nurture_sequence_review_requests_v6%rowtype;
 s public.nurture_sequences%rowtype; h text;
begin
 if auth.role()<>'authenticated' or auth.uid() is null or public.current_role_of() is null
  or coalesce(auth.jwt()->>'aal','')<>'aal2' then
  raise exception 'A provisioned AAL2 human must decide sequence approval.' using errcode='42501'; end if;
 select * into q from public.nurture_sequence_review_requests_v6 where id=p_review_id for update;
 select * into s from public.nurture_sequences where id=q.sequence_id for update;
 if q.id is null or s.id is null or s.client_id<>q.client_id
  or not (coalesce(public.is_admin(),false)
   or coalesce(auth.uid()=public.active_video_approval_manager(s.client_id),false))
  then raise exception 'The sequence decision owner is unavailable.' using errcode='42501'; end if;
 h:=public.nurture_sequence_review_hash_v6(q);
 if q.canonical_request_id is distinct from p_request_id
  or public.nurture_sequence_review_source_state_v6(p_request_id)<>'pending'
  or not exists(select 1 from public.approval_inbox_v6 i
   where i.id=p_request_id and i.status='pending' and i.preview_blocker is null)
  then raise exception 'Review the current sequence in Approval Inbox.' using errcode='23514'; end if;
 if not p_approved and nullif(btrim(coalesce(p_reason,'')),'') is null
  then raise exception 'A rejection reason is required.' using errcode='22023'; end if;
 perform public.record_approval_decision_v6(p_request_id,
  case when p_approved then 'approved' else 'rejected' end,h,
  'nurture_sequence:'||q.id::text||':'||q.request_token::text,p_reason);
 if p_approved then
  update public.nurture_sequences set approved_at=now(),approved_by=auth.uid(),
   approved_request_id=p_request_id,approved_content_hash=h where id=s.id;
 end if;
 return s.id;
end $$;

create or replace function public.approve_nurture_sequence_v6(p_sequence_id uuid)
returns public.nurture_sequences language plpgsql security definer set search_path=pg_catalog,public as $$
begin
 raise exception 'Approve the exact ordered sequence in Approval Inbox.' using errcode='42501';
end $$;

revoke all on function public.nurture_sequence_review_preview_v6(public.nurture_sequence_review_requests_v6) from public,anon,authenticated,service_role;
revoke all on function public.nurture_sequence_review_hash_v6(public.nurture_sequence_review_requests_v6) from public,anon,authenticated,service_role;
revoke all on function public.nurture_sequence_review_scope_v6(public.nurture_sequence_review_requests_v6) from public,anon,authenticated,service_role;
revoke all on function public.nurture_sequence_steps_ready_v6(uuid) from public,anon,authenticated,service_role;
grant execute on function public.nurture_sequence_steps_ready_v6(uuid) to authenticated,service_role;
revoke all on function public.nurture_sequence_review_source_state_v6(uuid) from public,anon,authenticated,service_role;
grant execute on function public.nurture_sequence_review_source_state_v6(uuid) to authenticated,service_role;
revoke all on function public.request_nurture_sequence_review_v6(uuid) from public,anon,service_role;
grant execute on function public.request_nurture_sequence_review_v6(uuid) to authenticated;
revoke all on function public.decide_nurture_sequence_inbox_v6(uuid,uuid,boolean,text) from public,anon,service_role;
grant execute on function public.decide_nurture_sequence_inbox_v6(uuid,uuid,boolean,text) to authenticated;
revoke all on function public.invalidate_nurture_sequence_reviews_v6() from public,anon,authenticated,service_role;
revoke all on function public.invalidate_nurture_sequence_step_reviews_v6() from public,anon,authenticated,service_role;
revoke all on function public.guard_nurture_sequence_approval_v6() from public,anon,authenticated,service_role;
select public.lock_down_definer_functions();
commit;
