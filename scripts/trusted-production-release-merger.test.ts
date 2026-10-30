import assert from 'node:assert/strict'
import { test } from 'vitest'
import {
  assertProtectedReleaseBoundary, runTrustedProductionReleaseMerger,
  createGithubMergeEffect, readObservedGithubMerge, readProtectedReleaseBoundary,
  mergeApprovedProductionRelease,
} from './trusted-production-release-merger.mjs'

const REPOSITORY = 'AttractAcq/AA-Console'
const REQUEST = '11111111-1111-4111-8111-111111111111'
const LEASE = '22222222-2222-4222-8222-222222222222'
const HEAD = 'a'.repeat(40)
const BASE = 'b'.repeat(40)
const MERGED = 'c'.repeat(40)
const CHECKS = [
  'Agent runtime (typecheck, test, build)',
  'Frontend (lint, typecheck, test, build)',
  'MCP gateway (typecheck, test, build)',
  'Schema replay (clean, upgrade, catalog, types)',
  'Approved production release (trusted)',
]
const plan = Object.freeze({ requestId: REQUEST, prNumber: 297,
  headSha: HEAD, baseSha: BASE, sourceVersion: 'd'.repeat(64),
  packetSha256: 'e'.repeat(64), mergeMethod: 'squash' })

function protectedFacts() {
  return {
    plan, mergerLogin: 'aa-release-merger',
    actor: { login: 'aa-release-merger', type: 'User' },
    branch: { name: 'main', commit: { sha: BASE } },
    pr: { number: 297, state: 'open', draft: false, merged_at: null,
      mergeable: true, mergeable_state: 'clean',
      head: { sha: HEAD, repo: { full_name: REPOSITORY } },
      base: { sha: BASE, ref: 'main', repo: { full_name: REPOSITORY } } },
    protection: {
      required_status_checks: { strict: true,
        checks: CHECKS.map((context) => ({ context, app_id: 15368 })) },
      enforce_admins: { enabled: true },
      allow_force_pushes: { enabled: false }, allow_deletions: { enabled: false },
      restrictions: { users: [{ login: 'aa-release-merger' }], teams: [], apps: [] },
    },
    checks: { total_count: 5, check_runs: CHECKS.map((name, index) => ({
      name, id: index + 1, head_sha: HEAD, status: 'completed',
      conclusion: 'success', app: { id: 15368, slug: 'github-actions' },
      details_url: `https://github.com/${REPOSITORY}/actions/runs/123/job/${index + 1}`,
    })) },
    trustedRun: { id: 123, path: '.github/workflows/production-release-approval.yml',
      event: 'pull_request_target', head_sha: BASE,
      status: 'completed', conclusion: 'success',
      repository: { full_name: REPOSITORY },
      pull_requests: [{ number: 297, head: { sha: HEAD }, base: { sha: BASE } }] },
  }
}

test('requires strict protected CI, the trusted exact-head job, sole merger identity and unchanged main', () => {
  assert.equal(assertProtectedReleaseBoundary(protectedFacts()), true)
  const attacks = [
    (f: ReturnType<typeof protectedFacts>) => { f.branch.commit.sha = MERGED },
    (f: ReturnType<typeof protectedFacts>) => { f.pr.base.sha = MERGED },
    (f: ReturnType<typeof protectedFacts>) => { f.protection.required_status_checks.strict = false },
    (f: ReturnType<typeof protectedFacts>) => { f.protection.enforce_admins.enabled = false },
    (f: ReturnType<typeof protectedFacts>) => { f.protection.restrictions.users.push({ login: 'other' }) },
    (f: ReturnType<typeof protectedFacts>) => { f.protection.required_status_checks.checks.pop() },
    (f: ReturnType<typeof protectedFacts>) => { f.protection.required_status_checks.checks.push({ context: 'Unreviewed check', app_id: 15368 }) },
    (f: ReturnType<typeof protectedFacts>) => { f.checks.check_runs[4].conclusion = 'failure' },
    (f: ReturnType<typeof protectedFacts>) => { f.checks.check_runs[4].head_sha = BASE },
    (f: ReturnType<typeof protectedFacts>) => { f.checks.check_runs[4].app.id = 999 },
    (f: ReturnType<typeof protectedFacts>) => { f.trustedRun.path = '.github/workflows/ci.yml' },
    (f: ReturnType<typeof protectedFacts>) => { f.trustedRun.pull_requests = [] },
    (f: ReturnType<typeof protectedFacts>) => { f.trustedRun.pull_requests[0].head.sha = MERGED },
    (f: ReturnType<typeof protectedFacts>) => { f.trustedRun.head_sha = HEAD },
    (f: ReturnType<typeof protectedFacts>) => { f.actor.login = 'alex' },
  ]
  for (const attack of attacks) {
    const facts = protectedFacts()
    attack(facts)
    assert.throws(() => assertProtectedReleaseBoundary(facts), /blocked:/)
  }
})

test('rejects main moving between parallel boundary reads and the final branch read', async () => {
  const facts = protectedFacts()
  let branchReads = 0
  const fetcher = async (url: string) => {
    let value: unknown
    if (url.endsWith('/branches/main')) {
      branchReads++
      value = branchReads === 1 ? facts.branch : { name: 'main', commit: { sha: MERGED } }
    } else if (url.endsWith('/branches/main/protection')) value = facts.protection
    else if (url.endsWith('/pulls/297')) value = facts.pr
    else if (url.includes('/check-runs?')) value = facts.checks
    else if (url.endsWith('/actions/runs/123')) value = facts.trustedRun
    else if (url.endsWith('/user')) value = facts.actor
    else throw new Error(`unexpected URL ${url}`)
    return { status: 200, text: async () => JSON.stringify(value) }
  }
  await assert.rejects(readProtectedReleaseBoundary({ plan,
    token: 'reviewed-merger-token-value', mergerLogin: 'aa-release-merger',
    fetcher }), /main advanced during protected release boundary read/)
  assert.equal(branchReads, 2)
})

function harness() {
  const calls: string[] = []
  let observedPlan = { ...plan }
  let boundaryFailure = false
  let mergeFailure = false
  let dispatchFailure = false
  const lease = {
    acquire: async (value: typeof plan) => { calls.push('acquire'); assert.deepEqual(value, plan); return LEASE },
    dispatch: async () => { calls.push('dispatch'); if (dispatchFailure) throw new Error('dispatch uncertain'); return LEASE },
    abort: async () => { calls.push('abort'); return LEASE },
    complete: async (_id: string, sha: string) => { calls.push('complete'); assert.equal(sha, MERGED); return LEASE },
  }
  const deps = { requestId: REQUEST,
    attester: async () => { calls.push('refresh') },
    verifier: async () => { calls.push('verify'); return observedPlan },
    boundary: async () => { calls.push('boundary'); if (boundaryFailure) throw new Error('protected check missing') },
    lease,
    mergeEffect: async () => { calls.push('merge'); if (mergeFailure) throw new Error('GitHub timeout'); return MERGED },
    observeMerge: async (_plan: typeof plan, sha: string) => { calls.push('readback'); return sha },
  }
  return { calls, deps,
    changePlan: (value: Partial<typeof plan>) => { observedPlan = { ...plan, ...value } },
    failBoundary: () => { boundaryFailure = true },
    failMerge: () => { mergeFailure = true },
    failDispatch: () => { dispatchFailure = true },
  }
}

test('re-reads exact decision and GitHub boundary after leasing, then dispatches once', async () => {
  const { calls, deps } = harness()
  const result = await runTrustedProductionReleaseMerger(deps)
  assert.equal(result.observedMergeSha, MERGED)
  assert.deepEqual(calls, ['refresh', 'verify', 'boundary', 'acquire',
    'verify', 'boundary', 'dispatch', 'merge', 'readback', 'complete'])
})

test('revocation, proof, PR head/base, plan and expiry changes after acquisition abort before merge', async () => {
  for (const change of [
    { packetSha256: 'f'.repeat(64) }, { headSha: MERGED },
    { baseSha: MERGED }, { sourceVersion: 'f'.repeat(64) },
    { mergeMethod: 'merge' },
  ]) {
    const h = harness()
    let reads = 0
    h.deps.verifier = async () => { h.calls.push('verify');
      if (++reads === 2) h.changePlan(change)
      return reads === 1 ? plan : await Promise.resolve({ ...plan, ...change }) }
    await assert.rejects(runTrustedProductionReleaseMerger(h.deps), /changed after lease acquisition/)
    assert.equal(h.calls.at(-1), 'abort')
    assert.ok(!h.calls.includes('merge'))
  }
  for (const reason of ['revoked', 'expired']) {
    const h = harness()
    let reads = 0
    h.deps.verifier = async () => { h.calls.push('verify');
      if (++reads === 2) throw new Error(reason)
      return plan }
    await assert.rejects(runTrustedProductionReleaseMerger(h.deps), new RegExp(reason))
    assert.equal(h.calls.at(-1), 'abort')
    assert.ok(!h.calls.includes('merge'))
  }
})

test('missing protected check or a newer main after acquisition aborts before merge', async () => {
  const h = harness()
  let reads = 0
  h.deps.boundary = async () => { h.calls.push('boundary');
    if (++reads === 2) throw new Error('main advanced or protected check missing') }
  await assert.rejects(runTrustedProductionReleaseMerger(h.deps), /main advanced/)
  assert.deepEqual(h.calls.slice(-2), ['boundary', 'abort'])
  assert.ok(!h.calls.includes('merge'))
})

test('ambiguous dispatch or GitHub response leaves the lease unresolved and never retries', async () => {
  const dispatch = harness(); dispatch.failDispatch()
  await assert.rejects(runTrustedProductionReleaseMerger(dispatch.deps), /dispatch uncertain/)
  assert.ok(!dispatch.calls.includes('merge'))
  assert.ok(!dispatch.calls.includes('abort'))
  const merge = harness(); merge.failMerge()
  await assert.rejects(runTrustedProductionReleaseMerger(merge.deps), /GitHub timeout/)
  assert.equal(merge.calls.filter((call) => call === 'merge').length, 1)
  assert.ok(!merge.calls.includes('abort'))
  assert.ok(!merge.calls.includes('complete'))
})

test('GitHub effect binds the exact PR head and independently confirms merged commit on main', async () => {
  const token = 'reviewed-merger-token-value'
  const calls: Array<{ url: string, init: RequestInit }> = []
  const fetcher = async (url: string, init: RequestInit) => {
    calls.push({ url, init })
    if (init.method === 'PUT') return { status: 200, text: async () => JSON.stringify({ merged: true, sha: MERGED }) }
    if (url.endsWith('/pulls/297')) return { status: 200, text: async () => JSON.stringify({
      number: 297, state: 'closed', merged_at: new Date().toISOString(),
      head: { sha: HEAD }, merge_commit_sha: MERGED,
    }) }
    return { status: 200, text: async () => JSON.stringify({ status: 'ahead',
      base_commit: { sha: MERGED }, ahead_by: 1, behind_by: 0 }) }
  }
  const sha = await createGithubMergeEffect({ token, fetcher })(plan)
  assert.equal(sha, MERGED)
  assert.deepEqual(JSON.parse(String(calls[0].init.body)),
    { sha: HEAD, merge_method: 'squash' })
  assert.equal(await readObservedGithubMerge({ plan, proposedSha: sha, token, fetcher }), MERGED)
  const forged = async (url: string, init: RequestInit) => {
    if (url.endsWith('/pulls/297')) return { status: 200, text: async () => JSON.stringify({
      number: 297, state: 'closed', merged_at: new Date().toISOString(),
      head: { sha: HEAD }, merge_commit_sha: BASE,
    }) }
    return fetcher(url, init)
  }
  await assert.rejects(readObservedGithubMerge({ plan, proposedSha: sha, token,
    fetcher: forged }), /do not prove the expected commit/)
})

test('production wiring rejects a shared read/write GitHub credential before any I/O', async () => {
  let fetched = false
  await assert.rejects(mergeApprovedProductionRelease({ requestId: REQUEST,
    supabaseUrl: 'https://project.supabase.co', serviceRoleKey: 'server-secret-value-12345',
    verificationToken: 'same-github-credential', mergerToken: 'same-github-credential',
    mergerLogin: 'aa-release-merger',
    fetcher: async () => { fetched = true; throw new Error('I/O must not happen') },
  }), /credentials must be distinct/)
  assert.equal(fetched, false)
})
