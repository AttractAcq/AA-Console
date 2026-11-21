-- Disposable ACL fixture. No provider effect or persistent record remains.
begin;
insert into auth.users(id,instance_id,aud,role,email,encrypted_password,created_at,updated_at)
values
 ('a9999999-9999-4999-8999-999999999981','00000000-0000-0000-0000-000000000000','authenticated','authenticated','profile-read-admin@example.invalid','',now(),now()),
 ('a9999999-9999-4999-8999-999999999982','00000000-0000-0000-0000-000000000000','authenticated','authenticated','profile-read-client@example.invalid','',now(),now());
insert into public.profiles(id,role,email) values
 ('a9999999-9999-4999-8999-999999999981','admin','profile-read-admin@example.invalid'),
 ('a9999999-9999-4999-8999-999999999982','client','profile-read-client@example.invalid');
insert into public.clients(id,name,initials) values
 ('b9999999-9999-4999-8999-999999999981','Profile read one','P1'),
 ('b9999999-9999-4999-8999-999999999982','Profile read two','P2');
insert into public.client_users(client_id,user_id) values
 ('b9999999-9999-4999-8999-999999999981','a9999999-9999-4999-8999-999999999982');

do $$ begin
  if not has_function_privilege('authenticated',
      'public.list_google_profile_execution_overview_v6(uuid)', 'EXECUTE')
    or not has_function_privilege('authenticated',
      'public.list_meta_profile_execution_overview_v6(uuid)', 'EXECUTE')
    or not has_function_privilege('authenticated',
      'public.list_google_reply_execution_overview_v6(uuid)', 'EXECUTE')
    or has_function_privilege('anon',
      'public.list_google_reply_execution_overview_v6(uuid)', 'EXECUTE')
    or has_table_privilege('authenticated',
      'public.google_reply_execution_attempts_v6', 'SELECT')
    or has_table_privilege('authenticated',
      'public.meta_profile_execution_attempts_v6', 'SELECT')
    or has_table_privilege('authenticated',
      'public.google_profile_execution_attempts_v6', 'SELECT') then
    raise exception 'Profile execution read ACLs are incorrect';
  end if;
end $$;

set local role authenticated;
select set_config('request.jwt.claim.role','authenticated',true);
select set_config('request.jwt.claim.sub','a9999999-9999-4999-8999-999999999982',true);
do $$ declare denied boolean; begin
  -- These reads traverse the private attempt tables even when the fixture has
  -- no attempts. The invoker views alone must still deny a direct read.
  if (select count(*) from public.list_google_profile_execution_overview_v6(
       'b9999999-9999-4999-8999-999999999981')) <> 0
    or (select count(*) from public.list_meta_profile_execution_overview_v6(
       'b9999999-9999-4999-8999-999999999981')) <> 0
    or (select count(*) from public.list_google_reply_execution_overview_v6(
       'b9999999-9999-4999-8999-999999999981')) <> 0 then
    raise exception 'Client-scoped execution read failed';
  end if;
  denied:=false;
  begin perform count(*) from public.google_reply_execution_overview_v6;
  exception when insufficient_privilege then denied:=true; end;
  if not denied then raise exception 'Direct reply overview unexpectedly readable'; end if;
  denied:=false;
  begin perform count(*) from public.google_profile_execution_overview_v6;
  exception when insufficient_privilege then denied:=true; end;
  if not denied then raise exception 'Direct Google overview unexpectedly readable'; end if;
  denied:=false;
  begin perform count(*) from public.meta_profile_execution_overview_v6;
  exception when insufficient_privilege then denied:=true; end;
  if not denied then raise exception 'Direct Meta overview unexpectedly readable'; end if;
  denied:=false;
  begin perform count(*) from public.list_google_profile_execution_overview_v6(
    'b9999999-9999-4999-8999-999999999982');
  exception when insufficient_privilege then denied:=true; end;
  if not denied then raise exception 'Other-client Google profile read succeeded'; end if;
  denied:=false;
  begin perform count(*) from public.list_meta_profile_execution_overview_v6(
    'b9999999-9999-4999-8999-999999999982');
  exception when insufficient_privilege then denied:=true; end;
  if not denied then raise exception 'Other-client Meta profile read succeeded'; end if;
  denied:=false;
  begin perform count(*) from public.list_google_reply_execution_overview_v6(
    'b9999999-9999-4999-8999-999999999982');
  exception when insufficient_privilege then denied:=true; end;
  if not denied then raise exception 'Other-client reply read succeeded'; end if;
  denied:=false;
  begin perform count(*) from public.list_google_reply_execution_overview_v6(null);
  exception when insufficient_privilege then denied:=true; end;
  if not denied then raise exception 'Null client scope succeeded'; end if;
end $$;

select set_config('request.jwt.claim.sub','a9999999-9999-4999-8999-999999999981',true);
do $$ begin
  if (select count(*) from public.list_google_profile_execution_overview_v6(
       'b9999999-9999-4999-8999-999999999982')) <> 0
    or (select count(*) from public.list_meta_profile_execution_overview_v6(
       'b9999999-9999-4999-8999-999999999982')) <> 0
    or (select count(*) from public.list_google_reply_execution_overview_v6(
       'b9999999-9999-4999-8999-999999999982')) <> 0 then
    raise exception 'Admin scoped execution read failed';
  end if;
end $$;
rollback;
