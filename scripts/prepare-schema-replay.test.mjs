import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
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
