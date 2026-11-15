-- Local schema test for migration 324. There is no database test job in CI.
-- Run from a clean local database after migrations, including this one:
--   supabase test db
-- The agent-runtime pglite suite covers the same checks in CI.

begin;
select plan(19);

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

select set_config('request.jwt.claim.sub', '22222222-2222-4222-8222-222222222222', true);
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claims', '{"aal":"aal2","role":"authenticated"}', true);
select throws_ok(
  $$select public.decide_console_invitation_v6(
      '44444444-4444-4444-8444-444444444444', 'version', 'hash', true, null)$$,
  '42501',
  'Bot accounts cannot perform this action',
  'aal2 does not let a bot decide an invitation'
);
select throws_ok(
  $$select public.decide_campaign_action_approval_v6(
      '44444444-4444-4444-8444-444444444444', 'rejected', 'no')$$,
  '42501',
  'Bot accounts cannot perform this action',
  'a bot cannot decide a campaign action'
);
select throws_ok(
  $$select public.record_approval_decision_v6(
      '44444444-4444-4444-8444-444444444444', 'rejected', 'hash', 'ref', 'no')$$,
  '42501',
  'Bot accounts cannot perform this action',
  'the approval ledger refuses a bot before AAL2'
);

select set_config('request.jwt.claim.sub', '11111111-1111-4111-8111-111111111111', true);
select throws_ok(
  $$select public.decide_console_invitation_v6(
      '44444444-4444-4444-8444-444444444444', 'version', 'hash', true, null)$$,
  'P0002',
  'Invitation not found.',
  'a human admin passes the invitation auth check'
);

select set_config('request.jwt.claim.role', 'service_role', true);
insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
  confirmation_token, recovery_token, email_change_token_new, email_change
) values
  ('00000000-0000-0000-0000-000000000000',
   '77777777-7777-4777-8777-777777777771',
   'authenticated', 'authenticated', 'production@attractacq.com', '', now(),
   '{}'::jsonb, '{}'::jsonb, now(), now(), '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000',
   '77777777-7777-4777-8777-777777777773',
   'authenticated', 'authenticated', 'marketing@attractacq.com', '', now(),
   '{}'::jsonb, '{}'::jsonb, now(), now(), '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000',
   '77777777-7777-4777-8777-777777777772',
   'authenticated', 'authenticated', 'sales@attractacq.com', '', now(),
   '{}'::jsonb, '{}'::jsonb, now(), now(), '', '', '', '');
insert into public.profiles (id, role, full_name, email, is_bot, bot_key) values
  ('77777777-7777-4777-8777-777777777771', 'admin', 'Production', 'production@attractacq.com', true, 'bot-production'),
  ('77777777-7777-4777-8777-777777777773', 'admin', 'Marketing', 'marketing@attractacq.com', true, 'bot-marketing'),
  ('77777777-7777-4777-8777-777777777772', 'admin', 'Sales', 'sales@attractacq.com', true, 'bot-sales');

select set_config('request.jwt.claim.sub', '77777777-7777-4777-8777-777777777771', true);
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claims', '{"aal":"aal2","role":"authenticated"}', true);
select throws_ok(
  $$select public.review_media_asset('44444444-4444-4444-8444-444444444444', 'approved', null)$$,
  'P0001',
  'Asset not found',
  'bot-production may pass the asset-approval gate'
);
select throws_ok(
  $$select public.set_publishing_enabled('44444444-4444-4444-8444-444444444444', false)$$,
  '42501',
  'Bot accounts cannot perform this action',
  'bot-production cannot publish'
);
select throws_ok(
  $$select public.approve_slot('44444444-4444-4444-8444-444444444444', null)$$,
  '42501',
  'Bot accounts cannot perform this action',
  'bot-production cannot approve a slot'
);
select set_config('request.jwt.claim.role', 'service_role', true);
select throws_ok(
  $$select * from public.revoke_bot_sessions('11111111-1111-4111-8111-111111111111')$$,
  '42501',
  'only a bot account may have sessions revoked here',
  'session purge refuses a human'
);
select set_config('request.jwt.claim.role', 'authenticated', true);

select set_config('request.jwt.claim.sub', '77777777-7777-4777-8777-777777777772', true);
select throws_ok(
  $$select public.decide_lead_magnet_approval_v6(
      '44444444-4444-4444-8444-444444444444', false, 'no')$$,
  'P0001',
  'No such approval.',
  'bot-sales may pass the lead-magnet approval gate'
);

select set_config('request.jwt.claim.sub', '77777777-7777-4777-8777-777777777773', true);
select throws_ok(
  $$select public.approve_slot('44444444-4444-4444-8444-444444444444', null)$$,
  '42501',
  'Bot accounts cannot perform this action',
  'bot-marketing cannot approve a slot'
);
select throws_ok(
  $$select public.decide_lead_magnet_approval_v6(
      '44444444-4444-4444-8444-444444444444', false, 'no')$$,
  '42501',
  'Bot accounts cannot perform this action',
  'bot-marketing cannot approve a lead magnet'
);

select * from finish();
rollback;
