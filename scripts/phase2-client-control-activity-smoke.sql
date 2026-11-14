-- Run against a local database with migrations through 326 applied.
-- Everything is rolled back; the two posts prove a newer failed attempt
-- does not erase an earlier observed provider reference.
begin;
insert into auth.users (id, instance_id, aud, role, email, encrypted_password, created_at, updated_at)
values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '00000000-0000-0000-0000-000000000000',
  'authenticated', 'authenticated', 'phase2-admin@example.invalid', '', now(), now()),
  ('cccccccc-cccc-4ccc-8ccc-cccccccccccc', '00000000-0000-0000-0000-000000000000',
  'authenticated', 'authenticated', 'phase2-outsider@example.invalid', '', now(), now());
insert into public.profiles (id, role, email)
values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'admin', 'phase2-admin@example.invalid'),
  ('cccccccc-cccc-4ccc-8ccc-cccccccccccc', 'client', 'phase2-outsider@example.invalid');
insert into public.clients (id, name, initials)
values ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'Phase 2 test', 'P2');
insert into public.scheduled_posts (
  client_id, scheduled_for, scheduled_at, publication_status, publish_attempts,
  publish_claimed_at, published_at, external_id)
values ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', current_date - 1,
  now() - interval '1 day', 'published', 1, now() - interval '1 day',
  now() - interval '1 day', 'meta-receipt-1');
insert into public.scheduled_posts (
  client_id, scheduled_for, scheduled_at, publication_status, publish_attempts,
  publish_claimed_at)
values ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', current_date,
  now(), 'failed', 1, now());

select set_config('request.jwt.claim.sub', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', true);
select set_config('request.jwt.claim.role', 'authenticated', true);
do $checks$
declare v_activity jsonb;
begin
  if has_function_privilege('anon', 'public.client_control_activity_v6(uuid)', 'execute') then
    raise exception 'Anonymous activity read is open';
  end if;
  v_activity := public.client_control_activity_v6('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
  if (select count(*) from jsonb_each(v_activity)) <> 9
    or v_activity->'publishing'->'lastRun'->>'status' <> 'failed'
    or v_activity->'publishing'->'lastExternalReceipt'->>'externalRef' <> 'meta-receipt-1'
    or v_activity->'engine'->'lastExternalReceipt' <> 'null'::jsonb then
    raise exception 'Control activity conflated an attempt, receipt or unavailable route';
  end if;
end;
$checks$;

select set_config('request.jwt.claim.sub', 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', true);
do $checks$
begin
  begin
    perform public.client_control_activity_v6('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
    raise exception 'An unrelated client read another client''s activity';
  exception when insufficient_privilege then null;
  end;
end;
$checks$;
rollback;
