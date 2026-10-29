import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync,
  writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'node:test'

const repository = resolve()
const script = join(repository, 'scripts', 'prepare-schema-replay.mjs')
const sourceConfig = join(repository, 'supabase', 'config.toml')

test('preparation refuses repository and nonempty destinations without touching source', () => {
  const before = readFileSync(sourceConfig)
  const scratch = mkdtempSync(join(tmpdir(), 'aa-schema-negative-'))
  try {
    const sourceAlias = join(scratch, 'source-alias')
    symlinkSync(join(repository, 'supabase'), sourceAlias, 'dir')
    for (const destination of [repository, join(repository, 'supabase'), sourceAlias, scratch]) {
      if (destination === scratch) writeFileSync(join(scratch, 'keep.txt'), 'keep')
      const result = spawnSync(process.execPath,
        [script, destination, 'aa_schema_ci_negative', '55320'],
        { cwd: repository, encoding: 'utf8' })
      assert.notEqual(result.status, 0, `unexpectedly accepted ${destination}`)
    }
    assert.deepEqual(readFileSync(sourceConfig), before)
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
})

test('raw Auth source mode copies historical migration 11 byte-for-byte', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'aa-schema-auth-source-'))
  try {
    const fakeRepository = join(scratch, 'repository')
    const fakeSupabase = join(fakeRepository, 'supabase')
    const migrations = join(fakeSupabase, 'migrations')
    const verification = join(fakeSupabase, 'verification')
    const destination = join(scratch, 'destination')
    for (const path of [migrations, verification, destination]) {
      mkdirSync(path, { recursive: true })
    }
    writeFileSync(join(fakeSupabase, 'config.toml'), readFileSync(sourceConfig))
    writeFileSync(join(verification, 'released-migration-version.txt'), '20261025233000\n')
    writeFileSync(join(migrations,
      '20261025233000_259_released.sql'), '-- fixture release marker\n')
    writeFileSync(join(migrations,
      '20261025235000_260_google_ads.sql'), '-- fixture dependency marker\n')
    const authFile = '20260903105742_11_auth_users_and_role_metadata.sql'
    const source = readFileSync(join(repository, 'supabase', 'migrations', authFile))
    writeFileSync(join(migrations, authFile), source)

    const result = spawnSync(process.execPath,
      [script, destination, 'aa_schema_ci_raw_auth', '55320'],
      { cwd: fakeRepository, encoding: 'utf8',
        env: { ...process.env, AA_SCHEMA_REPLAY_RAW_SOURCE: '1' } })
    assert.equal(result.status, 0, result.stderr)
    assert.deepEqual(readFileSync(join(destination, 'supabase', 'migrations', authFile)), source)
    assert.deepEqual(JSON.parse(result.stdout).fixture, false)
    assert.deepEqual(JSON.parse(result.stdout).authSourceReplay, true)
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
})
