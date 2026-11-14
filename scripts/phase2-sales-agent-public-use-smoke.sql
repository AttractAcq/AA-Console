-- Rollback-only proof for exact-script public-use approval and serving.
begin;
insert into auth.users(id,instance_id,aud,role,email,encrypted_password,created_at,updated_at)
values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','00000000-0000-0000-0000-000000000000',
  'authenticated','authenticated','sales-admin@example.invalid','',now(),now()),
  ('cccccccc-cccc-4ccc-8ccc-cccccccccccc','00000000-0000-0000-0000-000000000000',
  'authenticated','authenticated','sales-outsider@example.invalid','',now(),now());
insert into public.profiles(id,role,email) values
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','admin','sales-admin@example.invalid'),
  ('cccccccc-cccc-4ccc-8ccc-cccccccccccc','client','sales-outsider@example.invalid');
insert into public.clients(id,name,initials) values
  ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','Sales fixture','SF');
select set_config('request.jwt.claim.sub','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',true);
select set_config('request.jwt.claim.role','authenticated',true);
select set_config('request.jwt.claims',
  '{"sub":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","role":"authenticated","aal":"aal1"}',true);

do $checks$
declare p public.client_pages%rowtype;
  a public.client_sales_agents%rowtype;
  r public.approval_requests_v6%rowtype;
  dep public.client_sales_agent_deployments%rowtype;
  new_request uuid;
begin
  insert into public.client_pages(client_id,page_type,title,publish_status,published_url)
  values ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','landing','Sales page',
    'published','https://sales.example.invalid/')
  returning * into p;
  begin
    insert into public.client_sales_agents(client_id,page_id,name,purpose,status,
      built_at,approved_at,approved_by)
    values (p.client_id,p.id,'Forged agent','Bypass','live',now(),now(),auth.uid());
    raise exception 'Inserted agent carried a forged public signature';
  exception when check_violation then null; end;
  insert into public.client_sales_agents(client_id,page_id,name,purpose,status,
    greeting,system_prompt,qualification,objections,booking_rule,
    escalation_rule,guardrails,built_at)
  values (p.client_id,p.id,'Sales fixture','Book consultations','live',
    'Hello','Answer accurately','[]'::jsonb,'[]'::jsonb,'Book when ready',
    'Escalate medical questions','Never promise a result',now())
  returning * into a;
  insert into public.client_sales_agent_deployments(client_id,sales_agent_id,
    page_id,allowed_origin)
  values (a.client_id,a.id,p.id,'https://sales.example.invalid')
  returning * into dep;
  begin
    insert into public.client_sales_agent_deployments(client_id,sales_agent_id,
      page_id,allowed_origin,enabled)
    values (a.client_id,a.id,p.id,'https://other.example.invalid',true);
    raise exception 'Unapproved deployment inserted enabled';
  exception when check_violation then null; end;
  begin
    update public.client_sales_agent_deployments set enabled = true where id = dep.id;
    raise exception 'Unapproved deployment enabled';
  exception when check_violation then null; end;
  r.id := public.request_sales_agent_public_use_v6(a.id);
  select * into r from public.approval_requests_v6 where id = r.id;
  if r.artifact_hash is null or r.preview->>'system_prompt' <> 'Answer accurately'
    or r.scope->>'page_id' <> p.id::text
    or public.sales_agent_public_source_state_v6(r.id) <> 'pending'
    then raise exception 'Exact sales-agent request was not registered'; end if;
  if public.request_sales_agent_public_use_v6(a.id) <> r.id
    then raise exception 'Duplicate click created another request'; end if;
  begin
    perform public.approve_sales_agent_public_use_v6(a.id,r.id);
    raise exception 'AAL1 approved public use';
  exception when insufficient_privilege then null; end;
  begin
    update public.client_sales_agents set approved_at = now(),
      approved_by = auth.uid() where id = a.id;
    raise exception 'Direct signature bypassed Inbox';
  exception when insufficient_privilege then null; end;
  perform set_config('request.jwt.claim.sub','cccccccc-cccc-4ccc-8ccc-cccccccccccc',true);
  perform set_config('request.jwt.claims',
    '{"sub":"cccccccc-cccc-4ccc-8ccc-cccccccccccc","role":"authenticated","aal":"aal2"}',true);
  begin
    perform public.approve_sales_agent_public_use_v6(a.id,r.id);
    raise exception 'Wrong-client actor approved';
  exception when insufficient_privilege then null; end;
  perform set_config('request.jwt.claim.sub','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',true);
  perform set_config('request.jwt.claims',
    '{"sub":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","role":"authenticated","aal":"aal2"}',true);
  perform public.approve_sales_agent_public_use_v6(a.id,r.id);
  if (select status from public.approval_inbox_v6 where id = r.id) <> 'approved'
    or not public.sales_agent_public_use_current_v6(a.id) then
    raise exception 'Source and Inbox approval diverged'; end if;
  update public.client_pages set publish_status = 'unpublished' where id = p.id;
  begin
    update public.client_sales_agent_deployments set enabled = true where id = dep.id;
    raise exception 'Unpublished page enabled an agent';
  exception when check_violation then null; end;
  update public.client_pages set publish_status = 'published' where id = p.id;
  update public.client_sales_agent_deployments
    set allowed_origin = 'https://wrong.example.invalid' where id = dep.id;
  begin
    update public.client_sales_agent_deployments set enabled = true where id = dep.id;
    raise exception 'Wrong page origin enabled an agent';
  exception when check_violation then null; end;
  update public.client_sales_agent_deployments
    set allowed_origin = 'https://sales.example.invalid' where id = dep.id;
  update public.client_sales_agent_deployments set enabled = true where id = dep.id;
  perform set_config('request.jwt.claim.role','service_role',true);
  perform set_config('request.jwt.claims','{"role":"service_role"}',true);
  if not exists (select 1 from public.resolve_sales_deployment(dep.public_id)) then
    raise exception 'Exact approved agent did not resolve'; end if;
  perform set_config('request.jwt.claim.role','authenticated',true);
  perform set_config('request.jwt.claim.sub','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',true);
  perform set_config('request.jwt.claims',
    '{"sub":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","role":"authenticated","aal":"aal2"}',true);
  update public.client_sales_agents set system_prompt = 'Revised advice' where id = a.id;
  if (select approved_at from public.client_sales_agents where id = a.id) is not null
    or public.sales_agent_public_source_state_v6(r.id) <> 'superseded' then
    raise exception 'An approved script changed without invalidating public use'; end if;
  perform set_config('request.jwt.claim.role','service_role',true);
  perform set_config('request.jwt.claims','{"role":"service_role"}',true);
  if exists (select 1 from public.resolve_sales_deployment(dep.public_id)) then
    raise exception 'Changed script still resolved publicly'; end if;
  perform set_config('request.jwt.claim.role','authenticated',true);
  perform set_config('request.jwt.claim.sub','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',true);
  perform set_config('request.jwt.claims',
    '{"sub":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","role":"authenticated","aal":"aal2"}',true);
  new_request := public.request_sales_agent_public_use_v6(a.id);
  perform public.approve_sales_agent_public_use_v6(a.id,new_request);
  select * into r from public.approval_requests_v6 where id = new_request;
  perform public.revoke_sales_agent_public_use_v6(a.id,'Incorrect advice');
  perform set_config('request.jwt.claim.role','service_role',true);
  perform set_config('request.jwt.claims','{"role":"service_role"}',true);
  if exists (select 1 from public.resolve_sales_deployment(dep.public_id)) then
    raise exception 'Revoked public agent still resolved'; end if;
  perform set_config('request.jwt.claim.role','authenticated',true);
  perform set_config('request.jwt.claim.sub','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',true);
  perform set_config('request.jwt.claims',
    '{"sub":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","role":"authenticated","aal":"aal2"}',true);
  if (select status from public.approval_inbox_v6 where id = r.id) <> 'revoked'
    then raise exception 'Revocation did not reach Inbox'; end if;
  new_request := public.request_sales_agent_public_use_v6(a.id);
  if new_request = r.id then raise exception 'Revocation reused the old request'; end if;
  update public.client_sales_agents set system_prompt = 'Changed advice' where id = a.id;
  if public.sales_agent_public_source_state_v6(new_request) <> 'superseded' then
    raise exception 'Script change did not stale the request'; end if;
  begin
    perform public.approve_sales_agent_public_use_v6(a.id,new_request);
    raise exception 'Stale script approved';
  exception when check_violation then null; end;
end $checks$;
rollback;
