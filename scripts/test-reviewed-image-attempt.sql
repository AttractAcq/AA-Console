-- Rollback-only test of one authorized dispatch and its separate settlement.
begin;
insert into auth.users(id,instance_id,aud,role,email,encrypted_password,created_at,updated_at)
values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','00000000-0000-0000-0000-000000000000',
  'authenticated','authenticated','proof-admin@example.invalid','',now(),now());
insert into public.profiles(id,role,email) values
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','admin','proof-admin@example.invalid');
insert into public.clients(id,name,initials) values
  ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','Proof rights fixture','PR');
select set_config('request.jwt.claim.sub','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',true);
select set_config('request.jwt.claim.role','authenticated',true);
select set_config('request.jwt.claims',
  '{"sub":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","role":"authenticated","aal":"aal1"}',true);
insert into public.client_proof_assets(client_id,media_type,title,body,source)
  values ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','text','Excluded fixture','Fixture','QA') returning id as proof_id \gset
insert into public.client_briefs(id,client_id,title,media_type,content_format,argument,script,visual_direction,excluded_artwork_proof_id)
  values ('dddddddd-dddd-4ddd-8ddd-dddddddddddd','bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','Independent image',
    'image','single','a','b','Fictional scene',:'proof_id');
insert into public.client_engine_budgets(client_id,month,cap_usd)
  select client_id,date_trunc('month',now() at time zone 'UTC')::date,1 from public.client_briefs where id='dddddddd-dddd-4ddd-8ddd-dddddddddddd';
insert into agent_budget_private.caps(client_id,month)
  select client_id,month from public.client_engine_budgets where client_id='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
insert into agent_budget_private.image_permits(brief_id,client_id,budget_month,reviewed_sha256)
  select id,client_id,date_trunc('month',now() at time zone 'UTC')::date,
    encode(sha256(convert_to(jsonb_build_array(argument,script,visual_direction)::text,'UTF8')),'hex')
  from public.client_briefs where id='dddddddd-dddd-4ddd-8ddd-dddddddddddd';
update public.agents set paused=false where agent_key='creative_build';
set local role authenticated;
do $$
declare c uuid:='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'; b uuid:='dddddddd-dddd-4ddd-8ddd-dddddddddddd'; j uuid;
begin
  j:=public.queue_reviewed_image_attempt(c,b);
  if j is null or public.queue_reviewed_image_attempt(c,b) is distinct from j
    or (select count(*) from public.reviewed_image_attempt_state(c) where job_id=j)<>1
    or has_function_privilege('authenticated','public.claim_reviewed_image_attempt(uuid,uuid,text)','execute')
    then raise exception 'Duplicate queue or invalid grants'; end if;
end $$;
reset role;
select job_id as jid from agent_budget_private.image_permits where brief_id='dddddddd-dddd-4ddd-8ddd-dddddddddddd' \gset
update public.agent_jobs set status='claimed',attempts=1,lease_owner='fixture',lease_until=now()+interval '5 minutes' where id=:'jid';
select set_config('request.jwt.claim.role','service_role',true);
select set_config('request.jwt.claims','{"role":"service_role"}',true);
select public.reserve_agent_budget_turn(:'jid',1,'fixture',0,0.01);
update public.agent_jobs set status='running' where id=:'jid';
do $$
declare j uuid; r uuid; bal record;
begin
  select job_id into strict j from agent_budget_private.image_permits;
  select id into strict r from public.creative_renders where job_id=j;
  begin
    perform public.claim_reviewed_image_attempt(j,r,'wrong-owner');
    raise exception 'Unexpected stale claim';
  exception when no_data_found then null; end;
  if public.claim_reviewed_image_attempt(j,r,'fixture') is distinct from 'Fictional scene' then raise exception 'Wrong prompt'; end if;
  begin
    perform public.claim_reviewed_image_attempt(j,r,'fixture');
    raise exception 'Unexpected duplicate';
  exception when raise_exception then if sqlerrm like 'Unexpected%' then raise; end if; end;
  select * into bal from public.client_budget_state('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
  if bal.remaining_usd<>0.99 or bal.spent_usd<>0 then raise exception 'Missing reservation'; end if;
  -- Exercise an exceptional charge above both the reservation and test cap.
  perform public.settle_reviewed_image_attempt(j,'fixture','req-fixture',10,40000);
  perform public.settle_reviewed_image_attempt(j,'fixture','req-fixture',10,40000);
  select * into bal from public.client_budget_state('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
  if bal.spent_usd<>1.20005 or bal.remaining_usd<>0 then raise exception 'Incorrect settlement'; end if;
end $$;
rollback;
