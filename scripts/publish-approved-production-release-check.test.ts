import assert from 'node:assert/strict'
import { test } from 'vitest'
import { publishApprovedProductionReleaseHeadCheck } from './publish-approved-production-release-check.mjs'
import {
  APPROVED_RELEASE_APP_CHECK, approvedReleaseCheckExternalId,
} from './production-release-head-check-contract.mjs'

const REPOSITORY = 'AttractAcq/AA-Console'
const REQUEST = '11111111-1111-4111-8111-111111111111'
const HEAD = 'a'.repeat(40)
const BASE = 'b'.repeat(40)
const APP = { id: 424242, slug: 'aa-release-gate' }
const approved = { requestId: REQUEST, prNumber: 297, headSha: HEAD,
  baseSha: BASE, sourceVersion: 'c'.repeat(64), packetSha256: 'd'.repeat(64) }

function facts() {
  const now = Date.now()
  const pr = { number: 297, state: 'open', draft: false,
    html_url: `https://github.com/${REPOSITORY}/pull/297`,
    body: `AA-Release-Request: ${REQUEST}`,
    head: { sha: HEAD, repo: { full_name: REPOSITORY } },
    base: { sha: BASE, ref: 'main', repo: { full_name: REPOSITORY } } }
  return { event: { number: 297, repository: { full_name: REPOSITORY },
    pull_request: structuredClone(pr) },
    pr, main: { name: 'main', commit: { sha: BASE } },
    run: { id: 123, run_attempt: 1,
      path: '.github/workflows/production-release-approval.yml',
      event: 'pull_request_target', head_sha: BASE,
      status: 'completed', conclusion: 'success',
      created_at: new Date(now - 60_000).toISOString(),
      updated_at: new Date(now - 10_000).toISOString(),
      repository: { full_name: REPOSITORY }, pull_requests: [] },
  }
}

function harness() {
  const state = facts()
  const calls: Array<{ url: string, init: RequestInit }> = []
  let prReads = 0
  let mainReads = 0
  let checkReceiptOverride: Record<string, unknown> = {}
  const fetcher = async (url: string, init: RequestInit) => {
    calls.push({ url, init })
    let result: unknown
    let status = 200
    if (url.endsWith('/pulls/297')) { prReads++; result = state.pr }
    else if (url.endsWith('/branches/main')) { mainReads++; result = state.main }
    else if (url.endsWith('/actions/runs/123')) result = state.run
    else if (url.endsWith('/check-runs')) {
      status = 201
      const request = JSON.parse(String(init.body))
      result = { id: 999, name: request.name, head_sha: request.head_sha,
        status: request.status, conclusion: request.conclusion,
        external_id: request.external_id, details_url: request.details_url,
        app: APP, ...checkReceiptOverride }
    } else throw new Error(`unexpected URL ${url}`)
    return { status, text: async () => JSON.stringify(result) }
  }
  const input = { event: state.event, eventName: 'pull_request_target',
    repository: REPOSITORY, eventSha: BASE, workflowRunId: 123,
    workflowRunAttempt: 1, checkoutDir: '/trusted/base',
    supabaseUrl: 'https://project.supabase.co', serviceRoleKey: 'server-credential-value',
    verificationToken: 'read-only-github-token-value',
    appToken: 'dedicated-app-installation-token-value', trustedApp: APP,
    checker: async () => approved, fetcher }
  return { state, calls, input, reads: () => ({ prReads, mainReads }),
    overrideReceipt: (value: Record<string, unknown>) => { checkReceiptOverride = value } }
}

test('the dedicated App publishes success only on the exact approved PR head', async () => {
  const h = harness()
  const result = await publishApprovedProductionReleaseHeadCheck(h.input)
  assert.equal(result.checkRunId, 999)
  assert.deepEqual(h.reads(), { prReads: 2, mainReads: 3 })
  const post = h.calls.find((call) => call.init.method === 'POST')
  assert.ok(post)
  const body = JSON.parse(String(post.init.body))
  assert.equal(body.name, APPROVED_RELEASE_APP_CHECK)
  assert.equal(body.head_sha, HEAD)
  assert.equal(body.conclusion, 'success')
  assert.equal(body.external_id, approvedReleaseCheckExternalId(approved, 123, 1))
  assert.equal(body.details_url,
    `https://github.com/${REPOSITORY}/actions/runs/123`)
  assert.equal(post.init.headers?.Authorization,
    'Bearer dedicated-app-installation-token-value')
  assert.ok(h.calls.filter((call) => call.init.method === 'GET')
    .every((call) => call.init.headers?.Authorization === 'Bearer read-only-github-token-value'))
})

test('stale event, decision, PR marker, head or base cannot create a green check', async () => {
  for (const change of [
    (h: ReturnType<typeof harness>) => { h.state.pr.head.sha = 'e'.repeat(40) },
    (h: ReturnType<typeof harness>) => { h.state.pr.base.sha = 'e'.repeat(40) },
    (h: ReturnType<typeof harness>) => { h.state.pr.body = `AA-Release-Request: ${'e'.repeat(8)}-1111-4111-8111-111111111111` },
    (h: ReturnType<typeof harness>) => { h.state.main.commit.sha = 'e'.repeat(40) },
    (h: ReturnType<typeof harness>) => { h.input.checker = async () => ({ ...approved, packetSha256: 'e'.repeat(64), headSha: 'e'.repeat(40) }) },
  ]) {
    const h = harness(); change(h)
    await assert.rejects(publishApprovedProductionReleaseHeadCheck(h.input))
    assert.equal(h.calls.filter((call) => call.init.method === 'POST').length, 0)
  }
})

test('a wrong or absent protected-base workflow run cannot publish', async () => {
  for (const change of [
    (h: ReturnType<typeof harness>) => { h.state.run.path = '.github/workflows/ci.yml' },
    (h: ReturnType<typeof harness>) => { h.state.run.event = 'workflow_dispatch' },
    (h: ReturnType<typeof harness>) => { h.state.run.head_sha = HEAD },
    (h: ReturnType<typeof harness>) => { h.state.run.run_attempt = 2 },
    (h: ReturnType<typeof harness>) => { h.state.run.status = 'in_progress' },
    (h: ReturnType<typeof harness>) => { h.state.run.conclusion = 'failure' },
    (h: ReturnType<typeof harness>) => { h.state.run.updated_at = new Date(Date.now() - 16 * 60_000).toISOString() },
    (h: ReturnType<typeof harness>) => { h.state.run.created_at = new Date(Date.now() - 31 * 60_000).toISOString() },
    (h: ReturnType<typeof harness>) => { h.state.run.pull_requests = [{ number: 298, head: { sha: HEAD }, base: { sha: BASE } }] },
    (h: ReturnType<typeof harness>) => { h.state.run.pull_requests = [
      { number: 297, head: { sha: HEAD }, base: { sha: BASE } },
      { number: 298, head: { sha: HEAD }, base: { sha: BASE } },
    ] },
  ]) {
    const h = harness(); change(h)
    await assert.rejects(publishApprovedProductionReleaseHeadCheck(h.input), /protected-base workflow run/)
    assert.equal(h.calls.filter((call) => call.init.method === 'POST').length, 0)
  }
})

test('App identity, post-write candidate drift and ambiguous writes fail closed', async () => {
  const wrongApp = harness(); wrongApp.overrideReceipt({ app: { id: 9999, slug: APP.slug } })
  await assert.rejects(publishApprovedProductionReleaseHeadCheck(wrongApp.input), /reviewed exact-head check/)

  const drift = harness()
  const original = drift.input.fetcher
  drift.input.fetcher = async (url: string, init: RequestInit) => {
    if (url.endsWith('/check-runs')) drift.state.main.commit.sha = 'e'.repeat(40)
    return original(url, init)
  }
  await assert.rejects(publishApprovedProductionReleaseHeadCheck(drift.input), /main, PR marker, head or base changed/)
  assert.equal(drift.calls.filter((call) => call.init.method === 'POST').length, 1)

  const ambiguous = harness()
  const originalAmbiguous = ambiguous.input.fetcher
  let attempts = 0
  ambiguous.input.fetcher = async (url: string, init: RequestInit) => {
    if (url.endsWith('/check-runs')) { attempts++; throw new Error('network timeout') }
    return originalAmbiguous(url, init)
  }
  await assert.rejects(publishApprovedProductionReleaseHeadCheck(ambiguous.input), /outcome is ambiguous/)
  assert.equal(attempts, 1)
})

test('missing or reused App credentials reject before any GitHub read', async () => {
  const h = harness()
  await assert.rejects(publishApprovedProductionReleaseHeadCheck({ ...h.input,
    appToken: h.input.verificationToken }), /distinct credentials are absent/)
  assert.equal(h.calls.length, 0)
})
