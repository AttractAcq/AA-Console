-- Extend the client activation decision to booking and individual intake doors.
-- The original setters retain their hours, ownership and endpoint checks.
begin;
alter table public.client_switch_activation_reviews_v6
 add column target_id uuid;
alter table public.client_switch_activation_reviews_v6
 drop constraint client_switch_activation_reviews_v6_switch_key_check;
alter table public.client_switch_activation_reviews_v6
 add constraint client_switch_activation_reviews_v6_switch_key_check check (switch_key in (
  'engine','auto_approve_ideas','auto_approve_briefs','publishing',
  'proof_publishing','campaign_actions','outbound_messaging',
  'lead_magnet_delivery','booking','lead_capture')),
 add constraint client_switch_activation_target_v6 check (
  (switch_key='lead_capture' and target_id is not null)
  or (switch_key<>'lead_capture' and target_id is null));
create index client_switch_target_review_latest_v6
 on public.client_switch_activation_reviews_v6(target_id,request_epoch desc)
 where target_id is not null;

create or replace function public.client_switch_activation_preview_v6(q public.client_switch_activation_reviews_v6)
returns jsonb language plpgsql stable security definer set search_path=pg_catalog,public as $$
declare b public.client_booking_settings%rowtype; e public.lead_capture_endpoints%rowtype;
 s public.client_engine_settings%rowtype; packet jsonb;
begin
 if q.switch_key='booking' then
  select * into b from public.client_booking_settings where client_id=q.client_id;
  if b.client_id is null then return null; end if;
  select jsonb_build_object('client_id',q.client_id,'switch_key','booking',
   'action','enable','scope','booking for this client until manually disabled',
   'request_token',q.request_token,'settings',to_jsonb(b)-array['created_at','updated_at'],
   'windows',coalesce((select jsonb_agg(jsonb_build_object(
    'day_of_week',w.day_of_week,'starts_at_minute',w.starts_at_minute,
    'ends_at_minute',w.ends_at_minute) order by w.day_of_week,w.starts_at_minute,w.id)
    from public.client_booking_windows w where w.client_id=q.client_id),'[]'::jsonb),
   'consequence','Permit prospects to book available slots under these exact rules and hours')
   into packet;
  return packet;
 end if;
 if q.switch_key='lead_capture' then
  select * into e from public.lead_capture_endpoints
   where id=q.target_id and client_id=q.client_id;
  if e.id is null then return null; end if;
  return jsonb_build_object('client_id',q.client_id,'switch_key','lead_capture',
   'action','enable','scope','one lead-capture endpoint until expiry or manual disable',
   'request_token',q.request_token,'target_id',e.id,
   'endpoint',jsonb_build_object('id',e.id,'client_id',e.client_id,
    'purpose',e.purpose,'token_hash',e.token_hash,'campaign_id',e.campaign_id,
    'page_id',e.page_id,'source_channel',e.source_channel,
    'consent_wording',e.consent_wording,'expires_at',e.expires_at,
    'max_submissions',e.max_submissions,'submissions',e.submissions,
    'revoked_at',e.revoked_at,'magnet_version_id',e.magnet_version_id,
    'enabled',e.enabled),
   'consequence','Permit a public lead intake with the stated consent wording and source');
 end if;
 select * into s from public.client_engine_settings where client_id=q.client_id;
 if s.client_id is null then return null; end if;
 return jsonb_build_object(
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
  'external_action_note','Each external action still requires its own exact approval, provider preflight and receipt');
end $$;

create or replace function public.client_switch_activation_scope_v6(q public.client_switch_activation_reviews_v6)
returns jsonb language sql stable security definer set search_path=pg_catalog,public as $$
 select jsonb_build_object('client_id',q.client_id,'switch_key',q.switch_key,
  'review_id',q.id,'request_token',q.request_token,
  'content_hash',public.client_switch_activation_hash_v6(q),
  'effect','enable_client_automation_switch') ||
  case when q.target_id is null then '{}'::jsonb
   else jsonb_build_object('target_id',q.target_id) end;
$$;

create or replace function public.client_switch_activation_source_state_v6(p_request_id uuid)
returns text language plpgsql stable security definer set search_path=pg_catalog,public as $$
declare r public.approval_requests_v6%rowtype; q public.client_switch_activation_reviews_v6%rowtype;
 s public.client_engine_settings%rowtype; b public.client_booking_settings%rowtype;
 e public.lead_capture_endpoints%rowtype; h text; col text; target_on boolean;
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
  where n.client_id=q.client_id and n.switch_key=q.switch_key
   and n.target_id is not distinct from q.target_id and n.request_epoch>q.request_epoch)
  then return 'superseded'; end if;
 if q.switch_key='booking' then
  select * into b from public.client_booking_settings where client_id=q.client_id;
  if b.client_id is null then return 'cancelled'; end if;
  target_on:=b.enabled;
 elsif q.switch_key='lead_capture' then
  select * into e from public.lead_capture_endpoints
   where id=q.target_id and client_id=q.client_id;
  if e.id is null then return 'cancelled'; end if;
  if e.revoked_at is not null or e.expires_at<=now()
   or e.submissions>=e.max_submissions or nullif(btrim(e.consent_wording),'') is null
   then return 'source_held'; end if;
  target_on:=e.enabled;
 else
  col:=public.client_switch_column_v6(q.switch_key);
  select * into s from public.client_engine_settings where client_id=q.client_id;
  if s.client_id is null or col is null then return 'cancelled'; end if;
  target_on:=(to_jsonb(s)->>col)::boolean;
 end if;
 if q.applied_at is not null then
  if target_on is true and exists(
   select 1 from public.approval_decision_events_v6 d where d.request_id=r.id
    and d.decision='approved' and d.actor_aal='aal2' and d.actor_id=q.applied_by
    and d.artifact_hash=q.source_hash and r.artifact_hash=q.source_hash)
   then return 'source_decided'; end if;
  return 'source_held';
 end if;
 h:=public.client_switch_activation_hash_v6(q);
 if h is null or q.source_hash is distinct from h or r.artifact_hash is distinct from h
  or r.source_version is distinct from h||':'||q.request_token::text
  or r.preview is distinct from public.client_switch_activation_preview_v6(q)
  or r.scope is distinct from public.client_switch_activation_scope_v6(q)
  or r.destination is distinct from ('client:automation:'||q.client_id::text||':'||q.switch_key||
   case when q.target_id is null then '' else ':'||q.target_id::text end)
  or r.owner_role is distinct from 'admin'
  then return 'superseded'; end if;
 if target_on is true then return 'source_held'; end if;
 return 'pending';
end $$;

create function public.request_client_activation_target_v6(p_client_id uuid,p_switch_key text,p_target_id uuid)
returns uuid language plpgsql volatile security definer set search_path=pg_catalog,public set timezone='UTC' as $$
declare q public.client_switch_activation_reviews_v6%rowtype; h text;
 s public.client_engine_settings%rowtype; b public.client_booking_settings%rowtype;
 e public.lead_capture_endpoints%rowtype;
begin
 if auth.role()<>'authenticated' or auth.uid() is null or public.current_role_of() is null
  or not coalesce(public.is_admin(),false) then
  raise exception 'A provisioned admin must request switch activation.' using errcode='42501'; end if;
 if p_client_id is null or not exists(select 1 from public.clients c where c.id=p_client_id)
  then raise exception 'Unknown client.' using errcode='22023'; end if;
 if p_switch_key='booking' and p_target_id is null then
  select * into b from public.client_booking_settings where client_id=p_client_id for update;
  if b.client_id is null or b.enabled then
   raise exception 'Configure and disable booking before requesting activation.' using errcode='23514'; end if;
 elsif p_switch_key='lead_capture' and p_target_id is not null then
  select * into e from public.lead_capture_endpoints
   where id=p_target_id and client_id=p_client_id for update;
  if e.id is null or e.enabled or e.revoked_at is not null or e.expires_at<=now()
   or e.submissions>=e.max_submissions or nullif(btrim(e.consent_wording),'') is null then
   raise exception 'A current disabled intake endpoint with consent is required.' using errcode='23514'; end if;
 elsif public.client_switch_column_v6(p_switch_key) is not null and p_target_id is null then
  select * into s from public.client_engine_settings where client_id=p_client_id for update;
  if s.client_id is null or (to_jsonb(s)->>public.client_switch_column_v6(p_switch_key))::boolean is true then
   raise exception 'Configure and disable this client switch first.' using errcode='23514'; end if;
 else raise exception 'Unknown activation target.' using errcode='22023'; end if;
 select * into q from public.client_switch_activation_reviews_v6
  where client_id=p_client_id and switch_key=p_switch_key
   and target_id is not distinct from p_target_id order by request_epoch desc limit 1;
 if q.id is not null and q.source_hash=public.client_switch_activation_hash_v6(q)
  and public.client_switch_activation_source_state_v6(q.canonical_request_id)='pending'
  and exists(select 1 from public.approval_inbox_v6 x where x.id=q.canonical_request_id and x.status='pending')
  then return q.canonical_request_id; end if;
 insert into public.client_switch_activation_reviews_v6(client_id,switch_key,target_id)
  values(p_client_id,p_switch_key,p_target_id) returning * into q;
 h:=public.client_switch_activation_hash_v6(q);
 update public.client_switch_activation_reviews_v6 set source_hash=h where id=q.id returning * into q;
 q.canonical_request_id:=public.register_approval_request_v6(jsonb_build_object(
  'client_id',p_client_id,'source_system','aa_console','source_kind','activation_switch',
  'source_id',q.id::text,'source_version',h||':'||q.request_token::text,
  'title','Enable client automation: '||replace(p_switch_key,'_',' '),
  'artifact_hash',h,'preview',public.client_switch_activation_preview_v6(q),
  'destination','client:automation:'||p_client_id::text||':'||p_switch_key||
   case when p_target_id is null then '' else ':'||p_target_id::text end,
  'scope',public.client_switch_activation_scope_v6(q),'owner_role','admin',
  'requested_by',auth.uid(),'requester_kind','human','expires_at',now()+interval '1 day',
  'owning_path','/clients/'||p_client_id::text||'/delivery/approval-inbox?tab=unified'));
 update public.client_switch_activation_reviews_v6 set canonical_request_id=q.canonical_request_id where id=q.id;
 return q.canonical_request_id;
end $$;

create or replace function public.request_client_switch_activation_v6(p_client_id uuid,p_switch_key text)
returns uuid language sql volatile security definer set search_path=pg_catalog,public as $$
 select public.request_client_activation_target_v6(p_client_id,p_switch_key,null);
$$;
create function public.request_lead_capture_activation_v6(p_endpoint_id uuid)
returns uuid language plpgsql volatile security definer set search_path=pg_catalog,public as $$
declare e public.lead_capture_endpoints%rowtype;
begin
 select * into e from public.lead_capture_endpoints where id=p_endpoint_id;
 if e.id is null then raise exception 'No such intake endpoint.' using errcode='23514'; end if;
 return public.request_client_activation_target_v6(e.client_id,'lead_capture',e.id);
end $$;

create function public.guard_client_aux_activation_v6()
returns trigger language plpgsql security definer set search_path=pg_catalog,public as $$
declare k text; cid uuid; tid uuid; rid uuid;
 q public.client_switch_activation_reviews_v6%rowtype;
 d public.approval_decision_events_v6%rowtype;
begin
 if new.enabled is not true or (tg_op='UPDATE' and old.enabled is true) then return new; end if;
 if tg_table_name='client_booking_settings' then
  k:='booking'; cid:=new.client_id; tid:=null;
 else k:='lead_capture'; cid:=new.client_id; tid:=new.id; end if;
 if nullif(current_setting('aa.activation_review_id',true),'') is null
  or current_setting('aa.activation_review_id',true)
   !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  then raise exception 'Enable this target through its exact Approval Inbox decision.' using errcode='42501'; end if;
 rid:=current_setting('aa.activation_review_id',true)::uuid;
 select * into q from public.client_switch_activation_reviews_v6
  where canonical_request_id=rid and client_id=cid and switch_key=k
   and target_id is not distinct from tid;
 select * into d from public.approval_decision_events_v6
  where request_id=rid order by event_order desc limit 1;
 if q.id is null or q.applied_at is not null or d.decision<>'approved'
  or d.actor_aal<>'aal2' or d.actor_id is distinct from auth.uid()
  or d.artifact_hash is distinct from q.source_hash
  or public.client_switch_activation_source_state_v6(rid)<>'pending'
  then raise exception 'The booking or intake activation review is missing or stale.' using errcode='42501'; end if;
 return new;
end $$;
create trigger client_booking_activation_guard_v6
 before insert or update on public.client_booking_settings
 for each row execute function public.guard_client_aux_activation_v6();
create trigger lead_capture_activation_guard_v6
 before insert or update on public.lead_capture_endpoints
 for each row execute function public.guard_client_aux_activation_v6();

create function public.invalidate_client_aux_activation_v6()
returns trigger language plpgsql security definer set search_path=pg_catalog,public as $$
declare k text; cid uuid; tid uuid;
begin
 if tg_table_name='client_booking_windows' then
  cid:=case when tg_op='DELETE' then old.client_id else new.client_id end;
  update public.client_switch_activation_reviews_v6 set request_token=gen_random_uuid()
   where client_id=cid and switch_key='booking' and applied_at is null;
  if tg_op='DELETE' then return old; end if;
  return new;
 end if;
 if tg_table_name='client_booking_settings' then
  k:='booking'; cid:=new.client_id; tid:=null;
 else k:='lead_capture'; cid:=new.client_id; tid:=new.id; end if;
 if (to_jsonb(new)-array['updated_at','created_at']) is distinct from
  (to_jsonb(old)-array['updated_at','created_at']) then
  update public.client_switch_activation_reviews_v6 set request_token=gen_random_uuid()
   where client_id=cid and switch_key=k and target_id is not distinct from tid
    and applied_at is null
    and canonical_request_id::text is distinct from nullif(current_setting('aa.activation_review_id',true),'');
 end if;
 return new;
end $$;
create trigger client_booking_activation_invalidation_v6
 after update on public.client_booking_settings
 for each row execute function public.invalidate_client_aux_activation_v6();
create trigger lead_capture_activation_invalidation_v6
 after update on public.lead_capture_endpoints
 for each row execute function public.invalidate_client_aux_activation_v6();
create trigger client_booking_windows_invalidation_v6
 after insert or update or delete on public.client_booking_windows
 for each row execute function public.invalidate_client_aux_activation_v6();

-- Once an intake door or booking schedule is live, edits to the approved
-- exposure require switching it off and requesting a fresh activation.
create function public.guard_live_aux_activation_shape_v6()
returns trigger language plpgsql security definer set search_path=pg_catalog,public as $$
declare cid uuid;
begin
 if tg_table_name='client_booking_windows' then
  cid:=case when tg_op='DELETE' then old.client_id else new.client_id end;
  if public.booking_enabled_for_client_v6(cid) then
   raise exception 'Switch booking off before changing its approved hours.' using errcode='42501'; end if;
  if tg_op='DELETE' then return old; end if;
  return new;
 end if;
 if tg_table_name='client_booking_settings' then
  if tg_op='UPDATE' and old.enabled and new.enabled and
   (new.timezone,new.slot_minutes,new.buffer_minutes,new.min_notice_hours,
    new.max_days_ahead,new.max_per_day) is distinct from
   (old.timezone,old.slot_minutes,old.buffer_minutes,old.min_notice_hours,
    old.max_days_ahead,old.max_per_day) then
   raise exception 'Switch booking off before changing its approved rules.' using errcode='42501'; end if;
 else
  if tg_op='UPDATE' and old.enabled and new.enabled and
   (new.purpose,new.token_hash,new.campaign_id,new.page_id,new.source_channel,
    new.consent_wording,new.expires_at,new.max_submissions,new.magnet_version_id) is distinct from
   (old.purpose,old.token_hash,old.campaign_id,old.page_id,old.source_channel,
    old.consent_wording,old.expires_at,old.max_submissions,old.magnet_version_id) then
   raise exception 'Switch intake off before changing its approved source or consent.' using errcode='42501'; end if;
 end if;
 return new;
end $$;
create trigger client_booking_live_shape_guard_v6
 before update on public.client_booking_settings
 for each row execute function public.guard_live_aux_activation_shape_v6();
create trigger client_booking_windows_live_shape_guard_v6
 before insert or update or delete on public.client_booking_windows
 for each row execute function public.guard_live_aux_activation_shape_v6();
create trigger lead_capture_live_shape_guard_v6
 before update on public.lead_capture_endpoints
 for each row execute function public.guard_live_aux_activation_shape_v6();

create or replace function public.decide_client_switch_activation_v6(p_review_id uuid,p_request_id uuid,
 p_approved boolean,p_reason text default null)
returns uuid language plpgsql volatile security definer set search_path=pg_catalog,public set timezone='UTC' as $$
declare q public.client_switch_activation_reviews_v6%rowtype; h text;
begin
 if auth.role()<>'authenticated' or auth.uid() is null or public.current_role_of() is null
  or not coalesce(public.is_admin(),false) or coalesce(auth.jwt()->>'aal','')<>'aal2' then
  raise exception 'A provisioned AAL2 admin must decide switch activation.' using errcode='42501'; end if;
 select * into q from public.client_switch_activation_reviews_v6 where id=p_review_id for update;
 if q.id is null or q.canonical_request_id is distinct from p_request_id then
  raise exception 'Activation review is unavailable.' using errcode='23514'; end if;
 if q.switch_key='booking' then
  perform 1 from public.client_booking_settings where client_id=q.client_id for update;
 elsif q.switch_key='lead_capture' then
  perform 1 from public.lead_capture_endpoints where id=q.target_id and client_id=q.client_id for update;
 else
  perform 1 from public.client_engine_settings where client_id=q.client_id for update;
 end if;
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
   when 'booking' then perform public.set_client_booking_enabled_v6(q.client_id,true);
   when 'lead_capture' then perform public.set_lead_capture_enabled_v6(q.target_id,true);
   else raise exception 'Unsupported client switch.' using errcode='22023';
  end case;
  update public.client_switch_activation_reviews_v6 set applied_at=now(),applied_by=auth.uid()
   where id=q.id;
  perform set_config('aa.activation_review_id','',true);
 end if;
 return q.id;
end $$;

revoke all on function public.request_client_activation_target_v6(uuid,text,uuid) from public,anon,authenticated,service_role;
revoke all on function public.request_lead_capture_activation_v6(uuid) from public,anon,service_role;
grant execute on function public.request_lead_capture_activation_v6(uuid) to authenticated;
revoke all on function public.guard_client_aux_activation_v6() from public,anon,authenticated,service_role;
revoke all on function public.invalidate_client_aux_activation_v6() from public,anon,authenticated,service_role;
revoke all on function public.guard_live_aux_activation_shape_v6() from public,anon,authenticated,service_role;
select public.lock_down_definer_functions();
commit;
