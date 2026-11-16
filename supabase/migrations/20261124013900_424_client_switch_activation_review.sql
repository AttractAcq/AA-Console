-- Per-client automation enablement is a governance decision. Turning a switch
-- off remains immediate; an Inbox decision calls the original setter so its
-- existing prerequisites still run in the same transaction.
begin;

create table public.client_switch_activation_reviews_v6 (
 id uuid primary key default gen_random_uuid(),
 request_epoch bigint generated always as identity unique,
 client_id uuid not null references public.clients(id) on delete cascade,
 switch_key text not null check (switch_key in (
  'engine','auto_approve_ideas','auto_approve_briefs','publishing',
  'proof_publishing','campaign_actions','outbound_messaging',
  'lead_magnet_delivery')),
 request_token uuid not null default gen_random_uuid(),
 source_hash text not null default repeat('0',64) check (source_hash ~ '^[0-9a-f]{64}$'),
 canonical_request_id uuid unique references public.approval_requests_v6(id),
 applied_at timestamptz,
 applied_by uuid references auth.users(id),
 created_at timestamptz not null default now()
);
create index client_switch_review_latest_v6 on public.client_switch_activation_reviews_v6
 (client_id,switch_key,request_epoch desc);
alter table public.client_switch_activation_reviews_v6 enable row level security;
revoke all on public.client_switch_activation_reviews_v6 from public,anon,authenticated,service_role;

create function public.client_switch_column_v6(p_switch_key text)
returns text language sql immutable security definer set search_path=pg_catalog,public as $$
 select case p_switch_key
  when 'engine' then 'enabled'
  when 'publishing' then 'publishing_enabled'
  when 'proof_publishing' then 'proof_publishing_enabled'
  when 'campaign_actions' then 'campaign_actions_enabled'
  when 'outbound_messaging' then 'outbound_messaging_enabled'
  when 'lead_magnet_delivery' then 'lead_magnet_delivery_enabled'
  when 'auto_approve_ideas' then 'auto_approve_ideas'
  when 'auto_approve_briefs' then 'auto_approve_briefs'
  else null end;
$$;

create function public.client_switch_activation_preview_v6(q public.client_switch_activation_reviews_v6)
returns jsonb language sql stable security definer set search_path=pg_catalog,public as $$
 select jsonb_build_object(
  'client_id',q.client_id,'switch_key',q.switch_key,
  'action','enable','scope','one client until manually disabled',
  'request_token',q.request_token,
  'settings',to_jsonb(s)-array['updated_at','campaign_actions_enabled_at',
   'campaign_actions_enabled_by'],
  'consequence',case q.switch_key
   when 'engine' then 'Start recurring planning and internal production within the configured spend cap'
   when 'auto_approve_ideas' then 'Permit policy selection of generated ideas for Engine slots'
   when 'auto_approve_briefs' then 'Permit policy selection of generated briefs for Engine slots'
   when 'publishing' then 'Permit separately approved organic posts to be published to this client accounts'
   when 'proof_publishing' then 'Permit separately approved proof placements to reach supported destinations'
   when 'campaign_actions' then 'Permit separately approved campaign actions to be claimed by attested handlers'
   when 'outbound_messaging' then 'Permit separately approved outbound messages to be sent'
   when 'lead_magnet_delivery' then 'Permit separately approved lead magnets to be delivered'
   end,
  'external_action_note','Each external action still requires its own exact approval, provider preflight and receipt')
 from public.client_engine_settings s where s.client_id=q.client_id;
$$;

create function public.client_switch_activation_hash_v6(q public.client_switch_activation_reviews_v6)
returns text language sql stable security definer set search_path=pg_catalog,public as $$
 select encode(sha256(convert_to((public.client_switch_activation_preview_v6(q)-'request_token')::text,'UTF8')),'hex');
$$;

create function public.client_switch_activation_scope_v6(q public.client_switch_activation_reviews_v6)
returns jsonb language sql stable security definer set search_path=pg_catalog,public as $$
 select jsonb_build_object('client_id',q.client_id,'switch_key',q.switch_key,
  'review_id',q.id,'request_token',q.request_token,
  'content_hash',public.client_switch_activation_hash_v6(q),
  'effect','enable_client_automation_switch');
$$;

create function public.client_switch_activation_source_state_v6(p_request_id uuid)
returns text language plpgsql stable security definer set search_path=pg_catalog,public as $$
declare r public.approval_requests_v6%rowtype; q public.client_switch_activation_reviews_v6%rowtype;
 s public.client_engine_settings%rowtype; h text; col text;
begin
 select * into r from public.approval_requests_v6 where id=p_request_id;
 if r.id is null or r.source_system<>'aa_console' or r.source_kind<>'activation_switch'
  or r.source_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  then return 'unverified'; end if;
 if auth.role() is distinct from 'service_role' and
  (auth.role() is distinct from 'authenticated' or not public.can_access_client(r.client_id))
  then return 'unverified'; end if;
 select * into q from public.client_switch_activation_reviews_v6
  where id=r.source_id::uuid and canonical_request_id=r.id and client_id=r.client_id;
 if q.id is null then return 'cancelled'; end if;
 if exists(select 1 from public.client_switch_activation_reviews_v6 n
  where n.client_id=q.client_id and n.switch_key=q.switch_key and n.request_epoch>q.request_epoch)
  then return 'superseded'; end if;
 col:=public.client_switch_column_v6(q.switch_key);
 select * into s from public.client_engine_settings where client_id=q.client_id;
 if s.client_id is null or col is null then return 'cancelled'; end if;
 if q.applied_at is not null then
  if (to_jsonb(s)->>col)::boolean is true and exists(
   select 1 from public.approval_decision_events_v6 e where e.request_id=r.id
    and e.decision='approved' and e.actor_aal='aal2' and e.actor_id=q.applied_by
    and e.artifact_hash=q.source_hash and r.artifact_hash=q.source_hash)
   then return 'source_decided'; end if;
  return 'source_held';
 end if;
 h:=public.client_switch_activation_hash_v6(q);
 if h is null or q.source_hash is distinct from h or r.artifact_hash is distinct from h
  or r.source_version is distinct from h||':'||q.request_token::text
  or r.preview is distinct from public.client_switch_activation_preview_v6(q)
  or r.scope is distinct from public.client_switch_activation_scope_v6(q)
  or r.destination is distinct from 'client:automation:'||q.client_id::text||':'||q.switch_key
  or r.owner_role is distinct from 'admin'
  then return 'superseded'; end if;
 if (to_jsonb(s)->>col)::boolean is true then return 'source_held'; end if;
 return 'pending';
end $$;

create function public.request_client_switch_activation_v6(p_client_id uuid,p_switch_key text)
returns uuid language plpgsql volatile security definer set search_path=pg_catalog,public set timezone='UTC' as $$
declare q public.client_switch_activation_reviews_v6%rowtype; s public.client_engine_settings%rowtype;
 col text; h text;
begin
 if auth.role()<>'authenticated' or auth.uid() is null or public.current_role_of() is null
  or not coalesce(public.is_admin(),false) then
  raise exception 'A provisioned admin must request switch activation.' using errcode='42501'; end if;
 col:=public.client_switch_column_v6(p_switch_key);
 if p_client_id is null or col is null then raise exception 'Unknown client switch.' using errcode='22023'; end if;
 select * into s from public.client_engine_settings where client_id=p_client_id for update;
 if s.client_id is null or (to_jsonb(s)->>col)::boolean is true then
  raise exception 'Configure this client and leave the switch off before requesting activation.' using errcode='23514'; end if;
 select * into q from public.client_switch_activation_reviews_v6
  where client_id=p_client_id and switch_key=p_switch_key order by request_epoch desc limit 1;
 if q.id is not null and q.source_hash=public.client_switch_activation_hash_v6(q)
  and public.client_switch_activation_source_state_v6(q.canonical_request_id)='pending'
  and exists(select 1 from public.approval_inbox_v6 x where x.id=q.canonical_request_id and x.status='pending')
  then return q.canonical_request_id; end if;
 insert into public.client_switch_activation_reviews_v6(client_id,switch_key)
  values(p_client_id,p_switch_key) returning * into q;
 h:=public.client_switch_activation_hash_v6(q);
 update public.client_switch_activation_reviews_v6 set source_hash=h where id=q.id returning * into q;
 q.canonical_request_id:=public.register_approval_request_v6(jsonb_build_object(
  'client_id',p_client_id,'source_system','aa_console','source_kind','activation_switch',
  'source_id',q.id::text,'source_version',h||':'||q.request_token::text,
  'title','Enable client automation: '||replace(p_switch_key,'_',' '),
  'artifact_hash',h,'preview',public.client_switch_activation_preview_v6(q),
  'destination','client:automation:'||p_client_id::text||':'||p_switch_key,
  'scope',public.client_switch_activation_scope_v6(q),'owner_role','admin',
  'requested_by',auth.uid(),'requester_kind','human','expires_at',now()+interval '1 day',
  'owning_path','/clients/'||p_client_id::text||'/delivery/approval-inbox?tab=unified'));
 update public.client_switch_activation_reviews_v6 set canonical_request_id=q.canonical_request_id where id=q.id;
 return q.canonical_request_id;
end $$;

-- A direct setter, direct table update or service-role write cannot enable a
-- client switch without the current exact AAL2 decision in this transaction.
create function public.guard_client_switch_activation_v6()
returns trigger language plpgsql security definer set search_path=pg_catalog,public as $$
declare k text; col text; review_id uuid; q public.client_switch_activation_reviews_v6%rowtype;
 e public.approval_decision_events_v6%rowtype;
begin
 foreach k in array array['engine','auto_approve_ideas','auto_approve_briefs',
  'publishing','proof_publishing','campaign_actions','outbound_messaging',
  'lead_magnet_delivery'] loop
  col:=public.client_switch_column_v6(k);
  if (to_jsonb(new)->>col)::boolean is not true
   or (tg_op='UPDATE' and (to_jsonb(old)->>col)::boolean is true) then continue; end if;
  if nullif(current_setting('aa.activation_review_id',true),'') is null
   or current_setting('aa.activation_review_id',true)
      !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
   then raise exception 'Enable this switch through its exact Approval Inbox decision.' using errcode='42501'; end if;
  review_id:=current_setting('aa.activation_review_id',true)::uuid;
  select * into q from public.client_switch_activation_reviews_v6
   where canonical_request_id=review_id and client_id=new.client_id and switch_key=k;
  select * into e from public.approval_decision_events_v6
   where request_id=review_id order by event_order desc limit 1;
  if q.id is null or q.applied_at is not null or e.decision<>'approved'
   or e.actor_aal<>'aal2' or e.actor_id is distinct from auth.uid()
   or e.artifact_hash is distinct from q.source_hash
   or public.client_switch_activation_source_state_v6(review_id)<>'pending'
   then raise exception 'The switch activation review is missing or stale.' using errcode='42501'; end if;
 end loop;
 return new;
end $$;
create trigger client_switch_activation_guard_v6
 before insert or update on public.client_engine_settings
 for each row execute function public.guard_client_switch_activation_v6();

-- Editing and reverting configuration cannot revive an old pending card.
create function public.invalidate_client_switch_activation_v6()
returns trigger language plpgsql security definer set search_path=pg_catalog,public as $$
begin
 if to_jsonb(new)-array['updated_at','campaign_actions_enabled_at','campaign_actions_enabled_by']
  is distinct from to_jsonb(old)-array['updated_at','campaign_actions_enabled_at','campaign_actions_enabled_by'] then
  update public.client_switch_activation_reviews_v6 set request_token=gen_random_uuid()
   where client_id=new.client_id and applied_at is null
    and canonical_request_id::text is distinct from nullif(current_setting('aa.activation_review_id',true),'');
 end if;
 return new;
end $$;
create trigger client_switch_activation_invalidation_v6
 after update on public.client_engine_settings
 for each row execute function public.invalidate_client_switch_activation_v6();

create function public.decide_client_switch_activation_v6(p_review_id uuid,p_request_id uuid,
 p_approved boolean,p_reason text default null)
returns uuid language plpgsql volatile security definer set search_path=pg_catalog,public set timezone='UTC' as $$
declare q public.client_switch_activation_reviews_v6%rowtype; s public.client_engine_settings%rowtype;
 h text;
begin
 if auth.role()<>'authenticated' or auth.uid() is null or public.current_role_of() is null
  or not coalesce(public.is_admin(),false) or coalesce(auth.jwt()->>'aal','')<>'aal2' then
  raise exception 'A provisioned AAL2 admin must decide switch activation.' using errcode='42501'; end if;
 select * into q from public.client_switch_activation_reviews_v6 where id=p_review_id for update;
 if q.id is null or q.canonical_request_id is distinct from p_request_id then
  raise exception 'Activation review is unavailable.' using errcode='23514'; end if;
 select * into s from public.client_engine_settings where client_id=q.client_id for update;
 h:=public.client_switch_activation_hash_v6(q);
 if public.client_switch_activation_source_state_v6(p_request_id)<>'pending'
  or not exists(select 1 from public.approval_inbox_v6 x
   where x.id=p_request_id and x.status='pending' and x.preview_blocker is null)
  then raise exception 'Review the current switch activation in Approval Inbox.' using errcode='23514'; end if;
 if not p_approved and nullif(btrim(coalesce(p_reason,'')),'') is null
  then raise exception 'A rejection reason is required.' using errcode='22023'; end if;
 perform public.record_approval_decision_v6(p_request_id,
  case when p_approved then 'approved' else 'rejected' end,h,
  'activation_switch:'||q.id::text||':'||q.request_token::text,p_reason);
 if p_approved then
  perform set_config('aa.activation_review_id',p_request_id::text,true);
  case q.switch_key
   when 'engine' then perform public.set_engine_enabled(q.client_id,true);
   when 'publishing' then perform public.set_publishing_enabled(q.client_id,true);
   when 'proof_publishing' then perform public.set_proof_publishing_enabled(q.client_id,true);
   when 'campaign_actions' then perform public.set_campaign_actions_enabled(q.client_id,true);
   when 'outbound_messaging' then perform public.set_outbound_messaging_enabled(q.client_id,true);
   when 'lead_magnet_delivery' then perform public.set_lead_magnet_delivery_enabled(q.client_id,true);
   when 'auto_approve_ideas' then perform public.set_engine_settings(q.client_id,p_auto_approve_ideas=>true);
   when 'auto_approve_briefs' then perform public.set_engine_settings(q.client_id,p_auto_approve_briefs=>true);
   else raise exception 'Unsupported client switch.' using errcode='22023';
  end case;
  update public.client_switch_activation_reviews_v6 set applied_at=now(),applied_by=auth.uid()
   where id=q.id;
  perform set_config('aa.activation_review_id','',true);
 end if;
 return q.id;
end $$;

revoke all on function public.client_switch_column_v6(text) from public,anon,authenticated,service_role;
revoke all on function public.client_switch_activation_preview_v6(public.client_switch_activation_reviews_v6) from public,anon,authenticated,service_role;
revoke all on function public.client_switch_activation_hash_v6(public.client_switch_activation_reviews_v6) from public,anon,authenticated,service_role;
revoke all on function public.client_switch_activation_scope_v6(public.client_switch_activation_reviews_v6) from public,anon,authenticated,service_role;
revoke all on function public.client_switch_activation_source_state_v6(uuid) from public,anon,authenticated,service_role;
grant execute on function public.client_switch_activation_source_state_v6(uuid) to authenticated,service_role;
revoke all on function public.request_client_switch_activation_v6(uuid,text) from public,anon,service_role;
grant execute on function public.request_client_switch_activation_v6(uuid,text) to authenticated;
revoke all on function public.decide_client_switch_activation_v6(uuid,uuid,boolean,text) from public,anon,service_role;
grant execute on function public.decide_client_switch_activation_v6(uuid,uuid,boolean,text) to authenticated;
revoke all on function public.guard_client_switch_activation_v6() from public,anon,authenticated,service_role;
revoke all on function public.invalidate_client_switch_activation_v6() from public,anon,authenticated,service_role;
select public.lock_down_definer_functions();
commit;
