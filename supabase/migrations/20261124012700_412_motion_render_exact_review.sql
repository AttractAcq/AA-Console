-- A motion candidate is accepted only through a review of its stored bytes.
begin;

alter table public.motion_render_candidates
  add column render_bytes_sha256 text check (render_bytes_sha256 is null or render_bytes_sha256 ~ '^[0-9a-f]{64}$'),
  add column render_file_bytes bigint check (render_file_bytes is null or render_file_bytes > 0),
  add column render_object_id uuid,
  add column render_object_version text,
  add column render_object_updated_at timestamptz,
  add column proof_source_lost boolean not null default false,
  add column accepted_request_id uuid references public.approval_requests_v6(id),
  add column accepted_content_hash text check (accepted_content_hash is null or accepted_content_hash ~ '^[0-9a-f]{64}$');

create function public.motion_render_storage_identity_v6(p_candidate_id uuid)
returns jsonb language plpgsql stable security definer set search_path=pg_catalog,public,storage as $$
declare c public.motion_render_candidates%rowtype; o storage.objects%rowtype;
begin
 if auth.role()<>'service_role' then raise exception 'Trusted verifier only.' using errcode='42501'; end if;
 select * into c from public.motion_render_candidates where id=p_candidate_id;
 if c.id is null or nullif(btrim(coalesce(c.render_path,'')),'') is null then
  raise exception 'The render candidate has no file.' using errcode='23514'; end if;
 select * into o from storage.objects where bucket_id='client-media' and name=c.render_path;
 if o.id is null then raise exception 'Render file missing from Storage.' using errcode='23514'; end if;
 return jsonb_build_object('candidate_id',c.id,'client_id',c.client_id,'storage_path',c.render_path,
  'object_id',o.id,'object_version',o.version,'object_updated_at',o.updated_at);
end $$;

create function public.attest_motion_render_bytes_v6(p_candidate_id uuid,p_storage_path text,
 p_sha256 text,p_file_bytes bigint,p_object_id uuid,p_object_version text,p_object_updated_at timestamptz)
returns uuid language plpgsql volatile security definer set search_path=pg_catalog,public,storage as $$
declare c public.motion_render_candidates%rowtype; o storage.objects%rowtype;
begin
 if auth.role()<>'service_role' then raise exception 'Trusted verifier only.' using errcode='42501'; end if;
 if p_sha256 !~ '^[0-9a-f]{64}$' or coalesce(p_file_bytes,0)<=0 then
  raise exception 'Nonempty render bytes and SHA-256 are required.' using errcode='23514'; end if;
 select * into c from public.motion_render_candidates where id=p_candidate_id for update;
 if c.id is null or c.render_path is distinct from p_storage_path then
  raise exception 'Render path changed during verification.' using errcode='23514'; end if;
 select * into o from storage.objects where bucket_id='client-media' and name=p_storage_path;
 if o.id is null or o.id is distinct from p_object_id or o.version is distinct from p_object_version
  or o.updated_at is distinct from p_object_updated_at then
  raise exception 'Render Storage object changed during verification.' using errcode='23514'; end if;
 update public.motion_render_candidates set render_bytes_sha256=p_sha256,render_file_bytes=p_file_bytes,
  render_object_id=o.id,render_object_version=o.version,render_object_updated_at=o.updated_at
  where id=c.id;
 return c.id;
end $$;

create table public.motion_render_review_requests_v6 (
 id uuid primary key default gen_random_uuid(),
 request_epoch bigint generated always as identity unique,
 candidate_id uuid not null references public.motion_render_candidates(id) on delete cascade,
 client_id uuid not null references public.clients(id) on delete cascade,
 request_token uuid not null default gen_random_uuid(),
 source_hash text not null default repeat('0',64) check(source_hash ~ '^[0-9a-f]{64}$'),
 canonical_request_id uuid unique references public.approval_requests_v6(id),
 created_at timestamptz not null default now()
);
create index motion_render_review_latest_v6 on public.motion_render_review_requests_v6(candidate_id,request_epoch desc);
alter table public.motion_render_review_requests_v6 enable row level security;
revoke all on public.motion_render_review_requests_v6 from public,anon,authenticated,service_role;

create function public.motion_render_review_preview_v6(q public.motion_render_review_requests_v6)
returns jsonb language sql stable security definer set search_path=pg_catalog,public,storage as $$
 select jsonb_build_object('client_id',c.client_id,'candidate_id',c.id,'project_id',c.project_id,
  'attempt',c.attempt,'request_token',q.request_token,'render_path',c.render_path,
  'render_sha256',c.render_bytes_sha256,'render_file_bytes',c.render_file_bytes,
  'storage',jsonb_build_object('bucket','client-media','object_id',o.id,'version',o.version,
   'updated_at',o.updated_at),
  'qa',jsonb_build_object('brand',c.brand_qa,'brand_detail',c.brand_qa_detail,
   'claim',c.claim_qa,'claim_detail',c.claim_qa_detail,
   'proof_source_lost',c.proof_source_lost),
  'project',jsonb_build_object('prompt',p.prompt,'preset',p.preset,'scene_plan',p.scene_plan),
  'scenes',coalesce((select jsonb_agg(jsonb_build_object('position',s.position,'beat',s.beat,
   'script',s.script,'start_sec',s.start_sec,'duration_sec',s.duration_sec,
   'proof_asset_id',s.proof_asset_id,'proof_rights',pa.usage_rights,
   'proof_expires_on',pa.expires_on) order by s.position)
   from public.motion_scenes s left join public.client_proof_assets pa on pa.id=s.proof_asset_id
   where s.project_id=c.project_id),'[]'::jsonb),
  'consequence','Accept this exact render candidate for this project; distribution requires separate approval')
 from public.motion_render_candidates c
 join public.motion_design_projects p on p.id=c.project_id and p.client_id=c.client_id
 left join storage.objects o on o.bucket_id='client-media' and o.name=c.render_path
 where c.id=q.candidate_id and c.client_id=q.client_id;
$$;
create function public.motion_render_review_hash_v6(q public.motion_render_review_requests_v6)
returns text language sql stable security definer set search_path=pg_catalog,public as $$
 select encode(sha256(convert_to((public.motion_render_review_preview_v6(q)-'request_token')::text,'UTF8')),'hex');
$$;
create function public.motion_render_review_scope_v6(q public.motion_render_review_requests_v6)
returns jsonb language sql stable security definer set search_path=pg_catalog,public as $$
 select jsonb_build_object('client_id',q.client_id,'candidate_id',q.candidate_id,
  'review_id',q.id,'request_token',q.request_token,
  'content_hash',public.motion_render_review_hash_v6(q),'effect','motion_candidate_acceptance');
$$;

create function public.motion_render_review_source_state_v6(p_request_id uuid)
returns text language plpgsql stable security definer set search_path=pg_catalog,public,storage as $$
declare r public.approval_requests_v6%rowtype; q public.motion_render_review_requests_v6%rowtype;
 c public.motion_render_candidates%rowtype; h text;
begin
 select * into r from public.approval_requests_v6 where id=p_request_id;
 if r.id is null or r.source_system<>'aa_console' or r.source_kind<>'motion_render'
  or r.source_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  then return 'unverified'; end if;
 if auth.role() is distinct from 'service_role' and
  (auth.role() is distinct from 'authenticated' or not public.can_access_client(r.client_id))
  then return 'unverified'; end if;
 select * into q from public.motion_render_review_requests_v6
  where id=r.source_id::uuid and canonical_request_id=r.id and client_id=r.client_id;
 if q.id is null then return 'cancelled'; end if;
 if exists(select 1 from public.motion_render_review_requests_v6 n
  where n.candidate_id=q.candidate_id and n.request_epoch>q.request_epoch)
  then return 'superseded'; end if;
 select * into c from public.motion_render_candidates where id=q.candidate_id and client_id=q.client_id;
 if c.id is null then return 'cancelled'; end if;
 h:=public.motion_render_review_hash_v6(q);
 if h is null or q.source_hash is distinct from h or r.artifact_hash is distinct from h
  or r.source_version is distinct from h||':'||q.request_token::text
  or r.preview is distinct from public.motion_render_review_preview_v6(q)
  or r.scope is distinct from public.motion_render_review_scope_v6(q)
  or r.destination is distinct from 'motion_render:'||c.id::text
  or r.owner_role is distinct from 'admin_or_active_client_manager'
  then return 'superseded'; end if;
 if c.render_bytes_sha256 is null or c.render_object_id is null or c.render_file_bytes is null
  or c.proof_source_lost
  or c.brand_qa is distinct from 'pass' or c.claim_qa is distinct from 'pass'
  or exists(select 1 from public.motion_scenes s join public.client_proof_assets pa on pa.id=s.proof_asset_id
   where s.project_id=c.project_id and (pa.usage_rights<>'approved'
    or (pa.expires_on is not null and pa.expires_on<current_date)))
  then return 'source_held'; end if;
 if c.accepted_request_id=r.id and c.accepted_content_hash=h and c.accepted_at is not null
  then return 'source_decided'; end if;
 if c.accepted_at is not null then return 'source_held'; end if;
 return 'pending';
end $$;

create function public.request_motion_render_review_v6(p_candidate_id uuid)
returns uuid language plpgsql volatile security definer set search_path=pg_catalog,public set timezone='UTC' as $$
declare c public.motion_render_candidates%rowtype; q public.motion_render_review_requests_v6%rowtype; h text;
begin
 if auth.role()<>'authenticated' or auth.uid() is null or public.current_role_of() is null
  then raise exception 'A provisioned human must request render review.' using errcode='42501'; end if;
 select * into c from public.motion_render_candidates where id=p_candidate_id for update;
 if c.id is null or not (coalesce(public.is_admin(),false)
  or auth.uid()=public.active_video_approval_manager(c.client_id))
  then raise exception 'Only the assigned manager or admin may request this render.' using errcode='42501'; end if;
 if c.accepted_at is not null or c.rejected_reason is not null or c.proof_source_lost
  or c.render_bytes_sha256 is null or c.render_object_id is null
  or c.brand_qa is distinct from 'pass' or c.claim_qa is distinct from 'pass'
  or not exists(select 1 from storage.objects o where o.bucket_id='client-media' and o.name=c.render_path
   and o.id=c.render_object_id and o.version is not distinct from c.render_object_version
   and o.updated_at is not distinct from c.render_object_updated_at)
  then raise exception 'Verify current render bytes and passing QA first.' using errcode='23514'; end if;
 select * into q from public.motion_render_review_requests_v6
  where candidate_id=c.id order by request_epoch desc limit 1;
 if q.id is not null and q.source_hash=public.motion_render_review_hash_v6(q)
  and public.motion_render_review_source_state_v6(q.canonical_request_id)='pending'
  and exists(select 1 from public.approval_inbox_v6 i where i.id=q.canonical_request_id and i.status='pending')
  then return q.canonical_request_id; end if;
 insert into public.motion_render_review_requests_v6(candidate_id,client_id)
  values(c.id,c.client_id) returning * into q;
 h:=public.motion_render_review_hash_v6(q);
 update public.motion_render_review_requests_v6 set source_hash=h where id=q.id returning * into q;
 q.canonical_request_id:=public.register_approval_request_v6(jsonb_build_object(
  'client_id',c.client_id,'source_system','aa_console','source_kind','motion_render',
  'source_id',q.id::text,'source_version',h||':'||q.request_token::text,
  'title','Accept motion render r'||c.attempt::text,'artifact_hash',h,
  'preview',public.motion_render_review_preview_v6(q),
  'destination','motion_render:'||c.id::text,'scope',public.motion_render_review_scope_v6(q),
  'owner_role','admin_or_active_client_manager','requested_by',auth.uid(),
  'requester_kind','human','expires_at',now()+interval '7 days',
  'owning_path','/clients/'||c.client_id::text||'/delivery/motion-design?tab=renders'));
 update public.motion_render_review_requests_v6 set canonical_request_id=q.canonical_request_id where id=q.id;
 return q.canonical_request_id;
end $$;

create function public.decide_motion_render_inbox_v6(p_review_id uuid,p_request_id uuid,
 p_approved boolean,p_reason text default null)
returns uuid language plpgsql volatile security definer set search_path=pg_catalog,public set timezone='UTC' as $$
 declare q public.motion_render_review_requests_v6%rowtype; c public.motion_render_candidates%rowtype; h text;
begin
 if auth.role()<>'authenticated' or auth.uid() is null or public.current_role_of() is null
  or coalesce(auth.jwt()->>'aal','')<>'aal2' then
  raise exception 'A provisioned AAL2 human must decide this render.' using errcode='42501'; end if;
 select * into q from public.motion_render_review_requests_v6 where id=p_review_id for update;
 select * into c from public.motion_render_candidates where id=q.candidate_id for update;
 perform 1 from public.motion_design_projects where id=c.project_id for update;
 if q.id is null or c.id is null or c.client_id<>q.client_id
  or not (coalesce(public.is_admin(),false)
   or auth.uid()=public.active_video_approval_manager(c.client_id))
  then raise exception 'Not the current render reviewer.' using errcode='42501'; end if;
 h:=public.motion_render_review_hash_v6(q);
 if q.canonical_request_id is distinct from p_request_id
  or public.motion_render_review_source_state_v6(p_request_id)<>'pending'
  or not exists(select 1 from public.approval_inbox_v6 i
   where i.id=p_request_id and i.status='pending' and i.preview_blocker is null)
  then raise exception 'Review the current render in Approval Inbox.' using errcode='23514'; end if;
 if not p_approved and nullif(btrim(coalesce(p_reason,'')),'') is null
  then raise exception 'A rejection reason is required.' using errcode='22023'; end if;
 if p_approved and exists(select 1 from public.motion_render_candidates other
  where other.project_id=c.project_id and other.accepted_at is not null)
  then raise exception 'This project already has an accepted cut.' using errcode='23514'; end if;
 perform public.record_approval_decision_v6(p_request_id,
  case when p_approved then 'approved' else 'rejected' end,h,
  'motion_render:'||q.id::text||':'||q.request_token::text,p_reason);
 if p_approved then
  update public.motion_render_candidates set accepted_by=auth.uid(),accepted_at=now(),
   accepted_request_id=p_request_id,accepted_content_hash=h,rejected_reason=null
   where id=c.id;
 else
  update public.motion_render_candidates set rejected_reason=btrim(p_reason) where id=c.id;
 end if;
 return c.id;
end $$;

create or replace function public.accept_motion_candidate_v6(p_candidate_id uuid,p_accepted boolean,p_reason text default null)
returns public.motion_render_candidates language plpgsql security definer set search_path=pg_catalog,public as $$
begin
 raise exception 'Decide the exact motion render in Approval Inbox.' using errcode='42501';
end $$;

-- A service-role or legacy writer must not manufacture a new acceptance.
create function public.guard_motion_render_acceptance_v6()
returns trigger language plpgsql security definer set search_path=pg_catalog,public as $$
declare q public.motion_render_review_requests_v6%rowtype; e public.approval_decision_events_v6%rowtype;
begin
 if tg_op='UPDATE' and old.accepted_at is not null and
  (new.accepted_at,new.accepted_by,new.accepted_request_id,new.accepted_content_hash)
  is distinct from
  (old.accepted_at,old.accepted_by,old.accepted_request_id,old.accepted_content_hash) then
  raise exception 'Accepted render history is immutable.' using errcode='42501';
 end if;
 if tg_op='INSERT' and new.rejected_reason is not null then
  raise exception 'Reject the exact render through Approval Inbox.' using errcode='42501';
 end if;
 if tg_op='UPDATE' and new.rejected_reason is distinct from old.rejected_reason then
  if old.rejected_reason is not null or new.rejected_reason is null then
   raise exception 'Render rejection history is immutable.' using errcode='42501'; end if;
  select * into q from public.motion_render_review_requests_v6
   where canonical_request_id=(select r.id from public.approval_requests_v6 r
    join public.approval_decision_events_v6 de on de.request_id=r.id
    where r.source_kind='motion_render' and r.client_id=new.client_id
      and de.decision='rejected' and de.actor_id=auth.uid()
    order by de.event_order desc limit 1) and candidate_id=new.id;
  select * into e from public.approval_decision_events_v6
   where request_id=q.canonical_request_id order by event_order desc limit 1;
  if q.id is null or e.decision<>'rejected' or e.actor_aal<>'aal2'
   or e.reason is distinct from new.rejected_reason then
   raise exception 'Reject the exact render through Approval Inbox.' using errcode='42501'; end if;
 end if;
 if new.accepted_at is not null and (tg_op='INSERT' or old.accepted_at is null
  or new.accepted_request_id is distinct from old.accepted_request_id) then
  select * into q from public.motion_render_review_requests_v6
   where canonical_request_id=new.accepted_request_id and candidate_id=new.id;
  select * into e from public.approval_decision_events_v6 where request_id=q.canonical_request_id
   order by event_order desc limit 1;
  if q.id is null or e.id is null or e.decision<>'approved' or e.actor_aal<>'aal2'
   or e.actor_id is distinct from auth.uid() or new.accepted_by is distinct from auth.uid()
   or new.accepted_content_hash is distinct from q.source_hash
   or public.motion_render_review_source_state_v6(q.canonical_request_id)<>'pending'
   then raise exception 'Accept the exact render through Approval Inbox.' using errcode='42501'; end if;
 end if;
 return new;
end $$;
create trigger motion_render_acceptance_guard_v6 before insert or update on public.motion_render_candidates
 for each row execute function public.guard_motion_render_acceptance_v6();

revoke all on function public.motion_render_storage_identity_v6(uuid) from public,anon,authenticated;
grant execute on function public.motion_render_storage_identity_v6(uuid) to service_role;
revoke all on function public.attest_motion_render_bytes_v6(uuid,text,text,bigint,uuid,text,timestamptz) from public,anon,authenticated;
grant execute on function public.attest_motion_render_bytes_v6(uuid,text,text,bigint,uuid,text,timestamptz) to service_role;
revoke all on function public.motion_render_review_preview_v6(public.motion_render_review_requests_v6) from public,anon,authenticated,service_role;
revoke all on function public.motion_render_review_hash_v6(public.motion_render_review_requests_v6) from public,anon,authenticated,service_role;
revoke all on function public.motion_render_review_scope_v6(public.motion_render_review_requests_v6) from public,anon,authenticated,service_role;
revoke all on function public.motion_render_review_source_state_v6(uuid) from public,anon,authenticated,service_role;
grant execute on function public.motion_render_review_source_state_v6(uuid) to authenticated,service_role;
revoke all on function public.request_motion_render_review_v6(uuid) from public,anon,service_role;
grant execute on function public.request_motion_render_review_v6(uuid) to authenticated;
revoke all on function public.decide_motion_render_inbox_v6(uuid,uuid,boolean,text) from public,anon,service_role;
grant execute on function public.decide_motion_render_inbox_v6(uuid,uuid,boolean,text) to authenticated;
revoke all on function public.guard_motion_render_acceptance_v6() from public,anon,authenticated,service_role;
select public.lock_down_definer_functions();
commit;
