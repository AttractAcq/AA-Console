-- Extend exact AAL2 client switch review to daily internal production.
-- The source preview freezes the disabled setup and reviewed organic inputs;
-- current-route and model checks run again before the decision and planning.
begin;
alter table public.client_switch_activation_reviews_v6
 drop constraint client_switch_activation_reviews_v6_switch_key_check;
alter table public.client_switch_activation_reviews_v6
 add constraint client_switch_activation_reviews_v6_switch_key_check check (switch_key in (
  'engine','auto_approve_ideas','auto_approve_briefs','publishing',
  'proof_publishing','campaign_actions','outbound_messaging',
  'lead_magnet_delivery','booking','lead_capture','daily_package'));


create or replace function public.daily_video_sources_current_v1(p_client_id uuid)
returns boolean language plpgsql stable security definer
set search_path=pg_catalog,public as $$
declare
  settings public.client_daily_package_settings%rowtype;
  configured public.client_daily_video_sources_v1%rowtype;
  route public.campaign_route_packages_v6%rowtype;
  campaign public.client_campaigns%rowtype;
  entry jsonb;
  source_record public.client_agent_records%rowtype;
  review record;
begin
  if auth.role() is distinct from 'service_role' and
    (auth.role() is distinct from 'authenticated' or auth.uid() is null
      or not public.can_access_client(p_client_id)) then
    raise exception 'Daily video source check needs client access.' using errcode='42501';
  end if;
  select * into settings from public.client_daily_package_settings
    where client_id=p_client_id;
  select * into configured from public.client_daily_video_sources_v1
    where client_id=p_client_id;
  if settings.client_id is null or configured.client_id is null
    or settings.campaign_id is distinct from configured.campaign_id
    or configured.source_digest is distinct from
      encode(sha256(convert_to(configured.review_snapshot::text,'UTF8')),'hex')
    or cardinality(configured.model_record_ids) is distinct from
      jsonb_array_length(configured.review_snapshot) then
    return false;
  end if;
  select * into route from public.campaign_route_packages_v6
    where id=configured.route_package_id
      and campaign_id=configured.campaign_id and client_id=p_client_id;
  select * into campaign from public.client_campaigns
    where id=configured.campaign_id and client_id=p_client_id;
  if route.id is null or campaign.id is null
    or route.route is distinct from 'organic'
    or campaign.status in ('cancelled','complete')
    or route.plan_fingerprint is distinct from
      public.campaign_plan_fingerprint(campaign)
    or route.version<>(select max(version)
      from public.campaign_route_packages_v6 newer
      where newer.campaign_id=route.campaign_id and newer.route='organic') then
    return false;
  end if;
  for entry in select value from jsonb_array_elements(configured.review_snapshot) loop
    if entry->>'record_id' is null
      or (entry->>'record_id')::uuid<>all(configured.model_record_ids) then
      return false;
    end if;
    select * into source_record from public.client_agent_records
      where id=(entry->>'record_id')::uuid and client_id=p_client_id;
    select * into review from public.model_section_review_state_v7
      where record_id=source_record.id and client_id=p_client_id;
    if source_record.id is null or not found
      or review.review_state is distinct from 'supported'
      or review.review_id::text is distinct from entry->>'review_id'
      or review.record_hash is distinct from entry->>'record_hash' then
      return false;
    end if;
  end loop;
  return true;
end $$;

create or replace function public.client_switch_activation_preview_v6(q public.client_switch_activation_reviews_v6)
returns jsonb language plpgsql stable security definer set search_path=pg_catalog,public as $$
declare b public.client_booking_settings%rowtype; e public.lead_capture_endpoints%rowtype;
 d public.client_daily_package_settings%rowtype; v public.client_daily_video_sources_v1%rowtype;
 s public.client_engine_settings%rowtype; packet jsonb;
begin
 if q.switch_key='daily_package' then
  select * into d from public.client_daily_package_settings where client_id=q.client_id;
  select * into v from public.client_daily_video_sources_v1 where client_id=q.client_id;
  if d.client_id is null or v.client_id is null then return null; end if;
  return jsonb_build_object('client_id',q.client_id,'switch_key','daily_package',
   'action','enable','scope','daily internal production for this client until manually disabled',
   'request_token',q.request_token,
   'settings',to_jsonb(d)-'updated_at',
   'video_sources',to_jsonb(v)-'configured_at',
   'legacy_engine_enabled',coalesce((select enabled from public.client_engine_settings
      where client_id=q.client_id),false),
   'sources_current',public.daily_video_sources_current_v1(q.client_id),
   'consequence','Start a daily four-asset internal production package using the reviewed organic route and model sources',
   'external_action_note','Publication still requires its own exact asset and post approval, provider preflight and receipt');
 end if;
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

create or replace function public.client_switch_activation_source_state_v6(p_request_id uuid)
returns text language plpgsql stable security definer set search_path=pg_catalog,public as $$
declare r public.approval_requests_v6%rowtype; q public.client_switch_activation_reviews_v6%rowtype;
 s public.client_engine_settings%rowtype; b public.client_booking_settings%rowtype;
 e public.lead_capture_endpoints%rowtype; daily_settings public.client_daily_package_settings%rowtype;
 h text; col text; target_on boolean;
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
 if q.switch_key='daily_package' then
  select * into daily_settings from public.client_daily_package_settings where client_id=q.client_id;
  if daily_settings.client_id is null then return 'cancelled'; end if;
  if not public.daily_video_sources_current_v1(q.client_id)
   or exists(select 1 from public.client_engine_settings x
     where x.client_id=q.client_id and x.enabled) then return 'source_held'; end if;
  target_on:=daily_settings.enabled;
 elsif q.switch_key='booking' then
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

create or replace function public.request_client_activation_target_v6(p_client_id uuid,p_switch_key text,p_target_id uuid)
returns uuid language plpgsql volatile security definer set search_path=pg_catalog,public set timezone='UTC' as $$
declare q public.client_switch_activation_reviews_v6%rowtype; h text;
 s public.client_engine_settings%rowtype; b public.client_booking_settings%rowtype;
 e public.lead_capture_endpoints%rowtype; d public.client_daily_package_settings%rowtype;
begin
 if auth.role()<>'authenticated' or auth.uid() is null or public.current_role_of() is null
  or not coalesce(public.is_admin(),false) then
  raise exception 'A provisioned admin must request switch activation.' using errcode='42501'; end if;
 if p_client_id is null or not exists(select 1 from public.clients c where c.id=p_client_id)
  then raise exception 'Unknown client.' using errcode='22023'; end if;
 if p_switch_key='daily_package' and p_target_id is null then
  select * into d from public.client_daily_package_settings
    where client_id=p_client_id for update;
  if d.client_id is null or d.enabled
   or not public.daily_video_sources_current_v1(p_client_id)
   or exists(select 1 from public.client_engine_settings x
      where x.client_id=p_client_id and x.enabled) then
   raise exception 'Configure current daily sources, switch off legacy Engine and leave daily production off.' using errcode='23514'; end if;
 elsif p_switch_key='booking' and p_target_id is null then
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


create function public.set_daily_package_enabled_v1(p_client_id uuid,p_enabled boolean)
returns public.client_daily_package_settings language plpgsql volatile security definer
set search_path=pg_catalog,public as $$
declare d public.client_daily_package_settings%rowtype;
begin
 if auth.role() is distinct from 'authenticated' or auth.uid() is null
  or not coalesce(public.is_human_admin(),false)
  or not public.can_access_client(p_client_id) then
  raise exception 'A provisioned human admin must change daily production.' using errcode='42501'; end if;
 select * into d from public.client_daily_package_settings
  where client_id=p_client_id for update;
 if d.client_id is null then raise exception 'Set up daily production first.' using errcode='23514'; end if;
 if p_enabled and (not public.daily_video_sources_current_v1(p_client_id)
  or exists(select 1 from public.client_engine_settings x
    where x.client_id=p_client_id and x.enabled)) then
  raise exception 'Daily sources must be current and legacy Engine off.' using errcode='23514'; end if;
 update public.client_daily_package_settings
  set enabled=p_enabled,updated_at=now() where client_id=p_client_id returning * into d;
 return d;
end $$;



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
 if q.switch_key='daily_package' then
  perform 1 from public.client_daily_package_settings where client_id=q.client_id for update;
 elsif q.switch_key='booking' then
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
   when 'daily_package' then perform public.set_daily_package_enabled_v1(q.client_id,true);
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

create function public.guard_daily_package_activation_v1()
returns trigger language plpgsql security definer set search_path=pg_catalog,public as $$
declare rid uuid; q public.client_switch_activation_reviews_v6%rowtype;
 e public.approval_decision_events_v6%rowtype;
begin
 if new.enabled is not true or (tg_op='UPDATE' and old.enabled is true) then return new; end if;
 if nullif(current_setting('aa.activation_review_id',true),'') is null
  or current_setting('aa.activation_review_id',true)
    !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
  raise exception 'Enable daily production through its exact Approval Inbox decision.' using errcode='42501'; end if;
 rid:=current_setting('aa.activation_review_id',true)::uuid;
 select * into q from public.client_switch_activation_reviews_v6
  where canonical_request_id=rid and client_id=new.client_id
   and switch_key='daily_package' and target_id is null;
 select * into e from public.approval_decision_events_v6
  where request_id=rid order by event_order desc limit 1;
 if q.id is null or q.applied_at is not null or e.decision<>'approved'
  or e.actor_aal<>'aal2' or e.actor_id is distinct from auth.uid()
  or e.artifact_hash is distinct from q.source_hash
  or public.client_switch_activation_source_state_v6(rid)<>'pending' then
  raise exception 'The daily production approval is missing or stale.' using errcode='42501'; end if;
 return new;
end $$;
create trigger daily_package_activation_guard_v1
 before insert or update on public.client_daily_package_settings
 for each row execute function public.guard_daily_package_activation_v1();

create function public.guard_daily_package_live_shape_v1()
returns trigger language plpgsql security definer set search_path=pg_catalog,public as $$
begin
 if tg_op='UPDATE' and old.enabled and new.enabled and
  (new.campaign_id,new.pillar_id,new.platform,new.story_media_type,new.approval_cutoff)
  is distinct from
  (old.campaign_id,old.pillar_id,old.platform,old.story_media_type,old.approval_cutoff) then
  raise exception 'Switch daily production off before changing its approved inputs.' using errcode='42501'; end if;
 return new;
end $$;
create trigger daily_package_live_shape_guard_v1
 before update on public.client_daily_package_settings
 for each row execute function public.guard_daily_package_live_shape_v1();

create function public.invalidate_daily_package_activation_v1()
returns trigger language plpgsql security definer set search_path=pg_catalog,public as $$
begin
 if (to_jsonb(new)-array['updated_at','enabled']) is distinct from
  (to_jsonb(old)-array['updated_at','enabled']) then
  update public.client_switch_activation_reviews_v6 set request_token=gen_random_uuid()
   where client_id=new.client_id and switch_key='daily_package' and applied_at is null
    and canonical_request_id::text is distinct from nullif(current_setting('aa.activation_review_id',true),'');
 end if;
 return new;
end $$;
create trigger daily_package_activation_invalidation_v1
 after update on public.client_daily_package_settings
 for each row execute function public.invalidate_daily_package_activation_v1();

create function public.invalidate_daily_video_source_activation_v1()
returns trigger language plpgsql security definer set search_path=pg_catalog,public as $$
begin
 update public.client_switch_activation_reviews_v6 set request_token=gen_random_uuid()
  where client_id=case when tg_op='DELETE' then old.client_id else new.client_id end
   and switch_key='daily_package' and applied_at is null;
 if tg_op='DELETE' then return old; end if;
 return new;
end $$;
create trigger daily_video_source_activation_invalidation_v1
 after insert or update or delete on public.client_daily_video_sources_v1
 for each row execute function public.invalidate_daily_video_source_activation_v1();

create function public.guard_daily_video_source_live_v1()
returns trigger language plpgsql security definer set search_path=pg_catalog,public as $$
declare cid uuid;
begin
 cid:=case when tg_op='DELETE' then old.client_id else new.client_id end;
 if exists(select 1 from public.client_daily_package_settings d
   where d.client_id=cid and d.enabled) then
  raise exception 'Switch daily production off before changing approved video sources.' using errcode='42501'; end if;
 if tg_op='DELETE' then return old; end if;
 return new;
end $$;
create trigger daily_video_source_live_guard_v1
 before insert or update or delete on public.client_daily_video_sources_v1
 for each row execute function public.guard_daily_video_source_live_v1();

create function public.guard_daily_legacy_engine_exclusion_v1()
returns trigger language plpgsql security definer set search_path=pg_catalog,public as $$
begin
 if new.enabled and exists(select 1 from public.client_daily_package_settings d
   where d.client_id=new.client_id and d.enabled) then
  raise exception 'Switch daily production off before enabling the legacy content engine.' using errcode='23514'; end if;
 return new;
end $$;
create trigger daily_legacy_engine_exclusion_v1
 before insert or update on public.client_engine_settings
 for each row execute function public.guard_daily_legacy_engine_exclusion_v1();

create or replace function public.client_control_activity_v6(p_client_id uuid)
returns jsonb
language plpgsql stable security definer
set search_path = ''
as $$
declare v_result jsonb;
begin
  if p_client_id is null or public.can_access_client(p_client_id) is not true then
    raise exception 'Not permitted for this client' using errcode = '42501';
  end if;

  with activity as materialized (
    select 'engine'::text as control_key, s.created_at as run_at,
      s.stage::text as status, s.id::text as source_id,
      null::timestamptz as receipt_at, null::text as external_ref,
      null::text as external_url
    from public.content_slots s where s.client_id = p_client_id
    union all
    select case d.kind when 'idea_selected' then 'auto_approve_ideas'
      else 'auto_approve_briefs' end, d.decided_at, d.kind, d.id::text,
      null::timestamptz, null::text, null::text
    from public.engine_decisions d where d.client_id = p_client_id
    union all
    select 'publishing', p.updated_at,
      p.publication_status, p.id::text,
      case when p.published_at is not null
        and (p.external_id is not null or p.external_url is not null)
        then p.published_at end,
      p.external_id, p.external_url
    from public.scheduled_posts p
    where p.client_id = p_client_id and p.publish_attempts > 0
    union all
    select 'proof_publishing', p.updated_at,
      p.status, p.id::text,
      case when p.placed_at is not null
        and (p.external_id is not null or p.external_url is not null)
        then p.placed_at end,
      p.external_id, p.external_url
    from public.proof_placements p
    where p.client_id = p_client_id and p.attempts > 0
    union all
    select 'campaign_actions', e.updated_at,
      e.status, e.id::text,
      case when e.executed_at is not null
        and (e.external_id is not null or e.external_url is not null)
        then e.executed_at end,
      e.external_id, e.external_url
    from public.campaign_action_executions e
    where e.client_id = p_client_id and e.attempts > 0
    union all
    select 'outbound_messaging', m.updated_at,
      m.status, m.id::text,
      case when m.sent_at is not null and m.external_id is not null
        then m.sent_at end,
      m.external_id, null::text
    from public.outbound_messages m
    where m.client_id = p_client_id and m.attempts > 0
    union all
    select 'lead_magnet_delivery', d.updated_at,
      d.status, d.id::text,
      case when d.sent_at is not null and d.provider_ref is not null
        then d.sent_at end,
      d.provider_ref, null::text
    from public.lead_magnet_deliveries d
    where d.client_id = p_client_id and d.attempts > 0
    union all
    select 'daily_package', p.created_at, r.status::text, p.id::text,
      null::timestamptz, null::text, null::text
    from public.daily_packages p
      join public.workflow_runs r on r.id=p.run_id
    where p.client_id=p_client_id
    union all
    select 'booking', a.created_at, a.status, a.id::text,
      null::timestamptz, null::text, null::text
    from public.client_appointments a
    where a.client_id = p_client_id and a.booked_via in ('public_link','sales_agent')
  ), keys(control_key) as (
    values ('engine'), ('auto_approve_ideas'), ('auto_approve_briefs'),
      ('publishing'), ('proof_publishing'), ('campaign_actions'),
      ('outbound_messaging'), ('lead_magnet_delivery'), ('booking'),
      ('daily_package')
  )
  select jsonb_object_agg(k.control_key, jsonb_build_object(
    'lastRun', (
      select jsonb_build_object('at', a.run_at, 'status', a.status,
        'sourceId', a.source_id)
      from activity a where a.control_key = k.control_key
      order by a.run_at desc, a.source_id desc limit 1),
    'lastExternalReceipt', (
      select jsonb_build_object('at', a.receipt_at, 'externalRef', a.external_ref,
        'externalUrl', a.external_url, 'sourceId', a.source_id)
      from activity a where a.control_key = k.control_key
        and a.receipt_at is not null
      order by a.receipt_at desc, a.source_id desc limit 1)
  )) into v_result from keys k;

  return coalesce(v_result, '{}'::jsonb);
end;
$$;

revoke all on function public.daily_video_sources_current_v1(uuid) from public,anon,authenticated,service_role;
grant execute on function public.daily_video_sources_current_v1(uuid) to authenticated,service_role;
revoke all on function public.set_daily_package_enabled_v1(uuid,boolean) from public,anon,service_role;
grant execute on function public.set_daily_package_enabled_v1(uuid,boolean) to authenticated;
revoke all on function public.guard_daily_package_activation_v1() from public,anon,authenticated,service_role;
revoke all on function public.guard_daily_package_live_shape_v1() from public,anon,authenticated,service_role;
revoke all on function public.invalidate_daily_package_activation_v1() from public,anon,authenticated,service_role;
revoke all on function public.invalidate_daily_video_source_activation_v1() from public,anon,authenticated,service_role;
revoke all on function public.guard_daily_video_source_live_v1() from public,anon,authenticated,service_role;
revoke all on function public.guard_daily_legacy_engine_exclusion_v1() from public,anon,authenticated,service_role;
select public.lock_down_definer_functions();
commit;
