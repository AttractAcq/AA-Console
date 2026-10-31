import assert from 'node:assert/strict'
import { test } from 'vitest'
import {
  checkApprovedProductionRelease, releaseRequestFromEvent,
} from './check-approved-production-release.mjs'

const REPO = 'AttractAcq/AA-Console'
const REQUEST = '11111111-1111-4111-8111-111111111111'
const HEAD = 'a'.repeat(40)
const BASE = 'b'.repeat(40)

function event(body = `AA-Release-Request: ${REQUEST}`) {
  return {
    number: 271, repository: { full_name: REPO },
    pull_request: {
      number: 271, state: 'open', draft: false,
      html_url: `https://github.com/${REPO}/pull/271`, body,
      head: { sha: HEAD, repo: { full_name: REPO } },
      base: { sha: BASE, ref: 'main', repo: { full_name: REPO } },
    },
  }
}

const context = { eventName: 'pull_request_target', repository: REPO, eventSha: BASE }

test('uses the PR marker only as a locator and requires an independently verified exact release', async () => {
  const calls: unknown[] = []
  const result = await checkApprovedProductionRelease({ event: event(), ...context,
    supabaseUrl: 'https://example.supabase.co',
    serviceRoleKey: 'server-credential-from-trusted-workflow', token: 'github-token',
    refresher: async (args: unknown) => {
      calls.push(args)
      return { requestId: REQUEST, attestationId: REQUEST }
    },
    verifier: async (args: unknown) => {
      calls.push(args)
      return { requestId: REQUEST, prNumber: 271, headSha: HEAD, baseSha: BASE,
        sourceVersion: 'c'.repeat(64), packetSha256: 'd'.repeat(64) }
    },
  })
  assert.equal(result.requestId, REQUEST)
  assert.equal(calls.length, 2)
  assert.equal((calls[0] as { refreshApproved: boolean }).refreshApproved, true)
  assert.equal((calls[0] as { expectedHeadSha: string }).expectedHeadSha, HEAD)
  assert.equal((calls[0] as { trustedBaseCheckout: boolean }).trustedBaseCheckout, true)
  assert.equal((calls[1] as { trustedBaseCheckout: boolean }).trustedBaseCheckout, true)
  assert.equal((calls[1] as { token: string }).token, 'github-token')
})

test('fails closed on a missing, duplicate or malformed release marker', () => {
  for (const body of ['', `AA-Release-Request: ${REQUEST}\nAA-Release-Request: ${REQUEST}`,
    'AA-Release-Request: $(echo unsafe)', 'AA-Release-Request: aaaaaaaaa'])
    assert.throws(() => releaseRequestFromEvent(event(body), context), /exactly one/)
})

test('rejects fork, draft, non-main, changed event base and wrong trigger', () => {
  for (const change of [
    (value: ReturnType<typeof event>) => { value.pull_request.head.repo.full_name = 'someone/fork' },
    (value: ReturnType<typeof event>) => { value.pull_request.draft = true },
    (value: ReturnType<typeof event>) => { value.pull_request.base.ref = 'feature' },
    (value: ReturnType<typeof event>) => { value.pull_request.base.sha = 'e'.repeat(40) },
  ]) {
    const value = event()
    change(value)
    assert.throws(() => releaseRequestFromEvent(value, context), /invalid/)
  }
  assert.throws(() => releaseRequestFromEvent(event(), {
    ...context, eventName: 'pull_request',
  }), /trusted pull_request_target/)
})

test('rejects a PR head or base change after the event even when the request ID matches', async () => {
  for (const mismatch of [
    { headSha: 'e'.repeat(40) }, { baseSha: 'f'.repeat(40) }, { prNumber: 272 },
  ]) {
    await assert.rejects(checkApprovedProductionRelease({ event: event(), ...context,
      refresher: async () => ({ requestId: REQUEST }),
      verifier: async () => ({ requestId: REQUEST, prNumber: 271,
        headSha: HEAD, baseSha: BASE, ...mismatch }),
    }), /latest approved release differs/)
  }
})

test('does not read a green decision after refresh fails or returns another request', async () => {
  let checks = 0
  await assert.rejects(checkApprovedProductionRelease({ event: event(), ...context,
    refresher: async () => { throw new Error('latest approved proof changed') },
    verifier: async () => { checks++; return {} },
  }), /latest approved proof changed/)
  await assert.rejects(checkApprovedProductionRelease({ event: event(), ...context,
    refresher: async () => ({ requestId: '22222222-2222-4222-8222-222222222222' }),
    verifier: async () => { checks++; return {} },
  }), /returned another release request/)
  assert.equal(checks, 0)
})
