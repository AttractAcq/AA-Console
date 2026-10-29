import assert from 'node:assert/strict'
import { test } from 'node:test'
import { assertSchemaMigrationOrder } from './schema-migration-order.mjs'

const released = '20261025233000'
const migration259 = '20261025233000_259_which_client_a_message_belongs_to.sql'
const migration260 = '20261026120000_260_google_ads_executor.sql'
const migration261 = '20261029120000_261_system_readiness_inventory.sql'
const migration262 = '20261029130000_262_runtime_heartbeat_retention.sql'

test('the current 261 and 262 branch is blocked until 260 exists', () => {
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
      migration259, migration261, '20261029125000_260_google_ads_executor.sql', migration262
    ], released),
    /Expected migration 260 before .*_261_/
  )
})

test('duplicate Supabase versions and unnumbered pending files fail', () => {
  assert.throws(
    () => assertSchemaMigrationOrder([migration259, migration260,
      '20261026120000_260_duplicate.sql'], released),
    /share a Supabase version/
  )
  assert.throws(
    () => assertSchemaMigrationOrder([migration259,
      '20261026120000_google_ads_executor.sql'], released),
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
  const migration263 = '20261029140000_263_following_release.sql'
  assert.deepEqual(
    assertSchemaMigrationOrder(
      [migration259, migration260, migration261, migration262, migration263],
      '20261029120000'
    ),
    { releasedVersion: '20261029120000', releasedNumber: 261,
      headVersion: '20261029140000', nextNumber: 264, pendingCount: 2 }
  )
})
