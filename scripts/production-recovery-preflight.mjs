#!/usr/bin/env node

// Offline comparison only. This file never connects to Supabase, reads a
// credential, creates a backup, restores data, or changes a live project.
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { fileURLToPath } from 'node:url'

export const PRODUCTION_REF = 'bancbdztffokwiifzoiv'
export const CURRENT_CRON_COUNT = 18
export const EMPTY_SHA256 = createHash('sha256').update('').digest('hex')
const sourceRoot = fileURLToPath(new URL('../', import.meta.url))
const digestPattern = /^[0-9a-f]{64}$/

function fail(message) { throw new Error(message) }
function object(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be an object`)
  return value
}
function exactKeys(value, keys, label) {
  object(value, label)
  const actual = Object.keys(value).sort()
  if (actual.length !== keys.length || actual.some((key, i) => key !== [...keys].sort()[i])) {
    fail(`${label} must contain only the documented aggregate fields`)
  }
}
function count(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) fail(`${label} must be a nonnegative integer`)
}
function digest(value, label) {
  if (typeof value !== 'string' || !digestPattern.test(value)) fail(`${label} must be a SHA-256 digest`)
}
function timestamp(value, label, now) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) {
    fail(`${label} must be a valid, nonfuture ISO UTC timestamp`)
  }
  const parsed = Date.parse(value)
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value || parsed > now + 30000) {
    fail(`${label} must be a valid, nonfuture ISO UTC timestamp`)
  }
  return parsed
}

export function trackedHistory(root = sourceRoot) {
  const marker = readFileSync(join(root, 'supabase/verification/released-migration-version.txt'), 'utf8').trim()
  const migrations = readdirSync(join(root, 'supabase/migrations'))
    .filter((name) => /^\d{14}_.+\.sql$/.test(name) && name.slice(0, 14) <= marker).sort()
  if (migrations.length !== 296 || marker !== '20261030160000' ||
      !migrations.at(-1)?.startsWith(`${marker}_`)) {
    fail('Current production recovery baseline changed; review and repin before use')
  }
  return migrations.map((name) => ({ version: name.slice(0, 14), name: name.slice(15, -4) }))
}

function validateMigrations(rows, expected, label) {
  if (!Array.isArray(rows) || rows.length !== expected.length) fail(`${label} full migration history count differs from tracked release`)
  rows.forEach((row, index) => {
    exactKeys(row, ['version', 'name', 'statementsSha256'], `${label} migration row`)
    if (row.version !== expected[index].version || row.name !== expected[index].name) {
      fail(`${label} migration version/name differs from tracked release at row ${index + 1}`)
    }
    if (row.statementsSha256 !== null) digest(row.statementsSha256, `${label} SQL digest`)
  })
}

function validateIdentities(value, label) {
  exactKeys(value, ['clients', 'authUsers'], `${label} identities`)
  for (const kind of ['clients', 'authUsers']) {
    exactKeys(value[kind], ['count', 'idsSha256'], `${label} ${kind}`)
    count(value[kind].count, `${label} ${kind} count`)
    digest(value[kind].idsSha256, `${label} ${kind} digest`)
    if (value[kind].count === 0 && value[kind].idsSha256 !== EMPTY_SHA256) {
      fail(`${label} ${kind} empty digest is inconsistent`)
    }
  }
}

function validateStorage(value, label) {
  exactKeys(value, ['objectCount', 'objectMetadataSha256', 'bucketCount',
    'bucketConfigSha256', 'byteCount', 'byteManifestSha256'], `${label} Storage`)
  for (const field of ['objectCount', 'bucketCount', 'byteCount']) count(value[field], `${label} ${field}`)
  for (const field of ['objectMetadataSha256', 'bucketConfigSha256', 'byteManifestSha256']) {
    digest(value[field], `${label} ${field}`)
  }
  if (value.byteCount !== value.objectCount) fail(`${label} Storage object bytes are incomplete`)
  if (value.objectCount === 0 &&
      (value.objectMetadataSha256 !== EMPTY_SHA256 || value.byteManifestSha256 !== EMPTY_SHA256)) {
    fail(`${label} empty Storage object manifest is inconsistent`)
  }
  if (value.bucketCount === 0 && value.bucketConfigSha256 !== EMPTY_SHA256) {
    fail(`${label} empty bucket manifest is inconsistent`)
  }
}

function validateVault(value, label) {
  exactKeys(value, ['secretCount', 'secretIdsSha256', 'decryptableCount'], `${label} Vault`)
  count(value.secretCount, `${label} Vault secret count`)
  count(value.decryptableCount, `${label} Vault decryptable count`)
  digest(value.secretIdsSha256, `${label} Vault IDs digest`)
  if (value.decryptableCount !== value.secretCount) fail(`${label} Vault decryption is incomplete`)
  if (value.secretCount === 0 && value.secretIdsSha256 !== EMPTY_SHA256) {
    fail(`${label} empty Vault manifest is inconsistent`)
  }
}

function validateCron(value, label, isRestore) {
  if (!Array.isArray(value) || value.length !== CURRENT_CRON_COUNT) {
    fail(`${label} cron count differs from reviewed 279 baseline`)
  }
  const names = new Set()
  for (const job of value) {
    exactKeys(job, ['name', 'definitionSha256', 'active'], `${label} cron job`)
    if (typeof job.name !== 'string' || !/^[a-z][a-z0-9_-]{0,127}$/.test(job.name) || names.has(job.name)) {
      fail(`${label} cron name is missing, invalid, or duplicated`)
    }
    names.add(job.name)
    digest(job.definitionSha256, `${label} cron definition`)
    if (typeof job.active !== 'boolean') fail(`${label} cron active flag must be boolean`)
    if (isRestore && job.active) fail('Disposable restore has an active cron job; external effects are unsafe')
  }
}

function validateSnapshot(snapshot, label, now, expected, isRestore) {
  exactKeys(snapshot, isRestore
    ? ['schemaVersion', 'projectRef', 'sourceProjectRef', 'environment', 'capturedAt',
        'migrations', 'identities', 'storage', 'vault', 'cronJobs']
    : ['schemaVersion', 'projectRef', 'environment', 'capturedAt',
        'migrations', 'identities', 'storage', 'vault', 'cronJobs'], label)
  if (snapshot.schemaVersion !== 1) fail(`${label} snapshot schema version is unsupported`)
  if (typeof snapshot.projectRef !== 'string' || !/^[a-z0-9_-]{8,80}$/.test(snapshot.projectRef)) {
    fail(`${label} project identity is invalid`)
  }
  if (snapshot.environment !== (isRestore ? 'disposable' : 'production')) {
    fail(`${label} environment identity is invalid`)
  }
  const capturedAt = timestamp(snapshot.capturedAt, `${label} capturedAt`, now)
  validateMigrations(snapshot.migrations, expected, label)
  validateIdentities(snapshot.identities, label)
  validateStorage(snapshot.storage, label)
  validateVault(snapshot.vault, label)
  validateCron(snapshot.cronJobs, label, isRestore)
  return capturedAt
}

function same(a, b, label) {
  if (!isDeepStrictEqual(a, b)) fail(`${label} differs between source and disposable restore`)
}

export function verifyRecoverySnapshots({ targetRef, source, restore, expected = trackedHistory(), now = Date.now() }) {
  if (targetRef !== PRODUCTION_REF) fail('Explicit target ref is not the reviewed production project')
  const sourceTime = validateSnapshot(source, 'Production', now, expected, false)
  const restoreTime = validateSnapshot(restore, 'Disposable', now, expected, true)
  if (source.projectRef !== targetRef || restore.sourceProjectRef !== targetRef ||
      restore.projectRef === targetRef) fail('Source or disposable project identity does not match the target')
  if (restoreTime < sourceTime) fail('Disposable restore snapshot predates production source snapshot')
  same(source.migrations, restore.migrations, 'Full migration history and stored-SQL availability')
  same(source.identities, restore.identities, 'Client/Auth identity counts and UUID digests')
  same(source.storage, restore.storage, 'Storage metadata, bucket configuration and byte manifest')
  same(source.vault, restore.vault, 'Vault secret counts, IDs and decryption counts')
  const sourceCron = new Map(source.cronJobs.map(({ name, definitionSha256 }) => [name, definitionSha256]))
  for (const job of restore.cronJobs) {
    if (sourceCron.get(job.name) !== job.definitionSha256) {
      fail('Cron name or definition differs between source and disposable restore')
    }
  }
  return {
    status: 'offline_snapshot_consistent',
    targetRef,
    sourceMigrationHead: source.migrations.at(-1).version,
    migrationCount: source.migrations.length,
    cronCount: source.cronJobs.length,
    storageObjectCount: source.storage.objectCount,
    vaultSecretCount: source.vault.secretCount,
    allDisposableCronInactive: true,
    q019Closed: false,
    remaining: 'Verify capture provenance, encrypted off-site retention, hosted recovery path, Auth/settings/secrets and independent restore before production SQL.',
  }
}

function args(argv) {
  const allowed = new Set(['--target-ref', '--source-snapshot', '--restore-snapshot'])
  const values = {}
  for (let i = 0; i < argv.length; i += 2) {
    if (!allowed.has(argv[i]) || !argv[i + 1] || values[argv[i]]) fail('Usage: --target-ref REF --source-snapshot FILE --restore-snapshot FILE')
    values[argv[i]] = argv[i + 1]
  }
  if (Object.keys(values).length !== allowed.size) fail('Usage: --target-ref REF --source-snapshot FILE --restore-snapshot FILE')
  return values
}

function readAggregateSnapshot(path) {
  let data
  try { data = readFileSync(path, 'utf8') } catch { fail('Could not read aggregate snapshot file') }
  try { return JSON.parse(data) } catch { fail('Invalid aggregate snapshot JSON') }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    const options = args(process.argv.slice(2))
    const source = readAggregateSnapshot(options['--source-snapshot'])
    const restore = readAggregateSnapshot(options['--restore-snapshot'])
    process.stdout.write(JSON.stringify(verifyRecoverySnapshots({
      targetRef: options['--target-ref'], source, restore,
    }), null, 2) + '\n')
  } catch (error) {
    process.stderr.write(`Production recovery preflight failed: ${error.message}\n`)
    process.exitCode = 1
  }
}
