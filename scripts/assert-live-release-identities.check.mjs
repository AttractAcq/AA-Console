import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import {
  assertComponentPins,
  assertLiveIdentity,
  loadReleaseManifest,
  probeLiveIdentity,
  validateManifest,
  validateProbeToken,
  waitForLiveIdentity,
} from './assert-live-release-identities.mjs'

const runtimeSha = 'a'.repeat(40)
const gatewaySha = 'b'.repeat(40)
const migrationHead = '20261030160000'
const token = 'a1'.repeat(32)
const manifest = { schemaVersion: 1, runtimeSha, gatewaySha, migrationHead }
const live = () => ({
  ...manifest, observationsComplete: true, observedAt: new Date().toISOString(), reason: null,
})

test('exact, recent live identities pass; mismatches and partial observations fail closed', () => {
  assert.deepEqual(validateManifest(manifest), manifest)
  assert.doesNotThrow(() => assertLiveIdentity(live(), manifest))
  for (const bad of [
    { ...live(), runtimeSha: 'c'.repeat(40) },
    { ...live(), gatewaySha: 'c'.repeat(40) },
    { ...live(), migrationHead: '20261030160001' },
    { ...live(), observationsComplete: false },
    { ...live(), observedAt: '2020-01-01T00:00:00.000Z' },
    { ...live(), reason: 'gateway_unavailable' },
    { ...live(), runtimeSha: 'a'.repeat(12) },
  ]) assert.throws(() => assertLiveIdentity(bad, manifest))
  assert.throws(() => validateManifest({ ...manifest, gatewaySha: 'b'.repeat(12) }))
})

test('bounded live probe refuses 503, malformed body and a transport that never resolves', async () => {
  const response = (body, status = 200) => new Response(JSON.stringify(body), { status })
  await probeLiveIdentity(manifest, async () => response(live()), { token })
  await assert.rejects(() => probeLiveIdentity(manifest, async () => response(live(), 201), { token }), /HTTP 201/)
  await assert.rejects(() => probeLiveIdentity(manifest, async () => response(live(), 503), { token }), /HTTP 503/)
  await assert.rejects(() => probeLiveIdentity(manifest, async () => response({ ...live(), gatewaySha: null }), { token }))
  await assert.rejects(() => probeLiveIdentity(manifest, async () => new Response('x'.repeat(4097)), { token }), /response limit/)
  await assert.rejects(() => probeLiveIdentity(manifest, () => new Promise(() => {}), { token, deadlineMs: 25 }), /timed out/)
})

test('fresh probe rejects absent credentials before transport and scopes bearer header to the fixed route', async () => {
  assert.equal(validateProbeToken(token), token)
  assert.throws(() => validateProbeToken('short'), /missing or malformed/)
  let calls = 0
  await assert.rejects(() => probeLiveIdentity(manifest, async () => { calls++; return new Response('{}') }, { token: '' }), /missing or malformed/)
  assert.equal(calls, 0)
  await probeLiveIdentity(manifest, async (url, init) => {
    calls++
    assert.equal(url, 'https://runtime.attractacq.com/release/identities/fresh')
    assert.deepEqual(init.headers, { Authorization: `Bearer ${token}` })
    assert.equal(init.cache, 'no-store')
    assert.equal(init.redirect, 'error')
    return new Response(JSON.stringify(live()))
  }, { token })
  assert.equal(calls, 1)
})

test('healthy fresh collector can take more than five seconds within the bounded twelve-second deadline', { timeout: 15000 }, async () => {
  await probeLiveIdentity(manifest, async () => {
    await new Promise((resolve) => setTimeout(resolve, 6500))
    return new Response(JSON.stringify(live()))
  }, { token })
})

test('bounded retry waits for a compatible deployment and stops after repeated mismatch', async () => {
  let calls = 0
  await waitForLiveIdentity(manifest, async () => {
    calls++
    return new Response(JSON.stringify(calls === 1 ? { ...live(), gatewaySha: 'c'.repeat(40) } : live()))
  }, { attempts: 2, delayMs: 0, token })
  assert.equal(calls, 2)
  await assert.rejects(() => waitForLiveIdentity(manifest,
    async () => new Response(JSON.stringify({ ...live(), runtimeSha: 'c'.repeat(40) })),
    { attempts: 2, delayMs: 0, token }), /runtime SHA/)
})

test('component pins require main ancestry and unchanged runtime/gateway source', () => {
  const repo = mkdtempSync(join(tmpdir(), 'aa-release-pins-'))
  const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim()
  const commit = (message) => {
    git('add', '.')
    git('-c', 'user.name=AA Test', '-c', 'user.email=aa@example.test', 'commit', '-qm', message)
    return git('rev-parse', 'HEAD')
  }
  try {
    git('init', '-q')
    mkdirSync(join(repo, 'agent-runtime'))
    mkdirSync(join(repo, 'aa-mcp-gateway'))
    mkdirSync(join(repo, 'supabase', 'verification'), { recursive: true })
    writeFileSync(join(repo, 'agent-runtime', 'index.ts'), 'runtime 1')
    writeFileSync(join(repo, 'aa-mcp-gateway', 'index.ts'), 'gateway 1')
    writeFileSync(join(repo, 'supabase', 'verification', 'released-migration-version.txt'), migrationHead)
    let baseline = commit('both services')
    const pinned = { ...manifest, runtimeSha: baseline, gatewaySha: baseline }
    writeFileSync(join(repo, 'supabase', 'verification', 'browser-release-components.json'), JSON.stringify(pinned))
    assert.deepEqual(loadReleaseManifest(repo), pinned)
    writeFileSync(join(repo, 'browser.ts'), 'frontend 2')
    const browser = commit('browser only')
    assert.equal(assertComponentPins(pinned, repo, browser), browser)
    writeFileSync(join(repo, 'aa-mcp-gateway', 'index.ts'), 'gateway 2')
    const gatewayChanged = commit('gateway changed')
    assert.throws(() => assertComponentPins(pinned, repo, gatewayChanged), /gateway source changed/)
    assert.equal(assertComponentPins({ ...pinned, gatewaySha: gatewayChanged }, repo, gatewayChanged), gatewayChanged)
    assert.throws(() => assertComponentPins({ ...pinned, runtimeSha: 'f'.repeat(40) }, repo, gatewayChanged), /not an ancestor/)
    writeFileSync(join(repo, 'supabase', 'verification', 'released-migration-version.txt'), '20261030160001')
    assert.throws(() => loadReleaseManifest(repo), /disagrees/)
  } finally {
    rmSync(repo, { recursive: true, force: true })
  }
})
