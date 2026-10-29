#!/usr/bin/env node

// Build a throwaway local Supabase project. Never copy supabase/.temp: it can
// contain the ref of a linked production project.
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync,
  statSync, writeFileSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { assertSchemaMigrationOrder } from './schema-migration-order.mjs'

const [destinationArg, projectId, portBaseArg] = process.argv.slice(2)
if (!destinationArg || !/^aa_schema_ci_[a-z0-9_]+$/.test(projectId ?? '')) {
  throw new Error('Usage: prepare-schema-replay.mjs <empty-dir> aa_schema_ci_<id> <port-base>')
}
const portBase = Number(portBaseArg)
if (!Number.isInteger(portBase) || portBase < 20000 || portBase > 62000) {
  throw new Error('Port base must be an integer from 20000 to 62000')
}

const repository = resolve()
const source = join(repository, 'supabase')
const destination = resolve(destinationArg)
if (!existsSync(destination) || !statSync(destination).isDirectory()) {
  throw new Error('Destination must be an existing empty directory')
}
const actualDestination = realpathSync(destination)
if (actualDestination === repository || actualDestination === source ||
    actualDestination.startsWith(source + sep) || source.startsWith(actualDestination + sep)) {
  throw new Error('Destination must not be the source repository, its supabase directory, or an ancestor')
}
if (readdirSync(destination).length !== 0) {
  throw new Error('Destination must be empty')
}
const migrations = readdirSync(join(source, 'migrations'))
  .filter((name) => /^\d{14}_.+\.sql$/.test(name)).sort()
if (migrations.length === 0) throw new Error('No tracked migrations found')

const releasedVersion = readFileSync(join(source, 'verification', 'released-migration-version.txt'), 'utf8').trim()
if (!/^\d{14}$/.test(releasedVersion) ||
    !migrations.some((name) => name.startsWith(`${releasedVersion}_`))) {
  throw new Error('Released migration version must name a tracked migration')
}
if (releasedVersion > migrations.at(-1).slice(0, 14)) {
  throw new Error('Released migration version exceeds the migration head')
}
assertSchemaMigrationOrder(migrations, releasedVersion)

const target = join(destination, 'supabase')
mkdirSync(join(target, 'migrations'), { recursive: true })
let config = readFileSync(join(source, 'config.toml'), 'utf8')
config = config.replace(/^project_id = "[^"]+"$/m, `project_id = "${projectId}"`)
if (!config.includes(`project_id = "${projectId}"`)) throw new Error('Could not set isolated project ID')
for (const [original, offset] of [[54320, 0], [54321, 1], [54322, 2], [54323, 3],
                                  [54324, 4], [54327, 7], [54329, 9], [8083, 10]]) {
  const pattern = new RegExp(`^(port|shadow_port|inspector_port) = ${original}$`, 'm')
  if (!pattern.test(config)) throw new Error(`Could not isolate port ${original}`)
  config = config.replace(pattern, (_, key) => `${key} = ${portBase + offset}`)
}
config = config.replace(/(\[db\.seed\]\s*\n(?:#[^\n]*\n)*)enabled = true/, '$1enabled = false')
if (!/\[db\.seed\]\s*\n(?:#[^\n]*\n)*enabled = false/.test(config)) {
  throw new Error('Could not disable local seed.sql in copied config')
}
writeFileSync(join(target, 'config.toml'), config)

const seedMigration = migrations.find((name) => name.endsWith('_11_auth_users_and_role_metadata.sql'))
const rawAuthSource = process.env.AA_SCHEMA_REPLAY_RAW_SOURCE === '1'
for (const name of migrations) {
  const input = join(source, 'migrations', name)
  const output = join(target, 'migrations', name)
  if (name !== seedMigration || rawAuthSource) {
    cpSync(input, output)
    continue
  }
  let sql = readFileSync(input, 'utf8')
  if (sql.includes("current_setting('app.seed_admin_password'")) {
    // Retained temporarily for comparison with the B003 replay gate. CI uses
    // AA_SCHEMA_REPLAY_RAW_SOURCE=1 and copies the corrected source unchanged;
    // remove this fixture after that full clean/upgrade replay passes.
    // Fixture values are generated inside Postgres and never printed by CI.
    const marker = 'create extension if not exists pgcrypto with schema extensions;'
    if (!sql.includes(marker)) throw new Error('Seed migration changed; review CI fixture insertion')
    const fixture = `\n-- CI-only, per-run synthetic passwords. Retire after raw-source replay passes.\n` +
      ['admin', 'client', 'employee'].map((role) =>
        `select set_config('app.seed_${role}_password', encode(extensions.gen_random_bytes(24), 'hex'), false);`
      ).join('\n') + '\n'
    sql = sql.replace(marker, marker + fixture)
  }
  writeFileSync(output, sql)
}

console.log(JSON.stringify({ projectId, portBase, migrations: migrations.length,
  releasedVersion, headVersion: migrations.at(-1).slice(0, 14),
  fixture: Boolean(seedMigration && !rawAuthSource), authSourceReplay: rawAuthSource }))
