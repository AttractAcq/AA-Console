-- The system-wide Engine switch affects every separately enabled client.
-- Its request belongs to the agency Inbox and can only be decided by AAL2 admin.
begin;
create table public.global_engine_activation_reviews_v6 (
 id uuid primary key default gen_random_uuid(),
 request_epoch bigint generated always as identity unique,
 request_token uuid not null default gen_random_uuid(),
 source_hash text not null default repeat('0',64) check(source_hash ~ '^[0-9a-f]{64}$'),
 canonical_request_id uuid unique references public.approval_requests_v6(id),
 applied_at timestamptz,
 applied_by uuid references auth.users(id),
 created_at timestamptz not null default now()
);
alter table public.global_engine_activation_reviews_v6 enable row level security;
revoke all on public.global_engine_activation_reviews_v6 from public,anon,authenticated,service_role;

create function public.global_engine_activation_preview_v6(q public.global_engine_activation_reviews_v6)
returns jsonb language sql stable security definer set search_path=pg_catalog,public as $$
 select jsonb_build_object('action','enable_system_engine',
  'request_token',q.request_token,'global_control',jsonb_build_object(
   'enabled',c.enabled,'note',c.note),
  'client_scope',coalesce((select jsonb_agg(jsonb_build_object(
   'client_id',s.client_id,'client_name',cl.name,
   'auto_approve_ideas',s.auto_approve_ideas,
   'auto_approve_briefs',s.auto_approve_briefs,
   'monthly_cap_usd',b.cap_usd) order by s.client_id)
   from public.client_engine_settings s
   join public.clients cl on cl.id=s.client_id
   left join public.client_engine_budgets b on b.client_id=s.client_id
    and b.month=date_trunc('month',now())::date
   where s.enabled),'[]'::jsonb),
  'consequence','The hourly Engine may plan and spend for every current and future client separately switched on',
  'scope_note','Each client still requires its own exact activation and monthly spend cap')
 from public.engine_controls c where c.id;
$$;
create function public.global_engine_activation_hash_v6(q public.global_engine_activation_reviews_v6)
returns text language sql stable security definer set search_path=pg_catalog,public as $$
 select encode(sha256(convert_to((public.global_engine_activation_preview_v6(q)-'request_token')::text,'UTF8')),'hex');
$$;
create function public.global_engine_activation_scope_v6(q public.global_engine_activation_reviews_v6)
returns jsonb language sql stable security definer set search_path=pg_catalog,public as $$
 select jsonb_build_object('effect','enable_global_content_engine',
  'review_id',q.id,'request_token',q.request_token,
  'content_hash',public.global_engine_activation_hash_v6(q),
  'client_scope','all individually enabled clients until manually disabled');
$$;

create function public.global_engine_activation_source_state_v6(p_request_id uuid)
returns text language plpgsql stable security definer set search_path=pg_catalog,public as $$
declare r public.approval_requests_v6%rowtype; q public.global_engine_activation_reviews_v6%rowtype;
 c public.engine_controls%rowtype; h text;
begin
 select * into r from public.approval_requests_v6 where id=p_request_id;
 if r.id is null or r.client_id is not null or r.source_system<>'aa_console'
  or r.source_kind<>'global_engine_activation'
  or r.source_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  then return 'unverified'; end if;
 if auth.role() is distinct from 'service_role' and
  (auth.role() is distinct from 'authenticated' or not coalesce(public.is_admin(),false))
  then return 'unverified'; end if;
 select * into q from public.global_engine_activation_reviews_v6
  where id=r.source_id::uuid and canonical_request_id=r.id;
 if q.id is null then return 'cancelled'; end if;
 if exists(select 1 from public.global_engine_activation_reviews_v6 n
  where n.request_epoch>q.request_epoch) then return 'superseded'; end if;
 select * into c from public.engine_controls where id;
 if c.id is null then return 'cancelled'; end if;
 if q.applied_at is not null then
  if c.enabled and exists(select 1 from public.approval_decision_events_v6 d
   where d.request_id=r.id and d.decision='approved' and d.actor_aal='aal2'
    and d.actor_id=q.applied_by and d.artifact_hash=q.source_hash
    and r.artifact_hash=q.source_hash) then return 'source_decided'; end if;
  return 'source_held';
 end if;
 h:=public.global_engine_activation_hash_v6(q);
 if h is null or q.source_hash is distinct from h or r.artifact_hash is distinct from h
  or r.source_version is distinct from h||':'||q.request_token::text
  or r.preview is distinct from public.global_engine_activation_preview_v6(q)
  or r.scope is distinct from public.global_engine_activation_scope_v6(q)
  or r.destination is distinct from 'system:content_engine'
  or r.owner_role is distinct from 'admin' then return 'superseded'; end if;
 if c.enabled then return 'source_held'; end if;
 return 'pending';
end $$;

create function public.request_global_engine_activation_v6()
returns uuid language plpgsql volatile security definer set search_path=pg_catalog,public set timezone='UTC' as $$
declare q public.global_engine_activation_reviews_v6%rowtype; c public.engine_controls%rowtype;
 h text;
begin
 if auth.role()<>'authenticated' or auth.uid() is null or public.current_role_of() is null
  or not coalesce(public.is_admin(),false) then
  raise exception 'A provisioned admin must request global Engine activation.' using errcode='42501'; end if;
 select * into c from public.engine_controls where id for update;
 if c.id is null or c.enabled then
  raise exception 'The system Engine must be present and off before requesting activation.' using errcode='23514'; end if;
 select * into q from public.global_engine_activation_reviews_v6 order by request_epoch desc limit 1;
 if q.id is not null and q.source_hash=public.global_engine_activation_hash_v6(q)
  and public.global_engine_activation_source_state_v6(q.canonical_request_id)='pending'
  and exists(select 1 from public.approval_inbox_v6 x
   where x.id=q.canonical_request_id and x.status='pending')
  then return q.canonical_request_id; end if;
 insert into public.global_engine_activation_reviews_v6 default values returning * into q;
 h:=public.global_engine_activation_hash_v6(q);
 update public.global_engine_activation_reviews_v6 set source_hash=h where id=q.id returning * into q;
 q.canonical_request_id:=public.register_approval_request_v6(jsonb_build_object(
  'source_system','aa_console','source_kind','global_engine_activation',
  'source_id',q.id::text,'source_version',h||':'||q.request_token::text,
  'title','Enable the system-wide content Engine',
  'artifact_hash',h,'preview',public.global_engine_activation_preview_v6(q),
  'destination','system:content_engine','scope',public.global_engine_activation_scope_v6(q),
  'owner_role','admin','requested_by',auth.uid(),'requester_kind','human',
  'expires_at',now()+interval '1 day','owning_path','/approvals'));
 update public.global_engine_activation_reviews_v6 set canonical_request_id=q.canonical_request_id where id=q.id;
 return q.canonical_request_id;
end $$;

create function public.guard_global_engine_activation_v6()
returns trigger language plpgsql security definer set search_path=pg_catalog,public as $$
declare rid uuid; q public.global_engine_activation_reviews_v6%rowtype;
 d public.approval_decision_events_v6%rowtype;
begin
 if new.enabled is not true or (tg_op='UPDATE' and old.enabled is true) then return new; end if;
 if nullif(current_setting('aa.global_engine_review_id',true),'') is null
  or current_setting('aa.global_engine_review_id',true)
   !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  then raise exception 'Enable the system Engine through its agency Approval Inbox decision.' using errcode='42501'; end if;
 rid:=current_setting('aa.global_engine_review_id',true)::uuid;
 select * into q from public.global_engine_activation_reviews_v6
  where canonical_request_id=rid;
 select * into d from public.approval_decision_events_v6
  where request_id=rid order by event_order desc limit 1;
 if q.id is null or q.applied_at is not null or d.decision<>'approved'
  or d.actor_aal<>'aal2' or d.actor_id is distinct from auth.uid()
  or d.artifact_hash is distinct from q.source_hash
  or public.global_engine_activation_source_state_v6(rid)<>'pending' then
  raise exception 'The global Engine activation review is missing or stale.' using errcode='42501'; end if;
 return new;
end $$;
create trigger global_engine_activation_guard_v6 before update on public.engine_controls
 for each row execute function public.guard_global_engine_activation_v6();

create function public.invalidate_global_engine_activation_v6()
returns trigger language plpgsql security definer set search_path=pg_catalog,public as $$
begin
 update public.global_engine_activation_reviews_v6 set request_token=gen_random_uuid()
  where applied_at is null and canonical_request_id::text is distinct from
   nullif(current_setting('aa.global_engine_review_id',true),'');
 if tg_op='DELETE' then return old; end if;
 return new;
end $$;
create trigger global_engine_control_invalidation_v6 after update on public.engine_controls
 for each row execute function public.invalidate_global_engine_activation_v6();
create trigger global_engine_client_invalidation_v6
 after insert or update or delete on public.client_engine_settings
 for each row execute function public.invalidate_global_engine_activation_v6();
create trigger global_engine_budget_invalidation_v6
 after insert or update or delete on public.client_engine_budgets
 for each row execute function public.invalidate_global_engine_activation_v6();

create function public.decide_global_engine_activation_v6(p_review_id uuid,p_request_id uuid,
 p_approved boolean,p_reason text default null)
returns uuid language plpgsql volatile security definer set search_path=pg_catalog,public set timezone='UTC' as $$
declare q public.global_engine_activation_reviews_v6%rowtype; h text;
begin
 if auth.role()<>'authenticated' or auth.uid() is null or public.current_role_of() is null
  or not coalesce(public.is_admin(),false) or coalesce(auth.jwt()->>'aal','')<>'aal2' then
  raise exception 'A provisioned AAL2 admin must decide global Engine activation.' using errcode='42501'; end if;
 select * into q from public.global_engine_activation_reviews_v6 where id=p_review_id for update;
 if q.id is null or q.canonical_request_id is distinct from p_request_id then
  raise exception 'Global Engine review is unavailable.' using errcode='23514'; end if;
 perform 1 from public.engine_controls where id for update;
 h:=public.global_engine_activation_hash_v6(q);
 if public.global_engine_activation_source_state_v6(p_request_id)<>'pending'
  or not exists(select 1 from public.approval_inbox_v6 x
   where x.id=p_request_id and x.status='pending' and x.preview_blocker is null) then
  raise exception 'Review the current global Engine activation in Approval Inbox.' using errcode='23514'; end if;
 if not p_approved and nullif(btrim(coalesce(p_reason,'')),'') is null then
  raise exception 'A rejection reason is required.' using errcode='22023'; end if;
 perform public.record_approval_decision_v6(p_request_id,
  case when p_approved then 'approved' else 'rejected' end,h,
  'global_engine_activation:'||q.id::text||':'||q.request_token::text,p_reason);
 if p_approved then
  perform set_config('aa.global_engine_review_id',p_request_id::text,true);
  perform public.set_engine_running(true,'Enabled from exact agency Approval Inbox review '||p_request_id::text);
  update public.global_engine_activation_reviews_v6 set applied_at=now(),applied_by=auth.uid()
   where id=q.id;
  perform set_config('aa.global_engine_review_id','',true);
 end if;
 return q.id;
end $$;

revoke all on function public.global_engine_activation_preview_v6(public.global_engine_activation_reviews_v6) from public,anon,authenticated,service_role;
revoke all on function public.global_engine_activation_hash_v6(public.global_engine_activation_reviews_v6) from public,anon,authenticated,service_role;
revoke all on function public.global_engine_activation_scope_v6(public.global_engine_activation_reviews_v6) from public,anon,authenticated,service_role;
revoke all on function public.global_engine_activation_source_state_v6(uuid) from public,anon,authenticated,service_role;
grant execute on function public.global_engine_activation_source_state_v6(uuid) to authenticated,service_role;
revoke all on function public.request_global_engine_activation_v6() from public,anon,service_role;
grant execute on function public.request_global_engine_activation_v6() to authenticated;
revoke all on function public.decide_global_engine_activation_v6(uuid,uuid,boolean,text) from public,anon,service_role;
grant execute on function public.decide_global_engine_activation_v6(uuid,uuid,boolean,text) to authenticated;
revoke all on function public.guard_global_engine_activation_v6() from public,anon,authenticated,service_role;
revoke all on function public.invalidate_global_engine_activation_v6() from public,anon,authenticated,service_role;
select public.lock_down_definer_functions();
commit;
