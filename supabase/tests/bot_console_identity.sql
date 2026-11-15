-- Local schema test for migration 324. There is no database test job in CI.
-- Run from a clean local database after migrations, including this one:
--   supabase test db
-- The agent-runtime pglite suite covers the same checks in CI.

begin;
select plan(8);

insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
  confirmation_token, recovery_token, email_change_token_new, email_change
) values
  ('00000000-0000-0000-0000-000000000000',
   '11111111-1111-4111-8111-111111111111',
   'authenticated', 'authenticated', 'human-324@attractacq.com', '', now(),
   '{}'::jsonb, '{}'::jsonb, now(), now(), '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000',
   '22222222-2222-4222-8222-222222222222',
   'authenticated', 'authenticated', 'bot-cos-324@attractacq.com', '', now(),
   '{}'::jsonb, '{}'::jsonb, now(), now(), '', '', '', '');

select set_config('request.jwt.claim.role', 'service_role', true);
insert into public.profiles (id, role, full_name, email, is_bot, bot_key)
values
  ('11111111-1111-4111-8111-111111111111', 'admin', 'Human', 'human-324@attractacq.com', false, null),
  ('22222222-2222-4222-8222-222222222222', 'admin', 'Chief of Staff', 'bot-cos-324@attractacq.com', true, 'bot-cos');

select set_config('request.jwt.claim.sub', '11111111-1111-4111-8111-111111111111', true);
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claims', '{"aal":"aal2","role":"authenticated"}', true);
select ok(public.is_admin() and public.is_human_admin(), 'human admin is human');

select set_config('request.jwt.claim.sub', '22222222-2222-4222-8222-222222222222', true);
select set_config('request.jwt.claims', '{"aal":"aal2","role":"authenticated"}', true);
select ok(public.is_admin() and not public.is_human_admin(), 'bot admin with aal2 is not human');

select results_eq(
  $$select raw_app_meta_data->>'is_bot', raw_app_meta_data->>'bot_key'
      from auth.users where id = '22222222-2222-4222-8222-222222222222'$$,
  $$values ('true'::text, 'bot-cos'::text)$$,
  'bot identity is mirrored into raw_app_meta_data'
);

select throws_ok(
  $$update public.profiles set is_bot = false
     where id = '22222222-2222-4222-8222-222222222222'$$,
  '42501',
  'only service_role may change bot identity',
  'a bot session cannot clear is_bot'
);

select set_config('request.jwt.claim.sub', '11111111-1111-4111-8111-111111111111', true);
select throws_ok(
  $$select public.request_client_sales_entitlement(
      '44444444-4444-4444-8444-444444444444',
      '44444444-4444-4444-8444-444444444444', 'grant')$$,
  'P0001',
  'Client does not exist.',
  'human admin passes the sales-grant auth check'
);

select set_config('request.jwt.claim.sub', '22222222-2222-4222-8222-222222222222', true);
select throws_ok(
  $$select public.set_publishing_enabled('44444444-4444-4444-8444-444444444444', false)$$,
  '42501',
  'Bot accounts cannot perform this action',
  'publishing enable is a hard hold'
);

select set_config('request.jwt.claim.sub', '22222222-2222-4222-8222-222222222222', true);
select throws_ok(
  $$select public.decide_client_sales_entitlement(
      '44444444-4444-4444-8444-444444444444', 'hash', true, null)$$,
  '42501',
  'Bot accounts cannot perform this action',
  'aal2 does not let a bot grant sales access'
);

select set_config('request.jwt.claim.role', 'service_role', true);
select lives_ok(
  $$update public.profiles set full_name = full_name
     where id = '11111111-1111-4111-8111-111111111111'$$,
  'service_role may touch a human profile without making it a bot'
);

select * from finish();
rollback;
