-- Local schema test for migration 324. There is no database test job in CI.
-- Run from a clean local database after migrations, including this one:
--   supabase test db
-- The agent-runtime pglite suite covers the same checks in CI.

begin;
select plan(34);

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

select set_config('request.jwt.claim.role', 'service_role', true);
insert into public.clients (id, name, initials) values
  ('44444444-4444-4444-8444-444444444401', 'Bot gate', 'BG');
insert into public.client_campaigns (
  id, client_id, name, brief, acquisition_mode, runs_organic, runs_paid, paid_platform)
values (
  'b1111111-1111-4111-8111-111111111111',
  '44444444-4444-4444-8444-444444444401',
  'Organic', 'A brief', 'organic', true, false, null);
insert into public.client_ideas (
  id, client_id, title, source, campaign_id, campaign_position)
values (
  'b2222222-2222-4222-8222-222222222222',
  '44444444-4444-4444-8444-444444444401',
  'Idea', 'manual',
  'b1111111-1111-4111-8111-111111111111', 1);
insert into public.client_briefs (id, client_id, source_idea_id, title) values (
  'b3333333-3333-4333-8333-333333333333',
  '44444444-4444-4444-8444-444444444401',
  'b2222222-2222-4222-8222-222222222222',
  'Brief');
insert into public.client_media_assets (
  id, client_id, brief_id, media_type, storage_path, review_status, edit_stage, content_format)
values
  ('b4444444-4444-4444-8444-444444444441',
   '44444444-4444-4444-8444-444444444401',
   'b3333333-3333-4333-8333-333333333333',
   'image', 'bot.jpg', 'pending', 'review_ready', 'single'),
  ('b4444444-4444-4444-8444-444444444442',
   '44444444-4444-4444-8444-444444444401',
   'b3333333-3333-4333-8333-333333333333',
   'image', 'human.jpg', 'pending', 'review_ready', 'single'),
  ('b4444444-4444-4444-8444-444444444443',
   '44444444-4444-4444-8444-444444444401',
   'b3333333-3333-4333-8333-333333333333',
   'image', 'bare.jpg', 'approved', 'review_ready', 'single');

select set_config('request.jwt.claim.sub', '77777777-7777-4777-8777-777777777771', true);
select set_config('request.jwt.claim.role', 'authenticated', true);
select lives_ok(
  $$select public.review_media_asset('b4444444-4444-4444-8444-444444444441', 'approved', null)$$,
  'bot-production can review an asset'
);
select results_eq(
  $$select human_approved_at is null, bot_reviewed_at is not null
      from public.client_media_assets
     where id = 'b4444444-4444-4444-8444-444444444441'$$,
  $$values (true, true)$$,
  'a bot review leaves human_approved_at null and sets bot_reviewed_at'
);
select throws_ok(
  $$select public.schedule_asset(
      'b4444444-4444-4444-8444-444444444441', current_date, 'organic', null, '09:00')$$,
  '42501',
  'Bot accounts cannot perform this action',
  'bot-production cannot schedule'
);
select is(
  (select count(*) from public.scheduled_posts
    where asset_id = 'b4444444-4444-4444-8444-444444444441'),
  0::bigint,
  'a bot review creates no scheduled post'
);

select set_config('request.jwt.claim.sub', '11111111-1111-4111-8111-111111111111', true);
select lives_ok(
  $$select public.schedule_asset(
      'b4444444-4444-4444-8444-444444444441', current_date, 'organic', null, '09:00')$$,
  'a human can schedule a bot-reviewed asset'
);
select results_eq(
  $$select a.human_approved_at is not null, sp.created_by
      from public.client_media_assets a
      join public.scheduled_posts sp on sp.asset_id = a.id
     where a.id = 'b4444444-4444-4444-8444-444444444441'$$,
  $$values (true, '11111111-1111-4111-8111-111111111111'::uuid)$$,
  'the human schedule stamps human_approved_at and records who scheduled'
);

select lives_ok(
  $$select public.review_media_asset('b4444444-4444-4444-8444-444444444442', 'approved', null)$$,
  'a human review still succeeds'
);
create temp table bot_gate_human_stamp as
  select human_approved_at from public.client_media_assets
   where id = 'b4444444-4444-4444-8444-444444444442';
select ok(
  (select human_approved_at is not null and bot_reviewed_at is null
     from public.client_media_assets
    where id = 'b4444444-4444-4444-8444-444444444442'),
  'a human review stamps human_approved_at and leaves bot_reviewed_at null'
);
select lives_ok(
  $$select public.schedule_asset(
      'b4444444-4444-4444-8444-444444444442', current_date, 'organic', null, '09:00')$$,
  'a human can still schedule an asset they approved'
);
select ok(
  (select a.human_approved_at = s.human_approved_at
     from public.client_media_assets a
     cross join bot_gate_human_stamp s
    where a.id = 'b4444444-4444-4444-8444-444444444442'),
  'scheduling a human-approved asset does not rewrite human_approved_at'
);
select throws_ok(
  $$select public.schedule_asset(
      'b4444444-4444-4444-8444-444444444443', current_date, 'organic', null, '09:00')$$,
  'P0001',
  'That asset has not been approved by a person yet. Approve it in Approvals before scheduling it.',
  'an approved asset with neither stamp still cannot be scheduled'
);

insert into public.lead_magnets (
  id, client_id, name, objective, format)
values (
  'c0000000-0000-4000-8000-000000000001',
  '44444444-4444-4444-8444-444444444401',
  'Guide', 'Explain the offer', 'pdf_guide');
insert into public.lead_magnet_versions (
  id, magnet_id, client_id, version, storage_path, content_sha256,
  file_bytes, media_type, delivery_channel)
values
  ('c0000000-0000-4000-8000-000000000011',
   'c0000000-0000-4000-8000-000000000001',
   '44444444-4444-4444-8444-444444444401',
   1, 'magnets/one.pdf', repeat('a', 64), 10, 'application/pdf', 'email'),
  ('c0000000-0000-4000-8000-000000000012',
   'c0000000-0000-4000-8000-000000000001',
   '44444444-4444-4444-8444-444444444401',
   2, 'magnets/two.pdf', repeat('b', 64), 10, 'application/pdf', 'email');
insert into public.lead_magnet_approvals (
  id, client_id, magnet_version_id, payload_hash, scope, status)
select 'c1111111-1111-4111-8111-111111111111',
       client_id, id, public.lead_magnet_payload_hash_v6(id), '{}'::jsonb, 'pending'
  from public.lead_magnet_versions
 where id = 'c0000000-0000-4000-8000-000000000011';
insert into public.lead_magnet_approvals (
  id, client_id, magnet_version_id, payload_hash, scope, status)
select 'c2222222-2222-4222-8222-222222222222',
       client_id, id, public.lead_magnet_payload_hash_v6(id), '{}'::jsonb, 'pending'
  from public.lead_magnet_versions
 where id = 'c0000000-0000-4000-8000-000000000012';

select set_config('request.jwt.claim.sub', '77777777-7777-4777-8777-777777777771', true);
select throws_ok(
  $$select public.decide_lead_magnet_approval_v6(
      'c1111111-1111-4111-8111-111111111111', true, null)$$,
  '42501',
  'Bot accounts cannot perform this action',
  'bot-production cannot approve a lead magnet'
);
select set_config('request.jwt.claim.sub', '77777777-7777-4777-8777-777777777772', true);
select lives_ok(
  $$select public.decide_lead_magnet_approval_v6(
      'c1111111-1111-4111-8111-111111111111', true, null)$$,
  'bot-sales approves a pending lead magnet'
);
select results_eq(
  $$select status, decided_by
      from public.lead_magnet_approvals
     where id = 'c1111111-1111-4111-8111-111111111111'$$,
  $$values ('approved'::text, '77777777-7777-4777-8777-777777777772'::uuid)$$,
  'the lead-magnet decision is recorded as bot-sales'
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
      'c2222222-2222-4222-8222-222222222222', true, null)$$,
  '42501',
  'Bot accounts cannot perform this action',
  'bot-marketing cannot approve a pending lead magnet'
);
select set_config('request.jwt.claim.sub', '11111111-1111-4111-8111-111111111111', true);
select lives_ok(
  $$select public.decide_lead_magnet_approval_v6(
      'c2222222-2222-4222-8222-222222222222', true, null)$$,
  'a human admin still approves a pending lead magnet'
);
select results_eq(
  $$select status, decided_by
      from public.lead_magnet_approvals
     where id = 'c2222222-2222-4222-8222-222222222222'$$,
  $$values ('approved'::text, '11111111-1111-4111-8111-111111111111'::uuid)$$,
  'the human lead-magnet decision is unchanged'
);

select * from finish();
rollback;
