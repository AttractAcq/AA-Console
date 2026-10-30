#!/usr/bin/env node

// This builds an isolated migration workspace for staging's two historical
// alternate stamps. It never links to or writes a Supabase project. The
// capture and verify commands use only the Management API read-only route.
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync,
  realpathSync, statSync, writeFileSync } from 'node:fs'
import { resolve, join, sep } from 'node:path'
// Invoke from the repository root, as with the other schema scripts.
const repository = resolve()
const sourceDir = join(repository, 'supabase')
const baselinePath = join(sourceDir, 'staging-reconciliation', 'catalog-baseline.json')
const correctionName = '20261026000000_260_staging_google_reconcile.sql'
const correctionPath = join(sourceDir, 'staging-reconciliation', correctionName)
const boundaryVersion = '20261030100000'
const finalBoundaryVersion = '20261030160000'
const stagingRef = 'vmmertwoboqiazcsougw'
const aliases = [
  ['20261025240000', '259_which_client_a_message_belongs_to'],
  ['20261025250000', '260_building_the_google_campaign'],
]
const maxSnapshotAgeMs = 15 * 60 * 1000
const historyQuery = `select version, name, statements is null as sql_payload_unavailable
  from supabase_migrations.schema_migrations order by version;`
const identityQuery = `select
  (select count(*) from public.clients) as clients,
  (select md5(coalesce(string_agg(id::text, ',' order by id), ''))
     from public.clients) as client_ids_md5,
  (select count(*) from auth.users) as auth_users,
  (select md5(coalesce(string_agg(id::text, ',' order by id), ''))
     from auth.users) as auth_user_ids_md5;`

export const sha256 = (value) => createHash('sha256').update(value).digest('hex')
export const rowDigest = (rows) => sha256(JSON.stringify(rows))

function fail(message) { throw new Error(message) }
function loadJson(path) { return JSON.parse(readFileSync(path, 'utf8')) }
function namedArg(name) {
  const at = process.argv.indexOf(`--${name}`)
  if (at < 0 || !process.argv[at + 1]) fail(`Missing --${name}`)
  return process.argv[at + 1]
}

export function parsePreflightQueries(sql) {
  const markers = [...sql.matchAll(/^-- (P\d{2})\./gm)]
  if (markers.length !== 20) fail(`Expected P01–P20, found ${markers.length}`)
  return markers.map((match, index) => {
    const next = markers[index + 1]?.index ?? sql.length
    const query = sql.slice(match.index, next).replace(/^--.*$/gm, '').trim()
    if (!/^select\b/i.test(query) || !query.endsWith(';') ||
        (query.match(/;/g) ?? []).length !== 1) {
      fail(`Preflight ${match[1]} must contain exactly one SELECT`)
    }
    return { id: match[1], query }
  })
}

async function readOnlyQuery(token, query) {
  const response = await fetch(
    `https://api.supabase.com/v1/projects/${stagingRef}/database/query/read-only`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query }),
      signal: AbortSignal.timeout(40000),
    })
  if (!response.ok) fail(`Read-only preflight failed with HTTP ${response.status}`)
  const rows = await response.json()
  if (!Array.isArray(rows)) fail('Read-only preflight returned a non-array result')
  return rows
}

export async function capture() {
  const token = process.env.AA_SCHEMA_PARITY_READ_TOKEN
  if (!token) fail('AA_SCHEMA_PARITY_READ_TOKEN is required; use a Database Read PAT')
  const sql = readFileSync(
    join(repository, 'docs', 'staging-259-272-reconciliation-preflight.sql'), 'utf8')
  const checks = []
  for (const { id, query } of parsePreflightQueries(sql)) {
    checks.push({ id, rows: await readOnlyQuery(token, query) })
  }
  const history = await readOnlyQuery(token, historyQuery)
  const identity = await readOnlyQuery(token, identityQuery)
  if (identity.length !== 1) fail('Identity digest query returned an unexpected row count')
  return { projectRef: stagingRef, capturedAt: new Date().toISOString(),
    transport: 'supabase-management-read-only', checks, history, identity: identity[0] }
}

export function verifySnapshot(snapshot, baseline, now = Date.now()) {
  if (baseline.stagingProjectRef !== stagingRef ||
      baseline.history?.rowCount !== 277) {
    fail('Reviewed staging baseline has an unexpected project or history count')
  }
  if (snapshot.projectRef !== stagingRef ||
      snapshot.transport !== 'supabase-management-read-only') {
    fail('Snapshot is not a read-only capture of the pinned staging project')
  }
  const capturedAt = Date.parse(snapshot.capturedAt)
  if (!Number.isFinite(capturedAt) || capturedAt > now + 30000 ||
      now - capturedAt > maxSnapshotAgeMs) {
    fail('Snapshot is stale or has an invalid capture time; capture again')
  }
  if (!Array.isArray(snapshot.checks) || snapshot.checks.length !== 20) {
    fail('Snapshot must contain exactly P01–P20')
  }
  for (let i = 0; i < 20; i++) {
    const item = snapshot.checks[i]
    const id = `P${String(i + 1).padStart(2, '0')}`
    if (item.id !== id || !Array.isArray(item.rows)) fail(`Missing ${id} rows`)
    if (id !== 'P01') {
      const expected = baseline.checks[id]
      if (!expected || item.rows.length !== expected.rowCount ||
          rowDigest(item.rows) !== expected.sha256) {
        fail(`${id} differs from the reviewed staging catalog/data baseline`)
      }
    }
  }
  const history = snapshot.history
  if (!Array.isArray(history) || history.length !== 277 ||
      rowDigest(history) !== baseline.history.sha256) {
    fail('Full staging migration history differs from the reviewed 277-row baseline')
  }
  if (history.filter(row => row.sql_payload_unavailable).length !== 277) {
    fail('Historical SQL payload availability changed')
  }
  for (const [version, name] of aliases) {
    if (!history.some(row => row.version === version && row.name === name)) {
      fail(`Alternate historical version ${version} is absent`)
    }
  }
  for (const version of ['20261025233000', '20261025235000']) {
    if (history.some(row => row.version === version)) {
      fail(`Canonical ${version} unexpectedly exists in staging history`)
    }
  }
  const identity = snapshot.identity
  if (!identity || Number(identity.clients) !== 1 || Number(identity.auth_users) !== 5 ||
      !/^[0-9a-f]{32}$/.test(identity.client_ids_md5) ||
      !/^[0-9a-f]{32}$/.test(identity.auth_user_ids_md5)) {
    fail('Retained client/Auth identity digest is absent or unexpected')
  }
  return { projectRef: stagingRef, capturedAt: snapshot.capturedAt,
    historyRows: history.length, catalogChecks: 19,
    baselineSha256: sha256(JSON.stringify(baseline)) }
}

function migrationInventory() {
  const names = readdirSync(join(sourceDir, 'migrations'))
    .filter(name => /^\d{14}_.+\.sql$/.test(name)).sort()
  const canonical259 = names.find(name => name.startsWith('20261025233000_'))
  const canonical260 = names.find(name => name.startsWith('20261025235000_'))
  if (!canonical259 || !canonical260 ||
      !names.some(name => name.startsWith(`${boundaryVersion}_272_`)) ||
      !names.some(name => name.startsWith(`${finalBoundaryVersion}_279_`))) {
    fail('Source migration boundary changed; review and repin the workspace')
  }
  return { names, canonical259, canonical260 }
}

function destinationIsSafe(destination) {
  if (!existsSync(destination) || !statSync(destination).isDirectory() ||
      readdirSync(destination).length !== 0) fail('Destination must be an existing empty directory')
  const actual = realpathSync(destination)
  if (actual === repository || actual === sourceDir ||
      actual.startsWith(sourceDir + sep) || sourceDir.startsWith(actual + sep)) {
    fail('Destination may not be the source repository, its supabase directory or an ancestor')
  }
}

function isolatedConfig(projectId, portBase) {
  let config = readFileSync(join(sourceDir, 'config.toml'), 'utf8')
  config = config.replace(/^project_id = "[^"]+"$/m, `project_id = "${projectId}"`)
  if (!config.includes(`project_id = "${projectId}"`)) fail('Could not isolate project ID')
  for (const [original, offset] of [[54320, 0], [54321, 1], [54322, 2], [54323, 3],
                                    [54324, 4], [54327, 7], [54329, 9], [8083, 10]]) {
    const pattern = new RegExp(`^(port|shadow_port|inspector_port) = ${original}$`, 'm')
    if (!pattern.test(config)) fail(`Could not isolate port ${original}`)
    config = config.replace(pattern, (_, key) => `${key} = ${portBase + offset}`)
  }
  config = config.replace(/(\[db\.seed\]\s*\n(?:#[^\n]*\n)*)enabled = true/, '$1enabled = false')
  if (!/\[db\.seed\]\s*\n(?:#[^\n]*\n)*enabled = false/.test(config)) {
    fail('Could not disable local seed.sql')
  }
  config = config.replace('[analytics]\nenabled = true', '[analytics]\nenabled = false')
  if (!config.includes('[analytics]\nenabled = false')) {
    fail('Could not disable disposable analytics/Vector service')
  }
  return config
}

export function prepare(snapshot, baseline, destination, projectId, portBase) {
  const verified = verifySnapshot(snapshot, baseline)
  if (!/^aa_staging_rehearsal_[a-z0-9_]+$/.test(projectId)) {
    fail('Project ID must be aa_staging_rehearsal_<id>')
  }
  if (!Number.isInteger(portBase) || portBase < 20000 || portBase > 61970) {
    fail('Port base must be an integer from 20000 to 61970')
  }
  destinationIsSafe(destination)
  const { names, canonical259, canonical260 } = migrationInventory()
  const localOlder = names.filter(name => name.slice(0, 14) < '20261025233000')
  const expectedOlder = snapshot.history.filter(row => row.version < '20261025240000')
  if (localOlder.length !== 275 || expectedOlder.length !== 275 ||
      localOlder.some((name, i) =>
        name.slice(0, 14) !== expectedOlder[i].version ||
        name.slice(15, -4) !== expectedOlder[i].name)) {
    fail('Tracked migrations through 258 differ from staging history')
  }
  // The corrective phase is bounded to 272. The independently reviewed
  // approval-ledger release 273–279 is a separate, explicit third phase.
  const later = names.filter(name => name.slice(0, 14) > '20261025235000' &&
    name.slice(0, 14) <= boundaryVersion)
  if (later.length !== 12) fail('Expected exactly canonical 261–272')
  const post272 = names.filter(name => name.slice(0, 14) > boundaryVersion &&
    name.slice(0, 14) <= finalBoundaryVersion)
  if (post272.length !== 7 ||
      post272.some((name, i) => !name.includes(`_${273 + i}_`))) {
    fail('Expected exactly canonical 273–279')
  }
  const pinnedSources = [canonical259, canonical260, ...later, ...post272,
    correctionName]
  for (const name of pinnedSources) {
    const from = name === correctionName ? correctionPath :
      join(sourceDir, 'migrations', name)
    if (sha256(readFileSync(from)) !== baseline.sourceFiles?.[name]) {
      fail(`Reviewed source bytes changed: ${name}`)
    }
  }
  const manifest = { ...verified, projectId, portBase,
    excludedCanonical: [canonical259, canonical260],
    historicalAliases: aliases.map(([version, name]) => `${version}_${name}.sql`),
    correction: correctionName, selectedMigrations: [correctionName, ...later],
    correctionOnly: { directory: 'correction-only',
      selectedMigrations: [correctionName], projectId: `${projectId}_correction` },
    through279: { directory: 'through-279', selectedMigrations: post272,
      projectId: `${projectId}_through279` },
    sourceFiles: [] }
  const target = join(destination, 'supabase')
  const targetMigrations = join(target, 'migrations')
  mkdirSync(targetMigrations, { recursive: true })
  writeFileSync(join(target, 'config.toml'), isolatedConfig(projectId, portBase))
  const correctionOnly = join(destination, manifest.correctionOnly.directory, 'supabase')
  const correctionOnlyMigrations = join(correctionOnly, 'migrations')
  mkdirSync(correctionOnlyMigrations, { recursive: true })
  writeFileSync(join(correctionOnly, 'config.toml'),
    isolatedConfig(manifest.correctionOnly.projectId, portBase + 20))
  const through279 = join(destination, manifest.through279.directory, 'supabase')
  const through279Migrations = join(through279, 'migrations')
  mkdirSync(through279Migrations, { recursive: true })
  writeFileSync(join(through279, 'config.toml'),
    isolatedConfig(manifest.through279.projectId, portBase + 40))
  for (const name of [...localOlder, ...later, ...post272]) {
    const from = join(sourceDir, 'migrations', name)
    copyFileSync(from, join(through279Migrations, name))
    if (name.slice(0, 14) <= boundaryVersion) {
      copyFileSync(from, join(targetMigrations, name))
    }
    if (name.slice(0, 14) < '20261025233000') {
      copyFileSync(from, join(correctionOnlyMigrations, name))
    }
    if (name.slice(0, 14) > '20261025235000') {
      manifest.sourceFiles.push({ name, sha256: sha256(readFileSync(from)) })
    }
  }
  for (const [version, name] of aliases) {
    const aliasName = `${version}_${name}.sql`
    const placeholder =
      `-- Historical staging stamp. Never execute this placeholder.\n` +
      `do $guard$ begin raise exception 'Historical staging alias ${version} must already be recorded'; end $guard$;\n`
    writeFileSync(join(targetMigrations, aliasName), placeholder)
    writeFileSync(join(correctionOnlyMigrations, aliasName), placeholder)
    writeFileSync(join(through279Migrations, aliasName), placeholder)
  }
  copyFileSync(correctionPath, join(targetMigrations, correctionName))
  copyFileSync(correctionPath, join(correctionOnlyMigrations, correctionName))
  copyFileSync(correctionPath, join(through279Migrations, correctionName))
  manifest.sourceFiles.push({ name: correctionName,
    sha256: sha256(readFileSync(correctionPath)) })
  writeFileSync(join(destination, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n')
  return manifest
}

async function main() {
  const command = process.argv[2]
  if (command === 'capture') {
    console.log(JSON.stringify(await capture()))
  } else if (command === 'verify') {
    const snapshot = loadJson(resolve(namedArg('snapshot')))
    console.log(JSON.stringify(verifySnapshot(snapshot, loadJson(baselinePath))))
  } else if (command === 'prepare') {
    const snapshot = loadJson(resolve(namedArg('snapshot')))
    const destination = resolve(namedArg('destination'))
    const projectId = namedArg('project-id')
    const portBase = Number(namedArg('port-base'))
    console.log(JSON.stringify(prepare(snapshot, loadJson(baselinePath), destination,
      projectId, portBase)))
  } else {
    fail('Usage: staging-reconciliation-workspace.mjs capture | verify --snapshot FILE | prepare --snapshot FILE --destination EMPTY_DIR --project-id aa_staging_rehearsal_ID --port-base PORT')
  }
}

if (process.argv[1]?.endsWith('staging-reconciliation-workspace.mjs')) {
  main().catch(error => { console.error(error.message); process.exitCode = 1 })
}
