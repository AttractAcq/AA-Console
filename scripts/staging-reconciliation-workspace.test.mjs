import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { parsePreflightQueries, prepare, rowDigest, verifySnapshot } from './staging-reconciliation-workspace.mjs'

const repo = resolve()
const source = join(repo, 'supabase')
const sourceBaseline = JSON.parse(readFileSync(
  join(source, 'staging-reconciliation', 'catalog-baseline.json'), 'utf8'))
const aliases = [
  { version: '20261025240000', name: '259_which_client_a_message_belongs_to', sql_payload_unavailable: true },
  { version: '20261025250000', name: '260_building_the_google_campaign', sql_payload_unavailable: true },
]

function fixture() {
  const older = readdirSync(join(source, 'migrations'))
    .filter(name => /^\d{14}_.+\.sql$/.test(name) && name.slice(0, 14) < '20261025233000')
    .sort().map(name => ({ version: name.slice(0, 14), name: name.slice(15, -4),
      sql_payload_unavailable: true }))
  const history = [...older, ...aliases]
  const checks = Array.from({ length: 20 }, (_, i) => ({
    id: `P${String(i + 1).padStart(2, '0')}`, rows: [],
  }))
  const snapshot = { projectRef: 'vmmertwoboqiazcsougw',
    capturedAt: new Date().toISOString(), transport: 'supabase-management-read-only',
    checks, history, identity: { clients: 1, auth_users: 5,
      client_ids_md5: 'a'.repeat(32), auth_user_ids_md5: 'b'.repeat(32) } }
  const baseline = { stagingProjectRef: snapshot.projectRef,
    history: { rowCount: 277, sha256: rowDigest(history) },
    checks: Object.fromEntries(checks.slice(1).map(({ id, rows }) =>
      [id, { rowCount: rows.length, sha256: rowDigest(rows) }])),
    sourceFiles: sourceBaseline.sourceFiles }
  return { snapshot, baseline }
}

describe('staging reconciliation workspace', () => {
  it('parses only the twenty read-only preflight SELECTs', () => {
    const sql = readFileSync(join(repo, 'docs', 'staging-259-272-reconciliation-preflight.sql'), 'utf8')
    const queries = parsePreflightQueries(sql)
    assert.equal(queries.length, 20)
    assert.equal(queries[0].id, 'P01')
    assert.equal(queries.at(-1).id, 'P20')
    assert.equal(queries.every(item => /^select\b/i.test(item.query)), true)
  })

  it('rejects a stale, wrong-project or changed catalog/history capture', () => {
    const { snapshot, baseline } = fixture()
    assert.equal(verifySnapshot(snapshot, baseline).historyRows, 277)
    assert.throws(() => verifySnapshot({ ...snapshot, projectRef: 'bancbdztffokwiifzoiv' }, baseline),
      /pinned staging project/)
    assert.throws(() => verifySnapshot({ ...snapshot, capturedAt: '2025-01-01T00:00:00Z' }, baseline),
      /stale/)
    const changed = structuredClone(snapshot)
    changed.checks[7].rows.push({ extra_column: true })
    assert.throws(() => verifySnapshot(changed, baseline), /P08 differs/)
    const extra = structuredClone(snapshot)
    extra.history.push({ version: '20261030120000', name: 'unexpected',
      sql_payload_unavailable: true })
    assert.throws(() => verifySnapshot(extra, baseline), /Full staging migration history/)
  })

  it('emits separate correction, 261–272, and 273–279 workspaces', () => {
    const { snapshot, baseline } = fixture()
    const destination = mkdtempSync(join(tmpdir(), 'aa-staging-workspace-test-'))
    try {
      const manifest = prepare(snapshot, baseline, destination,
        'aa_staging_rehearsal_test', 57100)
      const migrations = readdirSync(join(destination, 'supabase', 'migrations'))
      const correctionOnly = readdirSync(join(destination, 'correction-only', 'supabase', 'migrations'))
      const through279 = readdirSync(join(destination, 'through-279', 'supabase', 'migrations'))
      assert.equal(migrations.length, 290)
      assert.equal(correctionOnly.length, 278)
      assert.equal(through279.length, 297)
      assert.equal(manifest.selectedMigrations.length, 13)
      assert.equal(manifest.through279.selectedMigrations.length, 7)
      assert.equal(manifest.through279.selectedMigrations[0],
        '20261030110000_273_canonical_approval_ledger.sql')
      assert.equal(manifest.through279.selectedMigrations.at(-1),
        '20261030160000_279_approval_class_coverage.sql')
      assert.deepEqual(manifest.correctionOnly.selectedMigrations,
        ['20261026000000_260_staging_google_reconcile.sql'])
      assert.equal(manifest.selectedMigrations[0], '20261026000000_260_staging_google_reconcile.sql')
      assert.equal(manifest.selectedMigrations.at(-1), '20261030100000_272_onboarding_step_integrity.sql')
      assert.equal(migrations.includes('20261025233000_259_which_client_a_message_belongs_to.sql'), false)
      assert.equal(migrations.includes('20261025235000_260_building_the_google_campaign.sql'), false)
      for (const alias of manifest.historicalAliases) {
        assert.match(readFileSync(join(destination, 'supabase', 'migrations', alias), 'utf8'), /raise exception/)
        assert.match(readFileSync(join(destination, 'correction-only', 'supabase', 'migrations', alias), 'utf8'), /raise exception/)
        assert.match(readFileSync(join(destination, 'through-279', 'supabase', 'migrations', alias), 'utf8'), /raise exception/)
      }
      assert.equal(correctionOnly.includes('20261029120000_261_system_readiness_inventory.sql'), false)
      assert.match(readFileSync(join(destination, 'correction-only', 'supabase', 'config.toml'), 'utf8'),
        /project_id = "aa_staging_rehearsal_test_correction"/)
      assert.match(readFileSync(join(destination, 'through-279', 'supabase', 'config.toml'), 'utf8'),
        /project_id = "aa_staging_rehearsal_test_through279"/)
      assert.equal(readdirSync(join(destination, 'supabase')).includes('.temp'), false)
      assert.equal(readdirSync(join(destination, 'through-279', 'supabase')).includes('.temp'), false)
      assert.match(readFileSync(join(destination, 'supabase', 'config.toml'), 'utf8'),
        /\[analytics\]\nenabled = false/)
    } finally {
      rmSync(destination, { recursive: true, force: true })
    }
  })
})
