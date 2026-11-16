-- Approval permits planning; activation is a separate exact decision.
begin;
alter table public.market_opportunities
 add column activated_request_id uuid references public.approval_requests_v6(id),
 add column activated_content_hash text check (activated_content_hash is null or activated_content_hash ~ '^[0-9a-f]{64}$');

-- Keep existing opportunity approvals current after adding activation columns.
create or replace function public.opportunity_approval_preview_v6(p_id uuid)
returns jsonb language sql stable security definer
set search_path = pg_catalog, public as $$
  select jsonb_build_object(
    'opportunity_id',o.id,'client_id',o.client_id,
    'request_token',o.approval_request_token,
    'opportunity',to_jsonb(o) - array['status','status_note','updated_at',
      'approval_request_token','approved_request_id','approved_content_hash',
      'activated_request_id','activated_content_hash'],
    'score',(select to_jsonb(s) from public.opportunity_scores s
      where s.opportunity_id = o.id order by s.scored_at desc,s.id desc limit 1),
    'attributes',coalesce((select jsonb_agg(jsonb_build_object(
      'kind',a.kind,'position',a.position,'body',a.body)
      order by a.kind,a.position) from public.opportunity_attributes a
      where a.opportunity_id = o.id),'[]'::jsonb),
    'awareness',coalesce((select jsonb_agg(jsonb_build_object(
      'stage',a.stage,'mindset',a.mindset,'message',a.message,
      'asset_direction',a.asset_direction,'distribution_note',a.distribution_note)
      order by a.stage) from public.opportunity_awareness_stages a
      where a.opportunity_id = o.id),'[]'::jsonb),
    'links',coalesce((select jsonb_agg(jsonb_build_object(
      'role',l.role,'record_id',l.record_id,'offer_id',l.offer_id,
      'campaign_id',l.campaign_id,
      'record',case when r.id is not null then jsonb_build_object(
        'domain',r.domain,'title',r.title,'body',r.body,'status',r.status,
        'updated_at',r.updated_at) else null end)
      order by l.role,l.id) from public.opportunity_links l
      left join public.client_agent_records r on r.id = l.record_id
      where l.opportunity_id = o.id and l.role <> 'campaign'),'[]'::jsonb),
    'proof_requirements',coalesce((select jsonb_agg(jsonb_build_object(
      'requirement',q.requirement,'proof_id',q.proof_id,
      'proof_rights',p.usage_rights,'proof_expiry',p.expires_on,
      'proof_basis',p.permission_basis) order by q.id)
      from public.opportunity_proof_requirements q
      left join public.client_proof_assets p on p.id = q.proof_id
      where q.opportunity_id = o.id),'[]'::jsonb),
    'consequence','Allows a campaign to be planned against this evidenced buying situation'
  ) from public.market_opportunities o where o.id = p_id;
$$;

create table public.opportunity_activation_requests_v6 (
 id uuid primary key default gen_random_uuid(),
 request_epoch bigint generated always as identity unique,
 opportunity_id uuid not null references public.market_opportunities(id) on delete cascade,
 client_id uuid not null references public.clients(id) on delete cascade,
 request_token uuid not null default gen_random_uuid(),
 activation_note text check (activation_note is null or length(activation_note)<=2000),
 source_hash text not null default repeat('0',64) check (source_hash ~ '^[0-9a-f]{64}$'),
 canonical_request_id uuid unique references public.approval_requests_v6(id),
 created_at timestamptz not null default now()
);
create index opportunity_activation_latest_v6
 on public.opportunity_activation_requests_v6(opportunity_id,request_epoch desc);
alter table public.opportunity_activation_requests_v6 enable row level security;
revoke all on public.opportunity_activation_requests_v6 from public,anon,authenticated,service_role;

create function public.opportunity_activation_preview_v6(q public.opportunity_activation_requests_v6)
returns jsonb language sql stable security definer set search_path=pg_catalog,public as $$
 select jsonb_build_object('client_id',o.client_id,'opportunity_id',o.id,
  'request_token',q.request_token,'activation_note',q.activation_note,
  'approved_request_id',o.approved_request_id,
  'approved_content_hash',o.approved_content_hash,
  'approved_opportunity',public.opportunity_approval_preview_v6(o.id),
  'campaigns',coalesce((select jsonb_agg(jsonb_build_object(
    'campaign_id',l.campaign_id,'role',l.role) order by l.campaign_id)
    from public.opportunity_links l where l.opportunity_id=o.id
      and l.role='campaign'),'[]'::jsonb),
  'consequence','Mark this approved market opportunity active; campaign and outward actions retain their own gates')
 from public.market_opportunities o where o.id=q.opportunity_id and o.client_id=q.client_id;
$$;
create function public.opportunity_activation_hash_v6(q public.opportunity_activation_requests_v6)
returns text language sql stable security definer set search_path=pg_catalog,public as $$
 select encode(sha256(convert_to((public.opportunity_activation_preview_v6(q)-'request_token')::text,'UTF8')),'hex');
$$;
create function public.opportunity_activation_scope_v6(q public.opportunity_activation_requests_v6)
returns jsonb language sql stable security definer set search_path=pg_catalog,public as $$
 select jsonb_build_object('client_id',q.client_id,'opportunity_id',q.opportunity_id,
  'activation_id',q.id,'request_token',q.request_token,
  'content_hash',public.opportunity_activation_hash_v6(q),
  'effect','opportunity_status_active');
$$;

create function public.opportunity_activation_source_state_v6(p_request_id uuid)
returns text language plpgsql stable security definer set search_path=pg_catalog,public as $$
declare r public.approval_requests_v6%rowtype;
 q public.opportunity_activation_requests_v6%rowtype;
 o public.market_opportunities%rowtype; h text;
begin
 select * into r from public.approval_requests_v6 where id=p_request_id;
 if r.id is null or r.source_system<>'aa_console' or r.source_kind<>'opportunity_activate'
  or r.source_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  then return 'unverified'; end if;
 if auth.role() is distinct from 'service_role' and
  (auth.role() is distinct from 'authenticated' or not public.can_review_approval_request_v6(r.client_id,r.owner_role))
  then return 'unverified'; end if;
 select * into q from public.opportunity_activation_requests_v6 where id=r.source_id::uuid
  and client_id=r.client_id and canonical_request_id=r.id;
 if q.id is null then return 'cancelled'; end if;
 if exists(select 1 from public.opportunity_activation_requests_v6 newer
  where newer.opportunity_id=q.opportunity_id and newer.request_epoch>q.request_epoch)
  then return 'superseded'; end if;
 select * into o from public.market_opportunities where id=q.opportunity_id and client_id=q.client_id;
 if o.id is null then return 'cancelled'; end if;
 h:=public.opportunity_activation_hash_v6(q);
 if h is null or q.source_hash is distinct from h or r.artifact_hash is distinct from h
  or r.source_version is distinct from h||':'||q.request_token::text
  or r.preview is distinct from public.opportunity_activation_preview_v6(q)
  or r.scope is distinct from public.opportunity_activation_scope_v6(q)
  or r.destination is distinct from 'market_opportunity:'||o.id::text||':active'
  then return 'superseded'; end if;
 if o.status in ('active','learning','scaling') and o.activated_request_id=r.id
  and o.activated_content_hash=h and public.opportunity_approval_current_v6(o.id)
  then return 'source_decided'; end if;
 if o.status<>'approved' or not public.opportunity_approval_current_v6(o.id)
  or exists(select 1 from public.opportunity_readiness ready
   where ready.opportunity_id=o.id and ready.blocker is not null)
  then return 'source_held'; end if;
 return 'pending';
end $$;

create function public.opportunity_activation_current_v6(p_opportunity_id uuid)
returns boolean language plpgsql stable security definer set search_path=pg_catalog,public as $$
declare o public.market_opportunities%rowtype;
 q public.opportunity_activation_requests_v6%rowtype;
 e public.approval_decision_events_v6%rowtype;
begin
 if auth.role() not in ('authenticated','service_role') then return false; end if;
 select * into o from public.market_opportunities where id=p_opportunity_id;
 if o.id is null or o.status not in ('active','learning','scaling')
  or o.activated_request_id is null then return false; end if;
 if auth.role()='authenticated' and not public.can_access_client(o.client_id)
  then return false; end if;
 select * into q from public.opportunity_activation_requests_v6
  where canonical_request_id=o.activated_request_id and opportunity_id=o.id and client_id=o.client_id;
 if q.id is null or o.activated_content_hash is distinct from q.source_hash
  or public.opportunity_activation_source_state_v6(o.activated_request_id)<>'source_decided'
  then return false; end if;
 select * into e from public.approval_decision_events_v6
  where request_id=o.activated_request_id order by event_order desc limit 1;
 return coalesce(e.decision='approved' and e.actor_aal='aal2'
  and e.artifact_hash=q.source_hash
  and e.source_decision_ref='opportunity_activate:'||q.id::text||':'||q.request_token::text
  and exists(select 1 from public.approval_inbox_v6 i
   where i.id=o.activated_request_id and i.status='approved' and i.preview_blocker is null),false);
end $$;

create view public.opportunity_activation_state_v6 with (security_invoker=true) as
 select o.id as opportunity_id,o.client_id,o.status,
  case when o.status not in ('active','learning','scaling') then 'not_applicable'
   when o.activated_request_id is null then 'legacy'
   when public.opportunity_activation_current_v6(o.id) then 'current'
   else 'stale' end as activation_state
 from public.market_opportunities o;
revoke all on public.opportunity_activation_state_v6 from public,anon,authenticated,service_role;
grant select on public.opportunity_activation_state_v6 to authenticated,service_role;

create function public.request_opportunity_activation_v6(p_opportunity_id uuid,p_note text default null)
returns uuid language plpgsql volatile security definer set search_path=pg_catalog,public set timezone='UTC' as $$
declare o public.market_opportunities%rowtype;
 q public.opportunity_activation_requests_v6%rowtype; h text;
begin
 if auth.role()<>'authenticated' or auth.uid() is null or public.current_role_of() is null
  then raise exception 'A provisioned human must request activation.' using errcode='42501'; end if;
 select * into o from public.market_opportunities where id=p_opportunity_id for update;
 if o.id is null or not public.can_shape_opportunity(o.client_id)
  then raise exception 'The opportunity or activation owner is unavailable.' using errcode='42501'; end if;
 if o.status<>'approved' or not public.opportunity_approval_current_v6(o.id)
  or exists(select 1 from public.opportunity_readiness ready
   where ready.opportunity_id=o.id and ready.blocker is not null)
  then raise exception 'The current approved opportunity is not ready to activate.' using errcode='23514'; end if;
 if length(coalesce(p_note,''))>2000 then raise exception 'Activation note is too long.' using errcode='22023'; end if;
 select * into q from public.opportunity_activation_requests_v6
  where opportunity_id=o.id order by request_epoch desc limit 1;
 if q.id is not null and q.activation_note is not distinct from nullif(btrim(p_note),'')
  and q.source_hash=public.opportunity_activation_hash_v6(q)
  and public.opportunity_activation_source_state_v6(q.canonical_request_id)='pending'
  and exists(select 1 from public.approval_inbox_v6 i
   where i.id=q.canonical_request_id and i.status='pending')
  then return q.canonical_request_id; end if;
 insert into public.opportunity_activation_requests_v6(opportunity_id,client_id,activation_note)
  values(o.id,o.client_id,nullif(btrim(p_note),'')) returning * into q;
 h:=public.opportunity_activation_hash_v6(q);
 update public.opportunity_activation_requests_v6 set source_hash=h where id=q.id returning * into q;
 q.canonical_request_id:=public.register_approval_request_v6(jsonb_build_object(
  'client_id',q.client_id,'source_system','aa_console','source_kind','opportunity_activate',
  'source_id',q.id::text,'source_version',h||':'||q.request_token::text,
  'title','Activate market opportunity: '||o.name,
  'artifact_hash',h,'preview',public.opportunity_activation_preview_v6(q),
  'destination','market_opportunity:'||o.id::text||':active',
  'scope',public.opportunity_activation_scope_v6(q),
  'owner_role','admin_or_active_client_manager','requested_by',auth.uid(),
  'requester_kind','human','expires_at',now()+interval '7 days',
  'owning_path','/clients/'||o.client_id::text||'/delivery/market-opportunities?opportunity='||o.id::text));
 update public.opportunity_activation_requests_v6 set canonical_request_id=q.canonical_request_id where id=q.id;
 return q.canonical_request_id;
end $$;

create function public.guard_opportunity_activation_v6()
returns trigger language plpgsql security definer set search_path=pg_catalog,public as $$
declare q public.opportunity_activation_requests_v6%rowtype;
 e public.approval_decision_events_v6%rowtype;
begin
 if new.status='active' and old.status is distinct from 'active' then
  select * into q from public.opportunity_activation_requests_v6
   where canonical_request_id=new.activated_request_id
     and opportunity_id=new.id and client_id=new.client_id;
  select * into e from public.approval_decision_events_v6 where request_id=q.canonical_request_id
   order by event_order desc limit 1;
  if old.status<>'approved' or auth.role()<>'authenticated'
   or coalesce(auth.jwt()->>'aal','')<>'aal2' or q.id is null
   or new.activated_content_hash is distinct from q.source_hash
   or e.decision is distinct from 'approved' or e.actor_aal<>'aal2'
   or e.actor_id is distinct from auth.uid() or e.artifact_hash is distinct from q.source_hash
   or public.opportunity_activation_source_state_v6(q.canonical_request_id)<>'pending'
   then raise exception 'Activate this exact opportunity in Approval Inbox.' using errcode='42501'; end if;
 end if;
 if new.status in ('learning','scaling') and new.status is distinct from old.status
  and not public.opportunity_activation_current_v6(old.id) then
  raise exception 'A current exact activation decision is required before progressing.'
   using errcode='42501'; end if;
 if new.status in ('paused','rejected') and old.status in ('active','learning','scaling') then
  new.activated_request_id:=null; new.activated_content_hash:=null;
 elsif new.status='approved' and old.status in ('active','learning','scaling') then
  new.activated_request_id:=null; new.activated_content_hash:=null;
 elsif (new.activated_request_id,new.activated_content_hash) is distinct from
   (old.activated_request_id,old.activated_content_hash)
   and not (new.status='active' and old.status='approved') then
  raise exception 'Opportunity activation signature is source-owned.' using errcode='42501';
 end if;
 return new;
end $$;
create trigger opportunity_activation_guard_v6 before update on public.market_opportunities
 for each row execute function public.guard_opportunity_activation_v6();

create function public.decide_opportunity_activation_inbox_v6(
 p_activation_id uuid,p_request_id uuid,p_approved boolean,p_reason text default null)
returns uuid language plpgsql volatile security definer set search_path=pg_catalog,public set timezone='UTC' as $$
declare q public.opportunity_activation_requests_v6%rowtype;
 o public.market_opportunities%rowtype; h text;
begin
 if auth.role()<>'authenticated' or auth.uid() is null or public.current_role_of() is null
  or coalesce(auth.jwt()->>'aal','')<>'aal2' then
  raise exception 'A provisioned AAL2 human must decide activation.' using errcode='42501'; end if;
 select * into q from public.opportunity_activation_requests_v6 where id=p_activation_id for update;
 select * into o from public.market_opportunities where id=q.opportunity_id for update;
 if q.id is null or o.id is null or o.client_id<>q.client_id
  or not public.can_shape_opportunity(o.client_id)
  then raise exception 'The activation decision owner is unavailable.' using errcode='42501'; end if;
 h:=public.opportunity_activation_hash_v6(q);
 if q.canonical_request_id is distinct from p_request_id
  or public.opportunity_activation_source_state_v6(p_request_id)<>'pending'
  or not exists(select 1 from public.approval_inbox_v6 i
   where i.id=p_request_id and i.status='pending' and i.preview_blocker is null)
  then raise exception 'Review the current opportunity activation in Approval Inbox.' using errcode='23514'; end if;
 if not p_approved and nullif(btrim(coalesce(p_reason,'')),'') is null
  then raise exception 'A rejection reason is required.' using errcode='22023'; end if;
 perform public.record_approval_decision_v6(p_request_id,
  case when p_approved then 'approved' else 'rejected' end,h,
  'opportunity_activate:'||q.id::text||':'||q.request_token::text,p_reason);
 if p_approved then
  update public.market_opportunities set status='active',status_note=q.activation_note,
   activated_request_id=p_request_id,activated_content_hash=h where id=o.id;
 end if;
 insert into public.opportunity_events(opportunity_id,client_id,event,actor,detail)
  values(o.id,o.client_id,'status_changed','human',
   case when p_approved then 'activated via exact Inbox request ' else 'activation rejected via Inbox request ' end||p_request_id::text);
 return o.id;
end $$;

revoke all on function public.opportunity_activation_preview_v6(public.opportunity_activation_requests_v6) from public,anon,authenticated,service_role;
revoke all on function public.opportunity_activation_hash_v6(public.opportunity_activation_requests_v6) from public,anon,authenticated,service_role;
revoke all on function public.opportunity_activation_scope_v6(public.opportunity_activation_requests_v6) from public,anon,authenticated,service_role;
revoke all on function public.opportunity_activation_source_state_v6(uuid) from public,anon,authenticated,service_role;
grant execute on function public.opportunity_activation_source_state_v6(uuid) to authenticated,service_role;
revoke all on function public.opportunity_activation_current_v6(uuid) from public,anon,authenticated,service_role;
grant execute on function public.opportunity_activation_current_v6(uuid) to authenticated,service_role;
revoke all on function public.request_opportunity_activation_v6(uuid,text) from public,anon,service_role;
grant execute on function public.request_opportunity_activation_v6(uuid,text) to authenticated;
revoke all on function public.decide_opportunity_activation_inbox_v6(uuid,uuid,boolean,text) from public,anon,service_role;
grant execute on function public.decide_opportunity_activation_inbox_v6(uuid,uuid,boolean,text) to authenticated;
revoke all on function public.guard_opportunity_activation_v6() from public,anon,authenticated,service_role;
select public.lock_down_definer_functions();
commit;
