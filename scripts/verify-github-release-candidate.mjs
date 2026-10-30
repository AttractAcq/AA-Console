#!/usr/bin/env node

// B008: read-only, premerge GitHub and committed-SQL evidence. This module
// never submits a candidate, decides an approval, or authorizes a release.
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const REPOSITORY = 'AttractAcq/AA-Console'
const API = 'https://api.github.com'
const SHA = /^[0-9a-f]{40}$/
const VERSION = /^\d{14}$/
const MIGRATION = /^(\d{14})_([A-Za-z0-9_.-]+)\.sql$/
const NUMBERED_MIGRATION = /^\d{14}_(\d+)_/
const MAX_CHECK_RUNS = 1000

export const REQUIRED_RELEASE_CHECKS = Object.freeze([
  'Agent runtime (typecheck, test, build)',
  'Frontend (lint, typecheck, test, build)',
  'MCP gateway (typecheck, test, build)',
  'Schema replay (clean, upgrade, catalog, types)',
])

function fail(message) { throw new Error(`Release candidate verification failed: ${message}`) }
function fullSha(value, label) {
  if (typeof value !== 'string' || !SHA.test(value)) fail(`${label} is not a full lowercase commit SHA`)
  return value
}
function positiveId(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) fail(`${label} is invalid`)
  return value
}
function sha256(bytes) { return createHash('sha256').update(bytes).digest('hex') }

// The packet hash is independent of object insertion order and timestamps.
export function canonicalJson(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value)
  if (typeof value === 'number' && Number.isSafeInteger(value)) return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value && typeof value === 'object') {
    const keys = Object.keys(value).sort()
    if (keys.some((key) => value[key] === undefined)) fail('packet contains an undefined value')
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`
  }
  fail('packet contains an unsupported value')
}

async function within(promise, milliseconds) {
  let timer
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('GitHub API timeout')), milliseconds) }),
    ])
  } finally { clearTimeout(timer) }
}

async function githubJson(path, fetcher, token, timeoutMs) {
  const headers = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'AA-Console-release-candidate-verifier',
  }
  if (token) headers.Authorization = `Bearer ${token}`
  let response
  try {
    response = await within(Promise.resolve(fetcher(`${API}${path}`, {
      method: 'GET', headers, redirect: 'error', signal: AbortSignal.timeout(timeoutMs),
    })), timeoutMs)
  } catch (error) { fail(`GitHub API request failed at ${path}: ${error.message}`) }
  if (response.status !== 200) fail(`GitHub API returned HTTP ${response.status} at ${path}`)
  let raw
  try { raw = await within(response.text(), timeoutMs) }
  catch (error) { fail(`GitHub API body failed at ${path}: ${error.message}`) }
  if (raw.length > 2_000_000) fail(`GitHub API body exceeded limit at ${path}`)
  try { return JSON.parse(raw) }
  catch { fail(`GitHub API returned invalid JSON at ${path}`) }
}

function git(checkoutDir, args, encoding = 'utf8') {
  try {
    return execFileSync('git', ['-C', checkoutDir, ...args], {
      encoding, maxBuffer: 32 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  } catch { fail(`Git checkout cannot verify ${args[0]} against the committed PR tree`) }
}

function migrationEvidence(checkoutDir, headSha, baseSha) {
  const checkedOut = git(checkoutDir, ['rev-parse', 'HEAD']).trim()
  if (checkedOut !== headSha) fail('checked-out HEAD differs from the GitHub PR head')
  git(checkoutDir, ['cat-file', '-e', `${baseSha}^{commit}`])
  git(checkoutDir, ['merge-base', '--is-ancestor', baseSha, headSha])

  const marker = git(checkoutDir, ['show', `${headSha}:supabase/verification/released-migration-version.txt`]).trim()
  if (!VERSION.test(marker)) fail('committed released-schema marker is invalid')
  const paths = git(checkoutDir, ['ls-tree', '-r', '--name-only', '-z', headSha, '--', 'supabase/migrations'])
    .split('\0').filter(Boolean).filter((path) => path.endsWith('.sql'))
  const files = paths.map((path) => {
    const filename = path.slice('supabase/migrations/'.length)
    const match = MIGRATION.exec(filename)
    if (!match || path !== `supabase/migrations/${filename}`) fail(`invalid committed migration filename: ${path}`)
    const numbered = NUMBERED_MIGRATION.exec(filename)
    return { path, filename, version: match[1], sequence: numbered ? Number(numbered[1]) : null }
  }).sort((a, b) => a.version.localeCompare(b.version))
  if (files.some((file, index) => index > 0 && file.version === files[index - 1].version))
    fail('committed migration versions are duplicated')
  const released = files.find((file) => file.version === marker)
  if (!released) fail('released-schema marker does not name a committed migration')
  if (!Number.isSafeInteger(released.sequence)) fail('released-schema marker has no numbered migration')

  // A candidate must never quietly edit or remove already released SQL.
  const changed = git(checkoutDir, ['diff', '--name-status', '--no-renames', '-z', baseSha, headSha, '--', 'supabase/migrations'])
    .split('\0').filter(Boolean)
  if (changed.length % 2 !== 0) fail('committed migration diff is malformed')
  for (let index = 0; index < changed.length; index += 2) {
    const [status, path] = [changed[index], changed[index + 1]]
    if (!path.endsWith('.sql')) continue
    const version = MIGRATION.exec(path.slice('supabase/migrations/'.length))?.[1]
    if (!version || status === 'D' || version <= marker)
      fail(`PR rewrites or removes released migration SQL: ${path}`)
  }

  const pending = files.filter((file) => file.version > marker)
  let nextSequence = released.sequence + 1
  for (const file of pending) {
    if (file.sequence !== nextSequence++) fail(`pending migration sequence is not contiguous at ${file.filename}`)
  }
  return {
    sourceMarkerHead: marker,
    targetHead: pending.at(-1)?.version ?? marker,
    pending: pending.map((file) => ({
      version: file.version,
      filename: file.filename,
      sha256: sha256(git(checkoutDir, ['show', `${headSha}:${file.path}`], 'buffer')),
    })),
  }
}

function checkedRunId(check, repository) {
  const escaped = repository.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = new RegExp(`^https://github\\.com/${escaped}/actions/runs/([1-9][0-9]*)/job/([1-9][0-9]*)$`)
    .exec(check.details_url ?? '')
  if (!match || String(check.id) !== match[2]) fail(`required check ${check.name} has no trusted workflow-run link`)
  return match[1]
}

/**
 * Verify GitHub facts and the exact committed SQL bytes. No production state
 * is queried, and no caller-supplied CI claim is accepted as evidence.
 * @returns {Promise<import('./verify-github-release-candidate.d.mts').GithubPremergePacket>}
 */
export async function verifyGithubReleaseCandidate({
  prNumber, checkoutDir = process.cwd(), fetcher = fetch, token = null,
  timeoutMs = 10000,
}) {
  if (!Number.isSafeInteger(prNumber) || prNumber <= 0) fail('PR number is invalid')
  checkoutDir = resolve(checkoutDir)
  const [repository, pr] = await Promise.all([
    githubJson(`/repos/${REPOSITORY}`, fetcher, token, timeoutMs),
    githubJson(`/repos/${REPOSITORY}/pulls/${prNumber}`, fetcher, token, timeoutMs),
  ])
  const repoId = positiveId(repository?.id, 'repository ID')
  if (repository.full_name !== REPOSITORY || pr?.number !== prNumber || pr.state !== 'open'
      || pr.merged_at != null || pr.html_url !== `https://github.com/${REPOSITORY}/pull/${prNumber}`)
    fail('GitHub repository or open PR identity changed')
  const headSha = fullSha(pr.head?.sha, 'PR head')
  const baseSha = fullSha(pr.base?.sha, 'PR base')
  if (headSha === baseSha || pr.head?.repo?.id !== repoId || pr.base?.repo?.id !== repoId
      || pr.head?.repo?.full_name !== REPOSITORY || pr.base?.repo?.full_name !== REPOSITORY
      || typeof pr.head?.ref !== 'string' || !pr.head.ref
      || typeof pr.base?.ref !== 'string' || !pr.base.ref)
    fail('PR head/base repositories, refs or commits are invalid')

  const allChecks = []
  let expectedCount = null
  for (let page = 1; page <= Math.ceil(MAX_CHECK_RUNS / 100); page++) {
    const result = await githubJson(`/repos/${REPOSITORY}/commits/${headSha}/check-runs?filter=all&per_page=100&page=${page}`,
      fetcher, token, timeoutMs)
    if (!Number.isSafeInteger(result?.total_count) || result.total_count < 0
        || result.total_count > MAX_CHECK_RUNS || !Array.isArray(result.check_runs)
        || result.check_runs.length > 100 || (expectedCount !== null && result.total_count !== expectedCount))
      fail('GitHub check-run listing is malformed or changed during pagination')
    expectedCount = result.total_count
    allChecks.push(...result.check_runs)
    if (allChecks.length >= expectedCount) break
    if (result.check_runs.length === 0) fail('GitHub check-run pagination ended early')
  }
  if (allChecks.length !== expectedCount) fail('GitHub check-run pagination is incomplete')
  const required = REQUIRED_RELEASE_CHECKS.map((name) => {
    const matches = allChecks.filter((run) => run?.name === name)
    if (matches.length !== 1) fail(`required check ${name} is missing or duplicated`)
    const check = matches[0]
    if (check.head_sha !== headSha || check.status !== 'completed'
        || check.conclusion !== 'success' || check.app?.slug !== 'github-actions')
      fail(`required check ${name} is pending, failed or on the wrong SHA/app`)
    positiveId(check.id, `required check ${name} ID`)
    return { name, headSha, runId: checkedRunId(check, REPOSITORY), checkRunId: check.id }
  })
  const runIds = new Set(required.map((check) => check.runId))
  if (runIds.size !== 1) fail('required checks belong to different CI workflow runs')
  const workflowRunId = [...runIds][0]
  const workflow = await githubJson(`/repos/${REPOSITORY}/actions/runs/${workflowRunId}`,
    fetcher, token, timeoutMs)
  if (String(workflow?.id) !== workflowRunId || workflow.name !== 'CI'
      || workflow.path !== '.github/workflows/ci.yml' || workflow.event !== 'pull_request'
      || workflow.head_sha !== headSha || workflow.status !== 'completed'
      || workflow.conclusion !== 'success' || workflow.head_repository?.id !== repoId
      || !Array.isArray(workflow.pull_requests)
      || !workflow.pull_requests.some((item) => item.number === prNumber
        && item.head?.sha === headSha && item.base?.sha === baseSha))
    fail('required check run is not a successful exact-head CI run for this PR/base')

  const migrations = migrationEvidence(checkoutDir, headSha, baseSha)
  // GitHub may receive a force push or base-branch advance while the checks
  // and committed SQL are being read. Never return a packet for that stale PR.
  const latestPr = await githubJson(`/repos/${REPOSITORY}/pulls/${prNumber}`,
    fetcher, token, timeoutMs)
  if (latestPr?.state !== 'open' || latestPr.merged_at != null
      || latestPr.number !== prNumber || latestPr.html_url !== pr.html_url
      || latestPr.head?.sha !== headSha || latestPr.base?.sha !== baseSha
      || latestPr.head?.ref !== pr.head.ref || latestPr.base?.ref !== pr.base.ref
      || latestPr.head?.repo?.id !== repoId || latestPr.base?.repo?.id !== repoId)
    fail('PR head, base or identity changed during verification')
  const body = {
    schemaVersion: 1,
    kind: 'github_premerge_release_evidence',
    repository: { id: repoId, fullName: REPOSITORY },
    pr: {
      number: prNumber,
      url: pr.html_url,
      head: { sha: headSha, ref: pr.head.ref, repositoryId: repoId },
      base: { sha: baseSha, ref: pr.base.ref, repositoryId: repoId },
    },
    checks: {
      workflowRunId,
      required: required.map((check) => ({
        name: check.name, headSha: check.headSha, runId: check.runId, checkRunId: check.checkRunId,
      })),
    },
    migrations,
    premergePrHeadSha: headSha,
    futureDeploymentSha: null,
    productionSchemaVerified: false,
    releaseAuthorized: false,
  }
  return { ...body, packetSha256: sha256(canonicalJson(body)) }
}

function cliArgs(argv) {
  const values = { checkoutDir: process.cwd() }
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index]
    const value = argv[index + 1]
    if (!value || !['--pr', '--checkout'].includes(key)) fail('usage: node scripts/verify-github-release-candidate.mjs --pr N [--checkout PATH]')
    if (key === '--pr') values.prNumber = Number(value)
    else values.checkoutDir = value
  }
  return values
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const packet = await verifyGithubReleaseCandidate({
      ...cliArgs(process.argv.slice(2)),
      token: process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN ?? null,
    })
    process.stdout.write(`${JSON.stringify(packet, null, 2)}\n`)
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
