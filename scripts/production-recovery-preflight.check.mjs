import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { CURRENT_CRON_COUNT, EMPTY_SHA256, PRODUCTION_REF,
  trackedHistory, verifyRecoverySnapshots } from './production-recovery-preflight.mjs'

const now = Date.parse('2026-10-30T12:00:00.000Z')
const d = (letter) => letter.repeat(64)
const expected = trackedHistory()

test('reads tracked history from a checkout path containing spaces and a URL fragment character', () => {
  const fixtureDir = mkdtempSync(join(tmpdir(), 'aa-q019-path-'))
  try {
    const alias = join(fixtureDir, 'project # release')
    symlinkSync(fileURLToPath(new URL('../', import.meta.url)), alias)
    assert.deepEqual(trackedHistory(alias), expected)
  } finally {
    rmSync(fixtureDir, { recursive: true, force: true })
  }
})

test('accepts a held post-282 migration file without changing the released recovery baseline', () => {
  const fixtureDir = mkdtempSync(join(tmpdir(), 'aa-q019-release-'))
  try {
    const migrationsDir = join(fixtureDir, 'supabase/migrations')
    const verificationDir = join(fixtureDir, 'supabase/verification')
    mkdirSync(migrationsDir, { recursive: true })
    mkdirSync(verificationDir, { recursive: true })
    writeFileSync(join(verificationDir, 'released-migration-version.txt'), '20261102010000\n')
    const sourceMigrationsDir = fileURLToPath(new URL('../supabase/migrations/', import.meta.url))
    for (const name of readdirSync(sourceMigrationsDir).filter((file) => /^\d{14}_.+\.sql$/.test(file))) {
      writeFileSync(join(migrationsDir, name), '')
    }
    writeFileSync(join(migrationsDir, '20261231000000_999_held_candidate.sql'), '')
    assert.deepEqual(trackedHistory(fixtureDir), expected)
    writeFileSync(join(verificationDir, 'released-migration-version.txt'), '20261231000000\n')
    assert.throws(() => trackedHistory(fixtureDir), /baseline changed/)
  } finally {
    rmSync(fixtureDir, { recursive: true, force: true })
  }
})

function fixtures() {
  const migrations = expected.map((row, index) => ({
    ...row, statementsSha256: index < 4 ? null : d('a'),
  }))
  const cronJobs = Array.from({ length: CURRENT_CRON_COUNT }, (_, index) => ({
    name: `job-${String(index + 1).padStart(2, '0')}`,
    definitionSha256: d('b'), active: true,
  }))
  const source = {
    schemaVersion: 1, projectRef: PRODUCTION_REF, environment: 'production',
    capturedAt: '2026-10-30T11:40:00.000Z', migrations,
    identities: {
      clients: { count: 5, idsSha256: d('c') },
      authUsers: { count: 7, idsSha256: d('d') },
    },
    storage: {
      objectCount: 2, objectMetadataSha256: d('e'),
      bucketCount: 4, bucketConfigSha256: d('f'),
      byteCount: 2, byteManifestSha256: d('1'),
    },
    vault: { secretCount: 1, secretIdsSha256: d('2'), decryptableCount: 1 },
    cronJobs,
  }
  const restore = structuredClone(source)
  restore.projectRef = 'aa_disposable_recovery_01'
  restore.sourceProjectRef = PRODUCTION_REF
  restore.environment = 'disposable'
  restore.capturedAt = '2026-10-30T11:50:00.000Z'
  restore.cronJobs.forEach((job) => { job.active = false })
  return { source, restore }
}

function run(change) {
  const { source, restore } = fixtures()
  change?.(source, restore)
  return verifyRecoverySnapshots({ targetRef: PRODUCTION_REF, source, restore, expected, now })
}

test('accepts a structurally identical offline 282 source and inactive disposable restore, without closing Q019', () => {
  const result = run()
  assert.deepEqual(result, {
    status: 'offline_snapshot_consistent', targetRef: PRODUCTION_REF,
    sourceMigrationHead: '20261102010000', migrationCount: 320,
    cronCount: 18, storageObjectCount: 2, vaultSecretCount: 1,
    allDisposableCronInactive: true, q019Closed: false,
    remaining: 'Verify capture provenance, encrypted off-site retention, hosted recovery path, Auth/settings/secrets and independent restore before production SQL.',
  })
})

test('accepts independently serialized objects with equivalent keys in another order', () => {
  const result = run((_, restore) => {
    const client = restore.identities.clients
    restore.identities.clients = { idsSha256: client.idsSha256, count: client.count }
    const migration = restore.migrations[0]
    restore.migrations[0] = { statementsSha256: migration.statementsSha256,
      name: migration.name, version: migration.version }
    const job = restore.cronJobs[0]
    restore.cronJobs[0] = { active: false, definitionSha256: job.definitionSha256,
      name: job.name }
  })
  assert.equal(result.status, 'offline_snapshot_consistent')
})

test('rejects a wrong explicit target or forged source/restore project identity', () => {
  const { source, restore } = fixtures()
  assert.throws(() => verifyRecoverySnapshots({ targetRef: 'vmmertwoboqiazcsougw', source, restore, expected, now }), /target ref/)
  assert.throws(() => run((s) => { s.projectRef = 'vmmertwoboqiazcsougw' }), /project identity/)
  assert.throws(() => run((_, r) => { r.sourceProjectRef = 'vmmertwoboqiazcsougw' }), /project identity/)
  assert.throws(() => run((_, r) => { r.projectRef = PRODUCTION_REF }), /project identity/)
  assert.throws(() => run((_, r) => { r.environment = 'production' }), /environment identity/)
})

test('requires every tracked migration, its order, current head and stored SQL digest state', () => {
  assert.throws(() => run((s) => { s.migrations.pop() }), /full migration history count/)
  assert.throws(() => run((s) => { s.migrations[13].name = 'changed' }), /migration version\/name/)
  assert.throws(() => run((_, r) => { r.migrations[21].statementsSha256 = d('3') }), /Full migration history/)
  assert.throws(() => run((_, r) => { r.migrations[0].statementsSha256 = d('3') }), /stored-SQL availability/)
})

test('rejects Auth and client count or sorted-UUID digest drift', () => {
  assert.throws(() => run((_, r) => { r.identities.authUsers.count++ }), /Client\/Auth identity/)
  assert.throws(() => run((_, r) => { r.identities.clients.idsSha256 = d('4') }), /Client\/Auth identity/)
  assert.throws(() => run((s) => { s.identities.clients.idsSha256 = 'not-a-digest' }), /SHA-256 digest/)
})

test('requires separate Storage metadata, bucket and object-byte evidence', () => {
  assert.throws(() => run((_, r) => { r.storage.objectCount++ }), /Storage object bytes are incomplete/)
  assert.throws(() => run((_, r) => {
    r.storage.objectCount++
    r.storage.byteCount++
  }), /Storage object count/)
  assert.throws(() => run((_, r) => { r.storage.bucketCount++ }), /Storage bucket count/)
  assert.throws(() => run((_, r) => { r.storage.bucketConfigSha256 = d('5') }), /Storage bucket configuration/)
  assert.throws(() => run((_, r) => { r.storage.byteManifestSha256 = d('6') }), /Storage byte manifest/)
  assert.throws(() => run((s) => { s.storage.byteCount = 0 }), /Storage object bytes are incomplete/)
  assert.throws(() => run((s, r) => {
    s.storage.objectCount = r.storage.objectCount = 0
    s.storage.byteCount = r.storage.byteCount = 0
  }), /empty Storage object manifest/)
})

test('matching Storage byte-manifest digest cannot hide changed physical metadata', () => {
  assert.throws(() => run((_, restore) => {
    restore.storage.objectMetadataSha256 = d('5')
  }), /Storage object metadata differs despite matching byte manifest/)
})

test('matching Storage row metadata cannot hide a changed byte-manifest digest', () => {
  assert.throws(() => run((_, restore) => {
    restore.storage.byteManifestSha256 = d('6')
  }), /Storage byte manifest differs/)
})

test('requires Vault secret inventory and decryption, including on the disposable target', () => {
  assert.throws(() => run((_, r) => { r.vault.secretCount++ }), /Vault decryption is incomplete/)
  assert.throws(() => run((_, r) => { r.vault.secretIdsSha256 = d('7') }), /Vault secret counts/)
  assert.throws(() => run((_, r) => { r.vault.decryptableCount = 0 }), /Vault decryption is incomplete/)
  assert.throws(() => run((s, r) => {
    s.vault.secretCount = r.vault.secretCount = 0
    s.vault.decryptableCount = r.vault.decryptableCount = 0
  }), /empty Vault manifest/)
})

test('requires the reviewed cron count and exact definitions, and never accepts an active disposable job', () => {
  assert.throws(() => run((s) => { s.cronJobs.pop() }), /cron count differs/)
  assert.throws(() => run((_, r) => { r.cronJobs[0].active = true }), /active cron job/)
  assert.throws(() => run((_, r) => { r.cronJobs[0].definitionSha256 = d('8') }), /Cron name or definition/)
  assert.throws(() => run((_, r) => { r.cronJobs[0].name = r.cronJobs[1].name }), /duplicated/)
})

test('accepts an intentionally inactive source cron job while requiring the restore inactive', () => {
  const result = run((source) => { source.cronJobs[0].active = false })
  assert.equal(result.allDisposableCronInactive, true)
})

test('rejects snapshots containing raw commands, secrets or other undocumented fields', () => {
  assert.throws(() => run((s) => { s.cronJobs[0].command = 'select something' }), /aggregate fields/)
  assert.throws(() => run((s) => { s.vault.decryptedSecret = 'sensitive' }), /aggregate fields/)
  assert.throws(() => run((s) => { s.identities.authUsers.email = 'example@test.invalid' }), /aggregate fields/)
})

test('accepts empty Storage and Vault only with consistent empty digests and zero bytes', () => {
  const result = run((s, r) => {
    for (const snapshot of [s, r]) {
      snapshot.storage.objectCount = snapshot.storage.byteCount = 0
      snapshot.storage.objectMetadataSha256 = snapshot.storage.byteManifestSha256 = EMPTY_SHA256
      snapshot.vault.secretCount = snapshot.vault.decryptableCount = 0
      snapshot.vault.secretIdsSha256 = EMPTY_SHA256
    }
  })
  assert.equal(result.storageObjectCount, 0)
  assert.equal(result.vaultSecretCount, 0)
})

test('rejects a restore capture older than its source or a future timestamp', () => {
  assert.throws(() => run((_, r) => { r.capturedAt = '2026-10-30T11:00:00.000Z' }), /predates/)
  assert.throws(() => run((s) => { s.capturedAt = '2026-10-31T11:00:00.000Z' }), /nonfuture/)
  assert.throws(() => run((s) => { s.capturedAt = '2026-10-30 11:40:00' }), /ISO UTC timestamp/)
  assert.throws(() => run((s) => { s.capturedAt = '2026-10-30T11:40:00+00:00' }), /ISO UTC timestamp/)
  assert.throws(() => run((s) => { s.capturedAt = '2026-02-31T11:40:00.000Z' }), /ISO UTC timestamp/)
})

test('CLI reads only explicit files and emits a non-closing aggregate receipt', () => {
  const privateFixtureDir = mkdtempSync(join(tmpdir(), 'aa-q019-offline-'))
  try {
    const { source, restore } = fixtures()
    source.capturedAt = new Date(Date.now() - 120000).toISOString()
    restore.capturedAt = new Date(Date.now() - 60000).toISOString()
    const sourcePath = join(privateFixtureDir, 'source.json')
    const restorePath = join(privateFixtureDir, 'restore.json')
    writeFileSync(sourcePath, JSON.stringify(source))
    writeFileSync(restorePath, JSON.stringify(restore))
    const script = fileURLToPath(new URL('./production-recovery-preflight.mjs', import.meta.url))
    const invocation = [script, '--target-ref', PRODUCTION_REF,
      '--source-snapshot', sourcePath, '--restore-snapshot', restorePath]
    const valid = spawnSync(process.execPath, invocation, { encoding: 'utf8' })
    assert.equal(valid.status, 0, valid.stderr)
    assert.equal(JSON.parse(valid.stdout).q019Closed, false)
    assert.doesNotMatch(valid.stdout, /job-01|client_ids|authUsers/)
    const wrong = spawnSync(process.execPath,
      [script, '--target-ref', 'vmmertwoboqiazcsougw',
        '--source-snapshot', sourcePath, '--restore-snapshot', restorePath],
      { encoding: 'utf8' })
    assert.equal(wrong.status, 1)
    assert.match(wrong.stderr, /target ref/)
    writeFileSync(sourcePath, '{"secret":"raw-private-fragment",')
    const malformed = spawnSync(process.execPath, invocation, { encoding: 'utf8' })
    assert.equal(malformed.status, 1)
    assert.match(malformed.stderr, /Invalid aggregate snapshot JSON/)
    assert.doesNotMatch(malformed.stderr, /raw-private-fragment/)
  } finally {
    rmSync(privateFixtureDir, { recursive: true, force: true })
  }
})
