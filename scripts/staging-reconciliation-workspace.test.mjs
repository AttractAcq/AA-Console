import { describe, expect, it } from 'vitest'
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
    expect(queries).toHaveLength(20)
    expect(queries[0].id).toBe('P01')
    expect(queries.at(-1).id).toBe('P20')
    expect(queries.every(item => /^select\b/i.test(item.query))).toBe(true)
  })

  it('rejects a stale, wrong-project or changed catalog/history capture', () => {
    const { snapshot, baseline } = fixture()
    expect(verifySnapshot(snapshot, baseline).historyRows).toBe(277)
    expect(() => verifySnapshot({ ...snapshot, projectRef: 'bancbdztffokwiifzoiv' }, baseline))
      .toThrow(/pinned staging project/)
    expect(() => verifySnapshot({ ...snapshot, capturedAt: '2025-01-01T00:00:00Z' }, baseline))
      .toThrow(/stale/)
    const changed = structuredClone(snapshot)
    changed.checks[7].rows.push({ extra_column: true })
    expect(() => verifySnapshot(changed, baseline)).toThrow(/P08 differs/)
    const extra = structuredClone(snapshot)
    extra.history.push({ version: '20261030120000', name: 'unexpected',
      sql_payload_unavailable: true })
    expect(() => verifySnapshot(extra, baseline)).toThrow(/Full staging migration history/)
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
      expect(migrations).toHaveLength(290)
      expect(correctionOnly).toHaveLength(278)
      expect(through279).toHaveLength(297)
      expect(manifest.selectedMigrations).toHaveLength(13)
      expect(manifest.through279.selectedMigrations).toHaveLength(7)
      expect(manifest.through279.selectedMigrations[0])
        .toBe('20261030110000_273_canonical_approval_ledger.sql')
      expect(manifest.through279.selectedMigrations.at(-1))
        .toBe('20261030160000_279_approval_class_coverage.sql')
      expect(manifest.correctionOnly.selectedMigrations)
        .toEqual(['20261026000000_260_staging_google_reconcile.sql'])
      expect(manifest.selectedMigrations[0]).toBe('20261026000000_260_staging_google_reconcile.sql')
      expect(manifest.selectedMigrations.at(-1)).toBe('20261030100000_272_onboarding_step_integrity.sql')
      expect(migrations).not.toContain('20261025233000_259_which_client_a_message_belongs_to.sql')
      expect(migrations).not.toContain('20261025235000_260_building_the_google_campaign.sql')
      for (const alias of manifest.historicalAliases) {
        expect(readFileSync(join(destination, 'supabase', 'migrations', alias), 'utf8'))
          .toContain('raise exception')
        expect(readFileSync(join(destination, 'correction-only', 'supabase', 'migrations', alias), 'utf8'))
          .toContain('raise exception')
        expect(readFileSync(join(destination, 'through-279', 'supabase', 'migrations', alias), 'utf8'))
          .toContain('raise exception')
      }
      expect(correctionOnly).not.toContain('20261029120000_261_system_readiness_inventory.sql')
      expect(readFileSync(join(destination, 'correction-only', 'supabase', 'config.toml'), 'utf8'))
        .toContain('project_id = "aa_staging_rehearsal_test_correction"')
      expect(readFileSync(join(destination, 'through-279', 'supabase', 'config.toml'), 'utf8'))
        .toContain('project_id = "aa_staging_rehearsal_test_through279"')
      expect(readdirSync(join(destination, 'supabase'))).not.toContain('.temp')
      expect(readdirSync(join(destination, 'through-279', 'supabase'))).not.toContain('.temp')
      expect(readFileSync(join(destination, 'supabase', 'config.toml'), 'utf8'))
        .toContain('[analytics]\nenabled = false')
    } finally {
      rmSync(destination, { recursive: true, force: true })
    }
  })
})
