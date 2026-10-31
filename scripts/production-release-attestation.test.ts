import assert from 'node:assert/strict'
import { test } from 'vitest'
import {
  assertPremergePacketMatchesCandidate, attestProductionRelease,
  verifyApprovedProductionRelease,
} from './production-release-attestation.mjs'

const UUID = '11111111-1111-4111-8111-111111111111'
const SOURCE = '22222222-2222-4222-8222-222222222222'
const DECISION = '33333333-3333-4333-8333-333333333333'
const ATTESTATION = '44444444-4444-4444-8444-444444444444'
const HEAD = 'a'.repeat(40)
const BASE = 'b'.repeat(40)
const HASH = 'c'.repeat(64)
const NAMES = [
  'Agent runtime (typecheck, test, build)',
  'Frontend (lint, typecheck, test, build)',
  'MCP gateway (typecheck, test, build)',
  'Schema replay (clean, upgrade, catalog, types)',
]
const candidate = {
  repository: 'AttractAcq/AA-Console',
  pr: { number: '271', url: 'https://github.com/AttractAcq/AA-Console/pull/271',
    head_sha: HEAD, base_sha: BASE, merge_method: 'squash' },
  checks: NAMES.map((name) => ({ name, head_sha: HEAD, run_id: '41005193831',
    conclusion: 'success' })),
  migrations: [{ version: '20261101040000',
    filename: '20261101040000_290_organic_schedule_route.sql', sha256: HASH }],
  schema: { current_head: '20261101033000', target_head: '20261101040000' },
  deployment: { browser_pr_head_sha: HEAD },
}
const packet = {
  schemaVersion: 1, kind: 'github_premerge_release_evidence',
  repository: { id: 12345, fullName: 'AttractAcq/AA-Console' },
  pr: { number: 271, url: candidate.pr.url,
    head: { sha: HEAD, ref: 'codex/release', repositoryId: 12345 },
    base: { sha: BASE, ref: 'main', repositoryId: 12345 } },
  checks: { workflowRunId: '41005193831', workflowSha256: HASH,
    required: NAMES.map((name, index) => ({ name, headSha: HEAD,
      runId: '41005193831', checkRunId: index + 1 })) },
  migrations: { sourceMarkerHead: '20261101033000',
    targetHead: '20261101040000', pending: candidate.migrations },
  premergePrHeadSha: HEAD,
  futureDeploymentSha: null, productionSchemaVerified: false,
  releaseAuthorized: false, packetSha256: HASH,
}

test('binds the GitHub verifier output to every claim shown to the human', () => {
  assert.equal(assertPremergePacketMatchesCandidate(packet, candidate), true)
  assert.throws(() => assertPremergePacketMatchesCandidate({ ...packet,
    pr: { ...packet.pr, head: { ...packet.pr.head, sha: BASE } } }, candidate),
  /repository, PR, base, head/)
  assert.throws(() => assertPremergePacketMatchesCandidate({ ...packet,
    checks: { ...packet.checks, workflowRunId: '41005193832' } }, candidate),
  /exact-head protected run/)
  assert.throws(() => assertPremergePacketMatchesCandidate({ ...packet,
    migrations: { ...packet.migrations, pending: [{
      ...candidate.migrations[0], sha256: 'd'.repeat(64),
    }] } }, candidate), /SQL versions or byte hashes/)
  assert.throws(() => assertPremergePacketMatchesCandidate({ ...packet,
    releaseAuthorized: true }, candidate), /overclaimed shape/)
})

test('reads the canonical source, verifies GitHub itself and writes only server proof', async () => {
  const requests = []
  const fetcher = async (url, options) => {
    requests.push({ url, options })
    const body = url.includes('/approval_requests_v6?')
      ? [{ id: UUID, source_id: SOURCE, source_kind: 'production_release',
        source_system: 'aa_console', source_version: HASH }]
      : url.includes('/production_release_candidates_v6?')
        ? [{ id: SOURCE, version_hash: HASH, candidate }]
        : UUID
    return { ok: true, status: 200, text: async () => JSON.stringify(body) }
  }
  const result = await attestProductionRelease({
    requestId: UUID, supabaseUrl: 'https://example.supabase.co',
    serviceRoleKey: 'secret-only-on-release-server', token: 'github-token',
    fetcher,
    verifier: async ({ prNumber, token }) => {
      assert.equal(prNumber, 271)
      assert.equal(token, 'github-token')
      return packet
    },
  })
  assert.equal(result.attestationId, UUID)
  assert.equal(requests.length, 3)
  assert.equal(requests[2].options.method, 'POST')
  assert.match(requests[2].url, /record_trusted_production_release_attestation_v6$/)
  assert.equal(JSON.parse(requests[2].options.body).p_packet.pr.head.sha, HEAD)
  assert.equal(requests[2].options.headers.Authorization,
    'Bearer secret-only-on-release-server')
})

test('fails before proof write when GitHub returns an advanced head', async () => {
  let writes = 0
  const fetcher = async (url) => {
    if (url.includes('/rpc/')) writes++
    const body = url.includes('/approval_requests_v6?')
      ? [{ id: UUID, source_id: SOURCE, source_kind: 'production_release',
        source_system: 'aa_console', source_version: HASH }]
      : [{ id: SOURCE, version_hash: HASH, candidate }]
    return { ok: true, status: 200, text: async () => JSON.stringify(body) }
  }
  await assert.rejects(attestProductionRelease({
    requestId: UUID, supabaseUrl: 'https://example.supabase.co',
    serviceRoleKey: 'secret-only-on-release-server', fetcher,
    verifier: async () => ({ ...packet,
      pr: { ...packet.pr, head: { ...packet.pr.head, sha: BASE } } }),
  }), /repository, PR, base, head/)
  assert.equal(writes, 0)
})

test('approved proof refresh self-verifies exact event commits before its server RPC', async () => {
  const requests = []
  const fetcher = async (url, options) => {
    requests.push({ url, options })
    const body = url.includes('/approval_requests_v6?')
      ? [{ id: UUID, source_id: SOURCE, source_kind: 'production_release',
        source_system: 'aa_console', source_version: HASH }]
      : url.includes('/production_release_candidates_v6?')
        ? [{ id: SOURCE, version_hash: HASH, candidate }]
        : ATTESTATION
    return { ok: true, status: 200, text: async () => JSON.stringify(body) }
  }
  const parameters = { requestId: UUID, supabaseUrl: 'https://example.supabase.co',
    serviceRoleKey: 'secret-only-on-release-server', token: 'github-token',
    fetcher, refreshApproved: true, trustedBaseCheckout: true,
    expectedPrNumber: 271, expectedHeadSha: HEAD, expectedBaseSha: BASE,
    verifier: async ({ trustedBaseCheckout }) => {
      assert.equal(trustedBaseCheckout, true)
      return packet
    } }
  const result = await attestProductionRelease(parameters)
  assert.equal(result.attestationId, ATTESTATION)
  assert.match(requests[2].url, /refresh_approved_production_release_attestation_v6$/)
  await assert.rejects(attestProductionRelease({ ...parameters,
    expectedHeadSha: 'd'.repeat(40) }), /differs from the exact event/)
  assert.equal(requests.length, 5)
})

test('premerge assertion requires the current exact human decision and GitHub packet', async () => {
  const releaseCard = {
    id: UUID, source_system: 'aa_console', source_kind: 'production_release',
    source_id: SOURCE, source_version: HASH, artifact_hash: HASH,
    client_id: null, owner_role: 'admin', status: 'approved',
    source_state: 'pending', preview_blocker: null,
    preview: { candidate, trusted_github_evidence: packet },
    expires_at: new Date(Date.now() + 30 * 60_000).toISOString(),
  }
  let cardReads = 0
  let boundDecision = DECISION
  const fetcher = async (url) => {
    let body
    if (url.includes('/approval_inbox_v6?')) { body = [releaseCard]; cardReads++ }
    else if (url.includes('/production_release_candidates_v6?')) body = [{
      id: SOURCE, candidate, version_hash: HASH, expires_at: releaseCard.expires_at,
    }]
    else if (url.includes('/production_release_attestations_v6?')) body = [{
      request_id: UUID, source_version: HASH, packet, packet_sha256: HASH,
      attested_at: new Date().toISOString(),
    }]
    else if (url.includes('/production_release_approval_bindings_v6?')) body = [{
      request_id: UUID, decision_id: boundDecision, attestation_id: ATTESTATION,
      source_version: HASH, packet_sha256: HASH,
    }]
    else body = [{ id: DECISION, request_id: UUID, decision: 'approved', actor_id: UUID,
      actor_aal: 'aal2', artifact_hash: HASH, event_order: 1 }]
    return { ok: true, status: 200, text: async () => JSON.stringify(body) }
  }
  const parameters = { requestId: UUID, supabaseUrl: 'https://example.supabase.co',
    serviceRoleKey: 'secret-only-on-release-server', fetcher }
  const result = await verifyApprovedProductionRelease({ ...parameters,
    verifier: async () => packet })
  assert.equal(result.headSha, HEAD)
  assert.equal(result.baseSha, BASE)
  assert.equal(cardReads, 2)
  boundDecision = '55555555-5555-4555-8555-555555555555'
  await assert.rejects(verifyApprovedProductionRelease({ ...parameters,
    verifier: async () => packet }), /human approval is not bound/)
  boundDecision = DECISION
  await assert.rejects(verifyApprovedProductionRelease({ ...parameters,
    verifier: async () => ({ ...packet, pr: { ...packet.pr,
      base: { ...packet.pr.base, sha: HEAD } } }) }),
  /repository, PR, base, head/)
})

test('premerge assertion fails if the human revokes while GitHub is being rechecked', async () => {
  let cardReads = 0
  const expires = new Date(Date.now() + 30 * 60_000).toISOString()
  const fetcher = async (url) => {
    let body
    if (url.includes('/approval_inbox_v6?')) {
      cardReads++
      body = [{ id: UUID, source_system: 'aa_console',
        source_kind: 'production_release', source_id: SOURCE, source_version: HASH,
        artifact_hash: HASH, client_id: null, owner_role: 'admin',
        status: cardReads === 1 ? 'approved' : 'revoked', source_state: 'pending',
        preview_blocker: null, preview: { candidate, trusted_github_evidence: packet },
        expires_at: expires }]
    } else if (url.includes('/production_release_candidates_v6?')) body = [{
      id: SOURCE, candidate, version_hash: HASH, expires_at: expires,
    }]
    else if (url.includes('/production_release_attestations_v6?')) body = [{
      request_id: UUID, source_version: HASH, packet, packet_sha256: HASH,
      attested_at: new Date().toISOString(),
    }]
    else if (url.includes('/production_release_approval_bindings_v6?')) body = [{
      request_id: UUID, decision_id: DECISION, attestation_id: ATTESTATION,
      source_version: HASH, packet_sha256: HASH,
    }]
    else body = [{ id: DECISION, request_id: UUID, decision: 'approved', actor_id: UUID,
      actor_aal: 'aal2', artifact_hash: HASH, event_order: 1 }]
    return { ok: true, status: 200, text: async () => JSON.stringify(body) }
  }
  await assert.rejects(verifyApprovedProductionRelease({
    requestId: UUID, supabaseUrl: 'https://example.supabase.co',
    serviceRoleKey: 'secret-only-on-release-server', fetcher,
    verifier: async () => packet,
  }), /approval is absent, held, expired or revoked/)
  assert.equal(cardReads, 2)
})

test('final decision re-read blocks a revocation even if the card projection remains approved', async () => {
  const expires = new Date(Date.now() + 30 * 60_000).toISOString()
  let decisionReads = 0
  const fetcher = async (url: string) => {
    let body
    if (url.includes('/approval_inbox_v6?')) body = [{
      id: UUID, source_system: 'aa_console', source_kind: 'production_release',
      source_id: SOURCE, source_version: HASH, artifact_hash: HASH,
      client_id: null, owner_role: 'admin', status: 'approved',
      source_state: 'pending', preview_blocker: null,
      preview: { candidate, trusted_github_evidence: packet }, expires_at: expires,
    }]
    else if (url.includes('/production_release_candidates_v6?')) body = [{
      id: SOURCE, candidate, version_hash: HASH, expires_at: expires,
    }]
    else if (url.includes('/production_release_attestations_v6?')) body = [{
      request_id: UUID, source_version: HASH, packet, packet_sha256: HASH,
      attested_at: new Date().toISOString(),
    }]
    else if (url.includes('/production_release_approval_bindings_v6?')) body = [{
      request_id: UUID, decision_id: DECISION, attestation_id: ATTESTATION,
      source_version: HASH, packet_sha256: HASH,
    }]
    else {
      decisionReads++
      body = [{ id: DECISION, request_id: UUID,
        decision: decisionReads === 1 ? 'approved' : 'revoked',
        actor_id: UUID, actor_aal: 'aal2', artifact_hash: HASH,
        event_order: decisionReads }]
    }
    return { ok: true, status: 200, text: async () => JSON.stringify(body) }
  }
  await assert.rejects(verifyApprovedProductionRelease({
    requestId: UUID, supabaseUrl: 'https://example.supabase.co',
    serviceRoleKey: 'secret-only-on-release-server', fetcher,
    verifier: async () => packet,
  }), /latest exact AAL2 human release decision is absent/)
  assert.equal(decisionReads, 2)
})
