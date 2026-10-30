#!/usr/bin/env node

// B008 trusted operator bridge. The browser never supplies the GitHub proof:
// this process fetches it itself and submits it with a server-only credential.
// The database repeats the binding checks before a human can decide the card.
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const SHA = /^[0-9a-f]{40}$/
const HASH = /^[0-9a-f]{64}$/
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const CHECK_NAMES = Object.freeze([
  'Agent runtime (typecheck, test, build)',
  'Frontend (lint, typecheck, test, build)',
  'MCP gateway (typecheck, test, build)',
  'Schema replay (clean, upgrade, catalog, types)',
])

function fail(message) { throw new Error(`Release attestation blocked: ${message}`) }
function object(value) { return !!value && typeof value === 'object' && !Array.isArray(value) }
function sameMigrations(left, right) {
  return left.length === right.length && left.every((entry, index) =>
    entry?.version === right[index]?.version
    && entry?.filename === right[index]?.filename
    && entry?.sha256 === right[index]?.sha256)
}

export function assertPremergePacketMatchesCandidate(packet, candidate) {
  if (!object(packet) || packet.schemaVersion !== 1
      || packet.kind !== 'github_premerge_release_evidence'
      || packet.releaseAuthorized !== false
      || packet.productionSchemaVerified !== false
      || packet.futureDeploymentSha !== null
      || !HASH.test(packet.packetSha256 ?? '')) fail('GitHub proof has an invalid or overclaimed shape')
  if (!object(candidate) || !object(candidate.pr) || !object(candidate.schema)
      || !object(candidate.deployment) || !Array.isArray(candidate.checks)
      || !Array.isArray(candidate.migrations)) fail('candidate is incomplete')
  if (candidate.repository !== 'AttractAcq/AA-Console'
      || packet.repository?.fullName !== candidate.repository
      || packet.pr?.number !== Number(candidate.pr.number)
      || packet.pr?.url !== candidate.pr.url
      || packet.pr?.head?.sha !== candidate.pr.head_sha
      || packet.pr?.base?.sha !== candidate.pr.base_sha
      || packet.premergePrHeadSha !== candidate.pr.head_sha
      || !SHA.test(candidate.pr.head_sha ?? '')
      || !SHA.test(candidate.pr.base_sha ?? '')
      || candidate.deployment.browser_pr_head_sha !== candidate.pr.head_sha) {
    fail('repository, PR, base, head or browser release pin changed')
  }
  if (!object(packet.checks) || !Array.isArray(packet.checks.required)
      || packet.checks.required.length !== CHECK_NAMES.length
      || candidate.checks.length !== CHECK_NAMES.length
      || !/^[1-9][0-9]*$/.test(String(packet.checks.workflowRunId ?? ''))
      || !HASH.test(packet.checks.workflowSha256 ?? '')) fail('CI proof is incomplete')
  const seen = new Set()
  for (const required of packet.checks.required) {
    if (!CHECK_NAMES.includes(required?.name) || seen.has(required.name))
      fail('required CI jobs are missing or duplicated')
    seen.add(required.name)
    if (required.headSha !== candidate.pr.head_sha
        || String(required.runId) !== String(packet.checks.workflowRunId)
        || !Number.isSafeInteger(required.checkRunId) || required.checkRunId <= 0)
      fail('CI job is not part of the exact-head protected run')
    const claim = candidate.checks.find((entry) => entry.name === required.name)
    if (!claim || claim.head_sha !== required.headSha
        || String(claim.run_id) !== String(required.runId)
        || claim.conclusion !== 'success') fail('candidate CI claims disagree with GitHub')
  }
  if (new Set(candidate.checks.map((entry) => entry.name)).size !== CHECK_NAMES.length)
    fail('candidate CI checks are duplicated')
  if (!object(packet.migrations) || !Array.isArray(packet.migrations.pending)
      || packet.migrations.sourceMarkerHead !== candidate.schema.current_head
      || packet.migrations.targetHead !== candidate.schema.target_head
      || !sameMigrations(packet.migrations.pending, candidate.migrations))
    fail('candidate SQL versions or byte hashes disagree with committed GitHub proof')
  return true
}

async function jsonResponse(response, label) {
  if (!response.ok) fail(`${label} returned HTTP ${response.status}`)
  const raw = await response.text()
  if (raw.length > 256_000) fail(`${label} response is too large`)
  try { return JSON.parse(raw) } catch { fail(`${label} returned invalid JSON`) }
}

function validatedSupabaseUrl(url) {
  const parsed = new URL(url)
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password
      || parsed.search || parsed.hash) fail('Supabase URL must be a bare HTTPS origin')
  return parsed.origin
}

export async function attestProductionRelease({
  requestId, supabaseUrl, serviceRoleKey, token,
  checkoutDir = process.cwd(), fetcher = fetch, verifier,
}) {
  if (!ID.test(requestId ?? '')) fail('request ID is invalid')
  if (typeof serviceRoleKey !== 'string' || serviceRoleKey.length < 20)
    fail('server-only Supabase credential is missing')
  const origin = validatedSupabaseUrl(supabaseUrl)
  const headers = { apikey: serviceRoleKey, Authorization: `Bearer ${serviceRoleKey}` }
  const sourceResponse = await fetcher(`${origin}/rest/v1/approval_requests_v6?id=eq.${requestId}&select=id,source_system,source_kind,source_id,source_version`, {
    method: 'GET', headers, redirect: 'error', signal: AbortSignal.timeout(10000),
  })
  const requests = await jsonResponse(sourceResponse, 'approval request read')
  if (!Array.isArray(requests) || requests.length !== 1
      || requests[0]?.id !== requestId || requests[0]?.source_system !== 'aa_console'
      || requests[0]?.source_kind !== 'production_release'
      || !ID.test(requests[0]?.source_id ?? '')) fail('request is not one production release card')
  const sourceResponse2 = await fetcher(`${origin}/rest/v1/production_release_candidates_v6?id=eq.${requests[0].source_id}&select=id,candidate,version_hash`, {
    method: 'GET', headers, redirect: 'error', signal: AbortSignal.timeout(10000),
  })
  const sources = await jsonResponse(sourceResponse2, 'release candidate read')
  if (!Array.isArray(sources) || sources.length !== 1
      || sources[0]?.id !== requests[0].source_id
      || sources[0]?.version_hash !== requests[0].source_version)
    fail('release source is missing or superseded')
  const candidate = sources[0].candidate
  const verified = verifier ?? (await import('./verify-github-release-candidate.mjs')).verifyGithubReleaseCandidate
  const packet = await verified({
    prNumber: Number(candidate?.pr?.number), checkoutDir: resolve(checkoutDir), token,
  })
  assertPremergePacketMatchesCandidate(packet, candidate)
  const attestationResponse = await fetcher(`${origin}/rest/v1/rpc/record_trusted_production_release_attestation_v6`, {
    method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ p_request_id: requestId, p_packet: packet }),
    redirect: 'error', signal: AbortSignal.timeout(10000),
  })
  const attestationId = await jsonResponse(attestationResponse, 'trusted attestation write')
  if (!ID.test(attestationId ?? '')) fail('database did not return an attestation ID')
  return { requestId, attestationId, packetSha256: packet.packetSha256 }
}

// Read-only premerge assertion for the future required GitHub release check.
// It never merges. Calling it by hand is advisory until GitHub protection
// makes the check mandatory and Railway/Pages have their own effect gates.
export async function verifyApprovedProductionRelease({
  requestId, supabaseUrl, serviceRoleKey, token,
  checkoutDir = process.cwd(), fetcher = fetch, verifier,
}) {
  if (!ID.test(requestId ?? '')) fail('request ID is invalid')
  if (typeof serviceRoleKey !== 'string' || serviceRoleKey.length < 20)
    fail('server-only Supabase credential is missing')
  const origin = validatedSupabaseUrl(supabaseUrl)
  const headers = { apikey: serviceRoleKey, Authorization: `Bearer ${serviceRoleKey}` }
  async function read(table, query, label) {
    const response = await fetcher(`${origin}/rest/v1/${table}?${query}`, {
      method: 'GET', headers, redirect: 'error', signal: AbortSignal.timeout(10000),
    })
    const rows = await jsonResponse(response, label)
    if (!Array.isArray(rows) || rows.length !== 1) fail(`${label} is missing or ambiguous`)
    return rows[0]
  }
  async function card() {
    const row = await read('approval_inbox_v6',
      `id=eq.${requestId}&select=id,source_system,source_kind,source_id,source_version,artifact_hash,status,source_state,preview_blocker,preview,expires_at,client_id,owner_role`,
      'canonical release card')
    if (row.id !== requestId || row.source_system !== 'aa_console'
        || row.source_kind !== 'production_release' || row.client_id !== null
        || row.owner_role !== 'admin' || !ID.test(row.source_id ?? '')
        || row.status !== 'approved'
        || row.source_state !== 'pending' || row.preview_blocker !== null
        || !HASH.test(row.source_version ?? '')
        || row.artifact_hash !== row.source_version
        || !Number.isFinite(Date.parse(row.expires_at))
        || Date.parse(row.expires_at) <= Date.now())
      fail('canonical release approval is absent, held, expired or revoked')
    return row
  }
  const before = await card()
  const source = await read('production_release_candidates_v6',
    `id=eq.${before.source_id}&select=id,candidate,version_hash,expires_at`,
    'release candidate source')
  if (source.id !== before.source_id || source.version_hash !== before.source_version
      || source.expires_at !== before.expires_at)
    fail('approved source is missing or superseded')
  const attestation = await read('production_release_attestations_v6',
    `request_id=eq.${requestId}&select=request_id,source_version,packet,packet_sha256,attested_at&order=event_order.desc&limit=1`,
    'trusted GitHub attestation')
  if (attestation.request_id !== requestId
      || attestation.source_version !== before.source_version
      || !HASH.test(attestation.packet_sha256 ?? '')
      || attestation.packet?.packetSha256 !== attestation.packet_sha256
      || !Number.isFinite(Date.parse(attestation.attested_at))
      || Date.now() - Date.parse(attestation.attested_at) > 15 * 60_000
      || Date.parse(attestation.attested_at) > Date.now() + 5000)
    fail('trusted GitHub attestation is stale or mismatched')
  const decision = await read('approval_decision_events_v6',
    `request_id=eq.${requestId}&select=request_id,decision,actor_id,actor_aal,artifact_hash,event_order&order=event_order.desc&limit=1`,
    'human release decision')
  if (decision.request_id !== requestId || decision.decision !== 'approved'
      || decision.actor_aal !== 'aal2' || !ID.test(decision.actor_id ?? '')
      || decision.artifact_hash !== before.source_version)
    fail('latest exact AAL2 human release decision is absent')
  assertPremergePacketMatchesCandidate(attestation.packet, source.candidate)
  const verified = verifier ?? (await import('./verify-github-release-candidate.mjs')).verifyGithubReleaseCandidate
  const currentPacket = await verified({
    prNumber: Number(source.candidate.pr.number),
    checkoutDir: resolve(checkoutDir), token,
  })
  assertPremergePacketMatchesCandidate(currentPacket, source.candidate)
  if (currentPacket.packetSha256 !== attestation.packet_sha256)
    fail('GitHub PR, CI or committed SQL changed after human approval')
  const after = await card()
  if (after.source_version !== before.source_version
      || after.artifact_hash !== before.artifact_hash
      || JSON.stringify(after.preview) !== JSON.stringify(before.preview))
    fail('canonical release card changed during premerge verification')
  return {
    requestId, prNumber: Number(source.candidate.pr.number),
    headSha: currentPacket.pr.head.sha, baseSha: currentPacket.pr.base.sha,
    sourceVersion: before.source_version,
    packetSha256: currentPacket.packetSha256,
    mergeMethod: source.candidate.pr.merge_method,
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const requestId = process.argv[2]
  if (process.argv.length !== 3) fail('usage: node scripts/production-release-attestation.mjs REQUEST_UUID')
  try {
    const result = await attestProductionRelease({
      requestId,
      supabaseUrl: process.env.SUPABASE_URL,
      serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY,
      token: process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN ?? null,
    })
    process.stdout.write(`${JSON.stringify(result)}\n`)
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
