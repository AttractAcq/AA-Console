import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const script = resolve(fileURLToPath(new URL('.', import.meta.url)), 'assert-current-deploy-sha.sh')
const schemaGate = resolve(fileURLToPath(new URL('.', import.meta.url)), 'require-released-schema.mjs')

function run(cmd, args, cwd) {
  const result = spawnSync(cmd, args, { cwd, encoding: 'utf8' })
  assert.equal(result.status, 0, `${cmd} ${args.join(' ')}: ${result.stderr || result.stdout}`)
  return result.stdout.trim()
}

test('Pages guard accepts only the current, checked-out CI-tested main SHA', () => {
  const root = mkdtempSync(join(tmpdir(), 'aa-pages-gate-'))
  const remote = join(root, 'remote.git')
  const checkout = join(root, 'checkout')
  try {
    run('git', ['init', '--bare', '--initial-branch=main', remote], root)
    run('git', ['init', '-b', 'main', checkout], root)
    run('git', ['remote', 'add', 'origin', remote], checkout)
    writeFileSync(join(checkout, 'candidate.txt'), 'first\n')
    run('git', ['add', 'candidate.txt'], checkout)
    run('git', ['-c', 'user.name=Pages Test', '-c', 'user.email=pages@example.invalid',
      'commit', '-m', 'first'], checkout)
    run('git', ['push', '-u', 'origin', 'main'], checkout)
    const first = run('git', ['rev-parse', 'HEAD'], checkout)

    const good = spawnSync('bash', [script, first], { cwd: checkout, encoding: 'utf8' })
    assert.equal(good.status, 0, good.stderr || good.stdout)

    writeFileSync(join(checkout, 'candidate.txt'), 'second\n')
    run('git', ['add', 'candidate.txt'], checkout)
    run('git', ['-c', 'user.name=Pages Test', '-c', 'user.email=pages@example.invalid',
      'commit', '-m', 'second'], checkout)
    run('git', ['push', 'origin', 'main'], checkout)
    const second = run('git', ['rev-parse', 'HEAD'], checkout)
    run('git', ['checkout', '--detach', first], checkout)

    const stale = spawnSync('bash', [script, first], { cwd: checkout, encoding: 'utf8' })
    assert.equal(stale.status, 1)
    assert.match(stale.stdout, /newer main commit/)

    const wrongCheckout = spawnSync('bash', [script, second], { cwd: checkout, encoding: 'utf8' })
    assert.equal(wrongCheckout.status, 1)
    assert.match(wrongCheckout.stdout, /checked-out code differs/)

    const invalid = spawnSync('bash', [script, 'not-a-sha'], { cwd: checkout, encoding: 'utf8' })
    assert.equal(invalid.status, 1)
    assert.match(invalid.stdout, /no full tested commit SHA/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('Pages schema gate rejects an unreleased migration and accepts its advanced marker', () => {
  const root = mkdtempSync(join(tmpdir(), 'aa-pages-schema-gate-'))
  const migrations = join(root, 'supabase', 'migrations')
  const verification = join(root, 'supabase', 'verification')
  try {
    mkdirSync(migrations, { recursive: true })
    mkdirSync(verification, { recursive: true })
    writeFileSync(join(migrations, '20261025233000_259_released.sql'), '-- released\n')
    writeFileSync(join(migrations, '20261025235000_260_building_the_google_campaign.sql'), '-- pending\n')
    const marker = join(verification, 'released-migration-version.txt')
    writeFileSync(marker, '20261025233000\n')
    const pending = spawnSync(process.execPath, [schemaGate], { cwd: root, encoding: 'utf8' })
    assert.equal(pending.status, 1)
    assert.match(pending.stderr, /1 tracked migration/)

    writeFileSync(marker, '20261025235000\n')
    const released = spawnSync(process.execPath, [schemaGate], { cwd: root, encoding: 'utf8' })
    assert.equal(released.status, 0, released.stderr)
    assert.match(released.stdout, /marker matches tracked head/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
