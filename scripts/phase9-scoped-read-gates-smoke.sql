-- Disposable rollback fixture: signed-in read paths, with no provider effects.
begin;
insert into auth.users(id,instance_id,aud,role,email,encrypted_password,created_at,updated_at)
values
 ('a9999999-9999-4999-8999-999999999991','00000000-0000-0000-0000-000000000000','authenticated','authenticated','read-admin@example.invalid','',now(),now()),
 ('a9999999-9999-4999-8999-999999999992','00000000-0000-0000-0000-000000000000','authenticated','authenticated','read-client@example.invalid','',now(),now());
insert into public.profiles(id,role,email) values
 ('a9999999-9999-4999-8999-999999999991','admin','read-admin@example.invalid'),
 ('a9999999-9999-4999-8999-999999999992','client','read-client@example.invalid');
insert into public.clients(id,name,initials) values
 ('b9999999-9999-4999-8999-999999999991','Read fixture one','R1'),
 ('b9999999-9999-4999-8999-999999999992','Read fixture two','R2');
insert into public.client_users(client_id,user_id) values
 ('b9999999-9999-4999-8999-999999999991','a9999999-9999-4999-8999-999999999992');

do $$ begin
  if not has_function_privilege('authenticated',
    'public.campaign_action_exact_source_state_v6(uuid)', 'EXECUTE')
    or not has_function_privilege('authenticated',
    'public.list_client_external_outcomes_v6(uuid)', 'EXECUTE')
    or has_function_privilege('anon',
    'public.list_client_external_outcomes_v6(uuid)', 'EXECUTE')
    or has_table_privilege('authenticated',
    'public.google_reply_execution_attempts_v6', 'SELECT') then
    raise exception 'Scoped read ACLs are incorrect';
  end if;
end $$;

set local role authenticated;
select set_config('request.jwt.claim.role','authenticated',true);
select set_config('request.jwt.claim.sub','a9999999-9999-4999-8999-999999999991',true);
do $$ begin
  if (select count(*) from public.list_client_external_outcomes_v6(null)) <> 0
    or (select count(*) from public.list_client_external_outcomes_v6(
      'b9999999-9999-4999-8999-999999999991')) <> 0 then
    raise exception 'Admin outcome read did not return the empty fixture';
  end if;
  if public.campaign_action_exact_source_state_v6(gen_random_uuid()) <> 'unverified' then
    raise exception 'Exact approval source state was not callable';
  end if;
end $$;

select set_config('request.jwt.claim.sub','a9999999-9999-4999-8999-999999999992',true);
do $$ declare denied boolean; begin
  if (select count(*) from public.list_client_external_outcomes_v6(
    'b9999999-9999-4999-8999-999999999991')) <> 0 then
    raise exception 'Client-scoped outcome read failed';
  end if;
  denied:=false;
  begin perform count(*) from public.list_client_external_outcomes_v6(null);
  exception when insufficient_privilege then denied:=true; end;
  if not denied then raise exception 'Client could read agency outcomes'; end if;
  denied:=false;
  begin perform count(*) from public.list_client_external_outcomes_v6(
    'b9999999-9999-4999-8999-999999999992');
  exception when insufficient_privilege then denied:=true; end;
  if not denied then raise exception 'Client could read another client outcomes'; end if;
  denied:=false;
  begin perform count(*) from public.client_external_outcomes_v6;
  exception when insufficient_privilege then denied:=true; end;
  if not denied then raise exception 'Restricted outcome view unexpectedly readable'; end if;
end $$;
rollback;
