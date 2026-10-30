import assert from 'node:assert/strict'
import { test } from 'node:test'
import { assertSchemaMigrationOrder } from './schema-migration-order.mjs'

const released = '20261025233000'
const migration259 = '20261025233000_259_which_client_a_message_belongs_to.sql'
const migration260 = '20261025235000_260_building_the_google_campaign.sql'
const migration261 = '20261029120000_261_system_readiness_inventory.sql'
const migration262 = '20261029130000_262_runtime_heartbeat_retention.sql'
const migration263 = '20261029140000_263_auth_signup_role_hardening.sql'
const migration264 = '20261029150000_264_low_level_transition_isolation.sql'
const migration265 = '20261029160000_265_lead_and_media_entitlements.sql'
const migration266 = '20261029170000_266_commercial_reporting_and_storage_scope.sql'
const migration267 = '20261029180000_267_sales_entitlement_boundary.sql'
const migration268 = '20261029190000_268_contact_and_conversation_scope.sql'
const migration269 = '20261029200000_269_authenticated_sales_rpc_scope.sql'
const migration270 = '20261029210000_270_default_deny_auth_and_active_staff.sql'
const migration271 = '20261029220000_271_profileless_authenticated_scope.sql'
const migration272 = '20261030100000_272_onboarding_step_integrity.sql'
const migration273 = '20261030110000_273_canonical_approval_ledger.sql'
const migration274 = '20261030120000_274_campaign_action_inbox_bridge.sql'
const migration275 = '20261030130000_275_sales_entitlement_inbox_binding.sql'
const migration276 = '20261030140000_276_recruitment_brief_inbox.sql'
const migration277 = '20261030141000_277_engine_slot_preview_inbox.sql'
const migration278 = '20261030150000_278_google_review_reply_inbox.sql'
const migration279 = '20261030160000_279_approval_class_coverage.sql'
const released263 = '20261029140000'

test('the 261 and 262 history is blocked until 260 exists', () => {
  assert.throws(
    () => assertSchemaMigrationOrder([migration259, migration261, migration262], released),
    /Expected migration 260 before .*_261_/
  )
})

test('260, 261 and 262 in timestamp order pass', () => {
  assert.deepEqual(
    assertSchemaMigrationOrder([migration262, migration259, migration260, migration261], released),
    { releasedVersion: released, releasedNumber: 259, headVersion: '20261029130000',
      nextNumber: 263, pendingCount: 3 }
  )
})

test('a 260 timestamp after 261 cannot retroactively satisfy the dependency', () => {
  assert.throws(
    () => assertSchemaMigrationOrder([
      migration259, migration261, '20261029125000_260_building_the_google_campaign.sql', migration262
    ], released),
    /Expected migration 260 before .*_261_/
  )
})

test('duplicate Supabase versions and unnumbered pending files fail', () => {
  assert.throws(
    () => assertSchemaMigrationOrder([migration259, migration260,
      '20261025235000_260_duplicate.sql'], released),
    /share a Supabase version/
  )
  assert.throws(
    () => assertSchemaMigrationOrder([migration259,
      '20261025235000_building_the_google_campaign.sql'], released),
    /no logical number/
  )
})

test('an unrelated file labelled 260 does not satisfy the Google Ads dependency', () => {
  assert.throws(
    () => assertSchemaMigrationOrder([migration259,
      '20261026120000_260_unrelated.sql', migration261], released),
    /Migration 260 must be the Google Ads dependency/
  )
})

test('after the released marker advances to 261, the existing 260 and later 263 still pass', () => {
  assert.deepEqual(
    assertSchemaMigrationOrder(
      [migration259, migration260, migration261, migration262, migration263],
      '20261029120000'
    ),
    { releasedVersion: '20261029120000', releasedNumber: 261,
      headVersion: '20261029140000', nextNumber: 264, pendingCount: 2 }
  )
})

test('the released 263 marker leaves exactly the B005 264–269 sequence pending', () => {
  const files = [migration259, migration260, migration261, migration262, migration263,
    migration264, migration265, migration266, migration267, migration268, migration269]
  assert.deepEqual(assertSchemaMigrationOrder(files, released263), {
    releasedVersion: released263, releasedNumber: 263,
    headVersion: '20261029200000', nextNumber: 270, pendingCount: 6,
  })
  assert.throws(
    () => assertSchemaMigrationOrder(files.filter((name) => name !== migration266), released263),
    /Expected migration 266 before .*_267_/,
  )
})

test('onboarding integrity follows profileless Auth hardening with no skipped migration', () => {
  const files = [migration259, migration260, migration261, migration262, migration263,
    migration264, migration265, migration266, migration267, migration268, migration269,
    migration270, migration271, migration272]
  assert.deepEqual(assertSchemaMigrationOrder(files, released263), {
    releasedVersion: released263, releasedNumber: 263,
    headVersion: '20261030100000', nextNumber: 273, pendingCount: 9,
  })
  assert.throws(
    () => assertSchemaMigrationOrder(files.filter((name) => name !== migration271), released263),
    /Expected migration 271 before .*_272_/,
  )
})

test('canonical approval ledger follows onboarding integrity with no skipped migration', () => {
  const files = [migration259, migration260, migration261, migration262, migration263,
    migration264, migration265, migration266, migration267, migration268, migration269,
    migration270, migration271, migration272, migration273]
  assert.deepEqual(assertSchemaMigrationOrder(files, released263), {
    releasedVersion: released263, releasedNumber: 263,
    headVersion: '20261030110000', nextNumber: 274, pendingCount: 10,
  })
  assert.throws(
    () => assertSchemaMigrationOrder(files.filter((name) => name !== migration272), released263),
    /Expected migration 272 before .*_273_/,
  )
})

test('campaign action Inbox bridge follows the canonical ledger', () => {
  const files = [migration259, migration260, migration261, migration262, migration263,
    migration264, migration265, migration266, migration267, migration268, migration269,
    migration270, migration271, migration272, migration273, migration274]
  assert.deepEqual(assertSchemaMigrationOrder(files, released263), {
    releasedVersion: released263, releasedNumber: 263,
    headVersion: '20261030120000', nextNumber: 275, pendingCount: 11,
  })
  assert.throws(
    () => assertSchemaMigrationOrder(files.filter((name) => name !== migration273), released263),
    /Expected migration 273 before .*_274_/,
  )
})

test('sales entitlement Inbox binding follows the campaign action bridge', () => {
  const files = [migration259, migration260, migration261, migration262, migration263,
    migration264, migration265, migration266, migration267, migration268, migration269,
    migration270, migration271, migration272, migration273, migration274, migration275]
  assert.deepEqual(assertSchemaMigrationOrder(files, released263), {
    releasedVersion: released263, releasedNumber: 263,
    headVersion: '20261030130000', nextNumber: 276, pendingCount: 12,
  })
  assert.throws(
    () => assertSchemaMigrationOrder(files.filter((name) => name !== migration274), released263),
    /Expected migration 274 before .*_275_/,
  )
})

test('the four later Inbox slices preserve strict 276–279 dependency order', () => {
  const files = [migration259, migration260, migration261, migration262, migration263,
    migration264, migration265, migration266, migration267, migration268, migration269,
    migration270, migration271, migration272, migration273, migration274, migration275,
    migration276, migration277, migration278, migration279]
  assert.deepEqual(assertSchemaMigrationOrder(files, released263), {
    releasedVersion: released263, releasedNumber: 263,
    headVersion: '20261030160000', nextNumber: 280, pendingCount: 16,
  })
  for (const missing of [migration276, migration277, migration278]) {
    assert.throws(
      () => assertSchemaMigrationOrder(files.filter((name) => name !== missing), released263),
      /Expected migration \d+ before .*_/,
    )
  }
})
