-- Human idea selection is an exact internal decision; policy selection keeps
-- its separate engine_decisions lineage and never impersonates a reviewer.
begin;
alter table public.client_ideas
 add column approved_request_id uuid references public.approval_requests_v6(id),
 add column approved_content_hash text check(approved_content_hash is null or approved_content_hash ~ '^[0-9a-f]{64}$');

create table public.human_idea_review_requests_v6 (
 id uuid primary key default gen_random_uuid(),
 request_epoch bigint generated always as identity unique,
 idea_id uuid not null references public.client_ideas(id) on delete cascade,
 client_id uuid not null references public.clients(id) on delete cascade,
 request_token uuid not null default gen_random_uuid(),
 source_hash text not null default repeat('0',64) check(source_hash ~ '^[0-9a-f]{64}$'),
 canonical_request_id uuid unique references public.approval_requests_v6(id),
 created_at timestamptz not null default now()
);
create index human_idea_review_latest_v6 on public.human_idea_review_requests_v6(idea_id,request_epoch desc);
alter table public.human_idea_review_requests_v6 enable row level security;
revoke all on public.human_idea_review_requests_v6 from public,anon,authenticated,service_role;

create function public.human_idea_review_preview_v6(q public.human_idea_review_requests_v6)
returns jsonb language sql stable security definer set search_path=pg_catalog,public as $$
 select jsonb_build_object('client_id',i.client_id,'idea_id',i.id,
  'request_token',q.request_token,'selection_route','human',
  'idea',to_jsonb(i)-array['status','job_id','created_at','updated_at',
   'approved_request_id','approved_content_hash'],
  'campaign',case when c.id is null then null else jsonb_build_object(
   'id',c.id,'name',c.name,'acquisition_mode',c.acquisition_mode,
   'offer_version_id',c.offer_version_id,
   'plan_approved_fingerprint',c.plan_approved_fingerprint) end,
  'proof',case when p.id is null then null else jsonb_build_object(
   'id',p.id,'client_id',p.client_id,'usage_rights',p.usage_rights,
   'permission_basis',p.permission_basis,'expires_on',p.expires_on) end,
  'consequence','Approve this exact idea for internal brief generation; creative and distribution need their own reviews')
 from public.client_ideas i
 left join public.client_campaigns c on c.id=i.campaign_id and c.client_id=i.client_id
 left join public.client_proof_assets p on p.id=i.proof_id and p.client_id=i.client_id
 where i.id=q.idea_id and i.client_id=q.client_id;
$$;
create function public.human_idea_review_hash_v6(q public.human_idea_review_requests_v6)
returns text language sql stable security definer set search_path=pg_catalog,public as $$
 select encode(sha256(convert_to((public.human_idea_review_preview_v6(q)-'request_token')::text,'UTF8')),'hex');
$$;
create function public.human_idea_review_scope_v6(q public.human_idea_review_requests_v6)
returns jsonb language sql stable security definer set search_path=pg_catalog,public as $$
 select jsonb_build_object('client_id',q.client_id,'idea_id',q.idea_id,
  'review_id',q.id,'request_token',q.request_token,
  'content_hash',public.human_idea_review_hash_v6(q),
  'effect','human_idea_selection_for_brief');
$$;

create function public.human_idea_review_source_state_v6(p_request_id uuid)
returns text language plpgsql stable security definer set search_path=pg_catalog,public as $$
declare r public.approval_requests_v6%rowtype; q public.human_idea_review_requests_v6%rowtype;
 i public.client_ideas%rowtype; h text;
begin
 select * into r from public.approval_requests_v6 where id=p_request_id;
 if r.id is null or r.source_system<>'aa_console' or r.source_kind<>'campaign_idea'
  or r.source_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  then return 'unverified'; end if;
 if auth.role() is distinct from 'service_role' and
  (auth.role() is distinct from 'authenticated' or not public.can_access_client(r.client_id))
  then return 'unverified'; end if;
 select * into q from public.human_idea_review_requests_v6
  where id=r.source_id::uuid and canonical_request_id=r.id and client_id=r.client_id;
 if q.id is null then return 'cancelled'; end if;
 if exists(select 1 from public.human_idea_review_requests_v6 n
  where n.idea_id=q.idea_id and n.request_epoch>q.request_epoch)
  then return 'superseded'; end if;
 select * into i from public.client_ideas where id=q.idea_id and client_id=q.client_id;
 if i.id is null or i.archived_at is not null then return 'cancelled'; end if;
 h:=public.human_idea_review_hash_v6(q);
 if h is null or q.source_hash is distinct from h or r.artifact_hash is distinct from h
  or r.source_version is distinct from h||':'||q.request_token::text
  or r.preview is distinct from public.human_idea_review_preview_v6(q)
  or r.scope is distinct from public.human_idea_review_scope_v6(q)
  or r.destination is distinct from 'internal:brief:idea:'||i.id::text
  or r.owner_role is distinct from 'admin_or_active_client_manager'
  then return 'superseded'; end if;
 if i.proof_id is not null and not exists(select 1 from public.client_proof_assets p
  where p.id=i.proof_id and p.client_id=i.client_id and p.usage_rights='approved'
   and nullif(btrim(p.permission_basis),'') is not null
   and (p.expires_on is null or p.expires_on>=current_date))
  then return 'source_held'; end if;
 if i.status='draft' and i.slot_id is not null and not exists(
  select 1 from public.content_slots s where s.id=i.slot_id and s.client_id=i.client_id
   and s.stage='ideating' and s.idea_id is null) then return 'source_held'; end if;
 if i.approved_request_id=r.id and i.approved_content_hash=h
  and i.status in ('approved','briefed') then return 'source_decided'; end if;
 if i.status<>'draft' then return 'source_held'; end if;
 return 'pending';
end $$;

create function public.request_human_idea_review_v6(p_idea_id uuid)
returns uuid language plpgsql volatile security definer set search_path=pg_catalog,public set timezone='UTC' as $$
declare i public.client_ideas%rowtype; q public.human_idea_review_requests_v6%rowtype; h text;
begin
 if auth.role()<>'authenticated' or auth.uid() is null or public.current_role_of() is null
  then raise exception 'A provisioned human must request idea review.' using errcode='42501'; end if;
 select * into i from public.client_ideas where id=p_idea_id for update;
 if i.id is null or not public.can_access_client(i.client_id) then
  raise exception 'Idea is unavailable to this client.' using errcode='42501'; end if;
 if i.status<>'draft' or i.archived_at is not null or nullif(btrim(i.title),'') is null
  then raise exception 'Only a current draft idea can be reviewed.' using errcode='23514'; end if;
 if i.campaign_id is not null and not exists(select 1 from public.client_campaigns c
  where c.id=i.campaign_id and c.client_id=i.client_id) then
  raise exception 'The linked campaign is not current for this client.' using errcode='23514'; end if;
 if i.slot_id is not null and not exists(select 1 from public.content_slots s
  where s.id=i.slot_id and s.client_id=i.client_id and s.stage='ideating'
   and s.idea_id is null) then
  raise exception 'The Engine slot is no longer waiting for an idea.' using errcode='23514'; end if;
 select * into q from public.human_idea_review_requests_v6
  where idea_id=i.id order by request_epoch desc limit 1;
 if q.id is not null and q.source_hash=public.human_idea_review_hash_v6(q)
  and public.human_idea_review_source_state_v6(q.canonical_request_id)='pending'
  and exists(select 1 from public.approval_inbox_v6 x
   where x.id=q.canonical_request_id and x.status='pending')
  then return q.canonical_request_id; end if;
 insert into public.human_idea_review_requests_v6(idea_id,client_id)
  values(i.id,i.client_id) returning * into q;
 h:=public.human_idea_review_hash_v6(q);
 update public.human_idea_review_requests_v6 set source_hash=h where id=q.id returning * into q;
 q.canonical_request_id:=public.register_approval_request_v6(jsonb_build_object(
  'client_id',i.client_id,'source_system','aa_console','source_kind','campaign_idea',
  'source_id',q.id::text,'source_version',h||':'||q.request_token::text,
  'title','Select idea: '||left(i.title,260),'artifact_hash',h,
  'preview',public.human_idea_review_preview_v6(q),
  'destination','internal:brief:idea:'||i.id::text,
  'scope',public.human_idea_review_scope_v6(q),
  'owner_role','admin_or_active_client_manager','requested_by',auth.uid(),
  'requester_kind','human','expires_at',now()+interval '7 days',
  'owning_path','/clients/'||i.client_id::text||'/delivery/approval-inbox?tab=unified'));
 update public.human_idea_review_requests_v6 set canonical_request_id=q.canonical_request_id where id=q.id;
 return q.canonical_request_id;
end $$;

create function public.decide_human_idea_inbox_v6(p_review_id uuid,p_request_id uuid,
 p_approved boolean,p_reason text default null)
returns uuid language plpgsql volatile security definer set search_path=pg_catalog,public set timezone='UTC' as $$
declare q public.human_idea_review_requests_v6%rowtype; i public.client_ideas%rowtype; h text;
begin
 if auth.role()<>'authenticated' or auth.uid() is null or public.current_role_of() is null
  or coalesce(auth.jwt()->>'aal','')<>'aal2' then
  raise exception 'A provisioned AAL2 human must select this idea.' using errcode='42501'; end if;
 select * into q from public.human_idea_review_requests_v6 where id=p_review_id for update;
 select * into i from public.client_ideas where id=q.idea_id for update;
 if q.id is null or i.id is null or i.client_id<>q.client_id
  or not (coalesce(public.is_admin(),false)
   or auth.uid()=public.active_video_approval_manager(i.client_id))
  then raise exception 'Not the current idea decision owner.' using errcode='42501'; end if;
 h:=public.human_idea_review_hash_v6(q);
 if q.canonical_request_id is distinct from p_request_id
  or public.human_idea_review_source_state_v6(p_request_id)<>'pending'
  or not exists(select 1 from public.approval_inbox_v6 x
   where x.id=p_request_id and x.status='pending' and x.preview_blocker is null)
  then raise exception 'Review the current idea in Approval Inbox.' using errcode='23514'; end if;
 if not p_approved and nullif(btrim(coalesce(p_reason,'')),'') is null
  then raise exception 'A rejection reason is required.' using errcode='22023'; end if;
 perform public.record_approval_decision_v6(p_request_id,
  case when p_approved then 'approved' else 'rejected' end,h,
  'campaign_idea:'||q.id::text||':'||q.request_token::text,p_reason);
 if p_approved then
  update public.client_ideas set status='approved',approved_request_id=p_request_id,
   approved_content_hash=h where id=i.id;
  if i.slot_id is not null then
   perform public.advance_slot(i.slot_id,'idea_selected','human',
    'Selected exact idea in Approval Inbox.',null,null,null,i.id);
  end if;
 else
  update public.client_ideas set status='rejected' where id=i.id;
 end if;
 return i.id;
end $$;

create function public.human_idea_approval_current_v6(p_idea_id uuid)
returns boolean language plpgsql stable security definer set search_path=pg_catalog,public as $$
declare i public.client_ideas%rowtype; q public.human_idea_review_requests_v6%rowtype;
 e public.approval_decision_events_v6%rowtype;
begin
 select * into i from public.client_ideas where id=p_idea_id;
 if i.id is null or i.approved_request_id is null or i.status not in ('approved','briefed')
  or (auth.role() is distinct from 'service_role' and
   (auth.role() is distinct from 'authenticated' or not public.can_access_client(i.client_id)))
  then return false; end if;
 select * into q from public.human_idea_review_requests_v6
  where canonical_request_id=i.approved_request_id and idea_id=i.id;
 select * into e from public.approval_decision_events_v6
  where request_id=i.approved_request_id order by event_order desc limit 1;
 return q.id is not null and e.decision='approved' and e.actor_aal='aal2'
  and e.artifact_hash=q.source_hash and i.approved_content_hash=q.source_hash
  and public.human_idea_review_source_state_v6(i.approved_request_id)='source_decided'
  and not exists(select 1 from public.delivery_approval_invalidations_v6 x
   where x.approval_request_id=i.approved_request_id);
end $$;

revoke all on function public.human_idea_review_preview_v6(public.human_idea_review_requests_v6) from public,anon,authenticated,service_role;
revoke all on function public.human_idea_review_hash_v6(public.human_idea_review_requests_v6) from public,anon,authenticated,service_role;
revoke all on function public.human_idea_review_scope_v6(public.human_idea_review_requests_v6) from public,anon,authenticated,service_role;
revoke all on function public.human_idea_review_source_state_v6(uuid) from public,anon,authenticated,service_role;
grant execute on function public.human_idea_review_source_state_v6(uuid) to authenticated,service_role;
revoke all on function public.request_human_idea_review_v6(uuid) from public,anon,service_role;
grant execute on function public.request_human_idea_review_v6(uuid) to authenticated;
revoke all on function public.decide_human_idea_inbox_v6(uuid,uuid,boolean,text) from public,anon,service_role;
grant execute on function public.decide_human_idea_inbox_v6(uuid,uuid,boolean,text) to authenticated;
revoke all on function public.human_idea_approval_current_v6(uuid) from public,anon,authenticated,service_role;
grant execute on function public.human_idea_approval_current_v6(uuid) to authenticated,service_role;
select public.lock_down_definer_functions();
commit;
