#!/usr/bin/env node

// B009 browser publication guard. The manifest pins the deployed runtime and
// gateway independently: Railway may skip an unchanged service on a main push.
// A pin is valid only when that commit is in main's history and its component
// tree still matches the CI-tested browser candidate.
import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const sha = /^[0-9a-f]{40}$/
const migration = /^\d{14}$/
const endpoint = 'https://runtime.attractacq.com/release/identities'

export function validateManifest(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) ||
      raw.schemaVersion !== 1 || !sha.test(raw.runtimeSha) ||
      !sha.test(raw.gatewaySha) || !migration.test(raw.migrationHead)) {
    throw new Error('Invalid browser release component manifest')
  }
  return {
    schemaVersion: 1,
    runtimeSha: raw.runtimeSha,
    gatewaySha: raw.gatewaySha,
    migrationHead: raw.migrationHead,
  }
}

function git(args, repository) {
  return execFileSync('git', args, {
    cwd: repository,
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
  }).trim()
}

export function assertComponentPins(manifest, repository = resolve(), testedSha = 'HEAD') {
  const tested = git(['rev-parse', testedSha], repository)
  if (!sha.test(tested)) throw new Error('CI-tested browser SHA is not a full commit')
  for (const [name, pinned, path] of [
    ['runtime', manifest.runtimeSha, 'agent-runtime/'],
    ['gateway', manifest.gatewaySha, 'aa-mcp-gateway/'],
  ]) {
    try {
      git(['merge-base', '--is-ancestor', pinned, tested], repository)
    } catch {
      throw new Error(`${name} pin is not an ancestor of the CI-tested browser commit`)
    }
    try {
      git(['diff', '--quiet', pinned, tested, '--', path], repository)
    } catch {
      throw new Error(`${name} source changed after its pinned deployment`)
    }
  }
  return tested
}

export function assertLiveIdentity(body, manifest, now = Date.now()) {
  if (!body || typeof body !== 'object' || Array.isArray(body) ||
      body.schemaVersion !== 1 || body.observationsComplete !== true ||
      body.reason !== null || !sha.test(body.runtimeSha) ||
      !sha.test(body.gatewaySha) || !migration.test(body.migrationHead)) {
    throw new Error('Live release identities are incomplete')
  }
  const age = now - Date.parse(body.observedAt)
  if (!Number.isFinite(age) || age < -5000 || age > 30000)
    throw new Error('Live release identity observation is stale')
  if (body.runtimeSha !== manifest.runtimeSha)
    throw new Error('Live runtime SHA differs from the reviewed pin')
  if (body.gatewaySha !== manifest.gatewaySha)
    throw new Error('Live gateway SHA differs from the reviewed pin')
  if (body.migrationHead !== manifest.migrationHead)
    throw new Error('Live production migration differs from the reviewed pin')
}

async function within(work, milliseconds) {
  let timeout
  try {
    return await Promise.race([
      work,
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error('Live release probe timed out')), milliseconds)
      }),
    ])
  } finally {
    if (timeout) clearTimeout(timeout)
  }
}

export async function probeLiveIdentity(manifest, fetcher = fetch, url = endpoint) {
  const response = await within(fetcher(url, {
    method: 'GET', cache: 'no-store', redirect: 'error',
    signal: AbortSignal.timeout(5000),
  }), 5000)
  if (!response.ok) throw new Error(`Live release probe returned HTTP ${response.status}`)
  const raw = await within(response.text(), 5000)
  if (raw.length > 4096) throw new Error('Live release probe exceeded its response limit')
  const body = JSON.parse(raw)
  assertLiveIdentity(body, manifest)
}

export async function waitForLiveIdentity(manifest, fetcher = fetch, options = {}) {
  const attempts = options.attempts ?? 8
  const delayMs = options.delayMs ?? 15000
  const url = options.url ?? endpoint
  let lastError
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      await probeLiveIdentity(manifest, fetcher, url)
      return
    } catch (error) {
      lastError = error
      if (attempt < attempts)
        await new Promise((done) => setTimeout(done, delayMs))
    }
  }
  throw lastError
}

export function loadReleaseManifest(repository = resolve()) {
  const raw = JSON.parse(readFileSync(resolve(repository, 'supabase/verification/browser-release-components.json'), 'utf8'))
  const manifest = validateManifest(raw)
  const released = readFileSync(resolve(repository, 'supabase/verification/released-migration-version.txt'), 'utf8').trim()
  if (manifest.migrationHead !== released)
    throw new Error('Browser release manifest disagrees with the released schema marker')
  return manifest
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const manifest = loadReleaseManifest()
    assertComponentPins(manifest, resolve(), process.env.TESTED_SHA ?? 'HEAD')
    await waitForLiveIdentity(manifest)
    console.log('Live runtime, gateway and migration identities match reviewed browser release pins.')
  } catch (error) {
    console.error(`Pages live release blocked: ${error.message}`)
    process.exitCode = 1
  }
}
