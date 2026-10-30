// Held B008 merger. There is intentionally no CLI or workflow entry point.
// Credential custody, protected-check activation and deployment interlocks
// must be reviewed before an operator can wire this to a production runner.
import { attestProductionRelease, verifyApprovedProductionRelease } from './production-release-attestation.mjs'
import { REQUIRED_RELEASE_CHECKS } from './verify-github-release-candidate.mjs'

const REPOSITORY = 'AttractAcq/AA-Console'
const API = `https://api.github.com/repos/${REPOSITORY}`
const SHA = /^[0-9a-f]{40}$/
const HASH = /^[0-9a-f]{64}$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const TRUSTED_CHECK = 'Approved production release (trusted)'
const TRUSTED_WORKFLOW = '.github/workflows/production-release-approval.yml'

function fail(message) { throw new Error(`Trusted production merge blocked: ${message}`) }
function samePlan(a, b) {
  return a.requestId === b.requestId && a.prNumber === b.prNumber
    && a.headSha === b.headSha && a.baseSha === b.baseSha
    && a.sourceVersion === b.sourceVersion
    && a.packetSha256 === b.packetSha256 && a.mergeMethod === b.mergeMethod
}
function validPlan(plan, requestId) {
  return !!plan && plan.requestId === requestId && Number.isSafeInteger(plan.prNumber)
    && plan.prNumber > 0 && SHA.test(plan.headSha ?? '')
    && SHA.test(plan.baseSha ?? '') && plan.headSha !== plan.baseSha
    && HASH.test(plan.sourceVersion ?? '') && HASH.test(plan.packetSha256 ?? '')
    && ['merge', 'squash', 'rebase'].includes(plan.mergeMethod)
}

async function jsonResponse(response, label, expectedStatus = 200) {
  if (response.status !== expectedStatus) fail(`${label} returned HTTP ${response.status}`)
  const raw = await response.text()
  if (raw.length > 2_000_000) fail(`${label} response exceeds limit`)
  try { return JSON.parse(raw) } catch { fail(`${label} returned invalid JSON`) }
}

function githubHeaders(token) {
  if (typeof token !== 'string' || token.length < 20) fail('GitHub merger credential is absent')
  return { Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'AA-Console-trusted-release-merger',
    Authorization: `Bearer ${token}` }
}

async function githubGet(path, token, fetcher) {
  const url = path === '/user' ? 'https://api.github.com/user' : `${API}${path}`
  const response = await fetcher(url, { method: 'GET',
    headers: githubHeaders(token), redirect: 'error', signal: AbortSignal.timeout(10000) })
  return jsonResponse(response, `GitHub ${path}`)
}

function checkRunId(run) {
  const match = /^https:\/\/github\.com\/AttractAcq\/AA-Console\/actions\/runs\/([1-9]\d*)\/job\/([1-9]\d*)$/.exec(run.details_url ?? '')
  if (!match || Number(match[2]) !== run.id) fail('trusted check lacks a GitHub Actions run identity')
  return Number(match[1])
}

// A green check is only a snapshot. This read is repeated after the database
// lease has made human revocation mutually exclusive with the merge attempt.
export function assertProtectedReleaseBoundary({ plan, branch, pr, protection,
  checks, trustedRun, actor, mergerLogin }) {
  if (typeof mergerLogin !== 'string' || !/^[A-Za-z0-9-]{1,39}$/.test(mergerLogin)
      || actor?.login !== mergerLogin || actor?.type !== 'User')
    fail('merger token is not the sole reviewed service user')
  if (branch?.name !== 'main' || branch?.commit?.sha !== plan.baseSha
      || pr?.number !== plan.prNumber || pr?.state !== 'open' || pr?.draft !== false
      || pr?.merged_at != null || pr?.mergeable !== true
      || pr?.mergeable_state !== 'clean' || pr?.base?.ref !== 'main'
      || pr?.base?.sha !== plan.baseSha || pr?.head?.sha !== plan.headSha
      || pr?.head?.repo?.full_name !== REPOSITORY
      || pr?.base?.repo?.full_name !== REPOSITORY)
    fail('current main, PR base or PR head changed')
  const required = protection?.required_status_checks
  if (required?.strict !== true || protection?.enforce_admins?.enabled !== true
      || protection?.allow_force_pushes?.enabled === true
      || protection?.allow_deletions?.enabled === true)
    fail('strict required checks or protected main safeguards are absent')
  const restriction = protection?.restrictions
  if (!Array.isArray(restriction?.users) || restriction.users.length !== 1
      || restriction.users[0]?.login !== mergerLogin
      || !Array.isArray(restriction.teams) || restriction.teams.length !== 0
      || !Array.isArray(restriction.apps) || restriction.apps.length !== 0)
    fail('main permits a direct merge identity outside the reviewed merger')
  if (!Array.isArray(required.checks) || !Array.isArray(checks?.check_runs)
      || !Number.isSafeInteger(checks.total_count)
      || checks.total_count !== checks.check_runs.length || checks.total_count > 100)
    fail('protected check evidence is incomplete')
  const requiredNames = [...REQUIRED_RELEASE_CHECKS, TRUSTED_CHECK]
  if (new Set(required.checks.map((check) => check.context)).size !== required.checks.length)
    fail('required check names are duplicated')
  if (required.checks.length !== requiredNames.length
      || required.checks.some((check) => !requiredNames.includes(check.context)))
    fail('protected check policy changed outside the reviewed release plan')
  for (const name of requiredNames) {
    const rules = required.checks.filter((check) => check.context === name)
    const runs = checks.check_runs.filter((check) => check.name === name)
    if (rules.length !== 1 || runs.length !== 1) fail(`required check ${name} is absent or duplicated`)
    const [rule] = rules; const [run] = runs
    if (!Number.isSafeInteger(rule.app_id) || rule.app_id <= 0
        || run.app?.id !== rule.app_id || run.app?.slug !== 'github-actions'
        || run.head_sha !== plan.headSha || run.status !== 'completed'
        || run.conclusion !== 'success' || !Number.isSafeInteger(run.id) || run.id <= 0)
      fail(`required check ${name} is not green on the exact PR head from its pinned app`)
  }
  const trusted = checks.check_runs.find((check) => check.name === TRUSTED_CHECK)
  if (trustedRun?.id !== checkRunId(trusted)
      || trustedRun?.path !== TRUSTED_WORKFLOW
      || trustedRun?.event !== 'pull_request_target'
      || trustedRun?.status !== 'completed' || trustedRun?.conclusion !== 'success'
      || trustedRun?.repository?.full_name !== REPOSITORY)
    fail('trusted check is not the protected-base release workflow')
  return true
}

// Read-only GitHub boundary used both before and immediately after the lease.
// The protected check currently runs on pull_request_target; if GitHub does
// not attach that check to the PR head, this fails closed until a live pilot
// establishes a safe required-check topology.
export async function readProtectedReleaseBoundary({ plan, token, mergerLogin,
  fetcher = fetch }) {
  if (!validPlan(plan, plan?.requestId)) fail('approved merge plan is incomplete')
  const [branch, pr, protection, checks, actor] = await Promise.all([
    githubGet('/branches/main', token, fetcher),
    githubGet(`/pulls/${plan.prNumber}`, token, fetcher),
    githubGet('/branches/main/protection', token, fetcher),
    githubGet(`/commits/${plan.headSha}/check-runs?filter=latest&per_page=100`, token, fetcher),
    githubGet('/user', token, fetcher),
  ])
  const trusted = checks?.check_runs?.find((check) => check.name === TRUSTED_CHECK)
  if (!trusted) fail('trusted release check is absent')
  const trustedRun = await githubGet(`/actions/runs/${checkRunId(trusted)}`, token, fetcher)
  assertProtectedReleaseBoundary({ plan, branch, pr, protection,
    checks, trustedRun, actor, mergerLogin })
  const finalBranch = await githubGet('/branches/main', token, fetcher)
  if (finalBranch?.commit?.sha !== plan.baseSha)
    fail('main advanced during protected release boundary read')
  return true
}

export function createProductionReleaseLeaseStore({ supabaseUrl, serviceRoleKey,
  fetcher = fetch }) {
  const origin = new URL(supabaseUrl)
  if (origin.protocol !== 'https:' || origin.username || origin.password
      || origin.search || origin.hash || origin.pathname !== '/')
    fail('Supabase origin must be bare HTTPS')
  if (typeof serviceRoleKey !== 'string' || serviceRoleKey.length < 20)
    fail('server-only Supabase credential is absent')
  async function rpc(name, body) {
    const response = await fetcher(`${origin.origin}/rest/v1/rpc/${name}`, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10000),
      headers: { apikey: serviceRoleKey, Authorization: `Bearer ${serviceRoleKey}`,
        'Content-Type': 'application/json' }, body: JSON.stringify(body),
    })
    const result = await jsonResponse(response, `lease RPC ${name}`)
    if (!UUID.test(result ?? '')) fail(`lease RPC ${name} returned an invalid ID`)
    return result
  }
  return {
    acquire: (plan) => rpc('acquire_production_release_merge_lease_v6', {
      p_request_id: plan.requestId, p_source_version: plan.sourceVersion,
      p_packet_sha256: plan.packetSha256, p_pr_number: plan.prNumber,
      p_head_sha: plan.headSha, p_base_sha: plan.baseSha,
      p_merge_method: plan.mergeMethod,
    }),
    dispatch: (leaseId) => rpc('dispatch_production_release_merge_lease_v6',
      { p_lease_id: leaseId }),
    abort: (leaseId, reason) => rpc('abort_production_release_merge_lease_v6',
      { p_lease_id: leaseId, p_reason: reason }),
    complete: (leaseId, sha) => rpc('complete_production_release_merge_lease_v6',
      { p_lease_id: leaseId, p_observed_merge_sha: sha }),
  }
}

// A future reviewed runner may supply this transport. This module itself has
// no executable entry point and the repository installs no merger credential.
export function createGithubMergeEffect({ token, fetcher = fetch }) {
  return async (plan) => {
    const response = await fetcher(`${API}/pulls/${plan.prNumber}/merge`, {
      method: 'PUT', redirect: 'error', signal: AbortSignal.timeout(10000),
      headers: { ...githubHeaders(token), 'Content-Type': 'application/json' },
      body: JSON.stringify({ sha: plan.headSha, merge_method: plan.mergeMethod }),
    })
    const merged = await jsonResponse(response, 'GitHub merge')
    if (merged.merged !== true || !SHA.test(merged.sha ?? ''))
      fail('GitHub merge response is not an exact commit receipt')
    return merged.sha
  }
}

export async function readObservedGithubMerge({ plan, proposedSha, token,
  fetcher = fetch }) {
  if (!SHA.test(proposedSha ?? '')) fail('merge result has no full commit SHA')
  const [pr, comparison] = await Promise.all([
    githubGet(`/pulls/${plan.prNumber}`, token, fetcher),
    githubGet(`/compare/${proposedSha}...main`, token, fetcher),
  ])
  if (pr?.number !== plan.prNumber || pr?.state !== 'closed'
      || !Number.isFinite(Date.parse(pr?.merged_at))
      || pr?.head?.sha !== plan.headSha || pr?.merge_commit_sha !== proposedSha
      || !['ahead', 'identical'].includes(comparison?.status)
      || comparison?.base_commit?.sha !== proposedSha
      || !Number.isSafeInteger(comparison?.ahead_by)
      || comparison?.behind_by !== 0)
    fail('merged PR and current main do not prove the expected commit')
  return proposedSha
}

// The lease acquire serializes a concurrent human revocation with the exact
// decision. While active or dispatched, the database rejects new revocations.
// A failed/ambiguous post-dispatch GitHub call remains unresolved; never
// retry the merge or abort that lease without independent reconciliation.
export async function runTrustedProductionReleaseMerger({ requestId, attester,
  verifier, boundary, lease, mergeEffect, observeMerge }) {
  if (!UUID.test(requestId ?? '') || typeof attester !== 'function'
      || typeof verifier !== 'function' || typeof boundary !== 'function'
      || !lease || typeof lease.acquire !== 'function'
      || typeof lease.dispatch !== 'function' || typeof lease.abort !== 'function'
      || typeof lease.complete !== 'function'
      || typeof mergeEffect !== 'function' || typeof observeMerge !== 'function')
    fail('trusted merger dependencies are incomplete')
  await attester(requestId)
  const first = await verifier(requestId)
  if (!validPlan(first, requestId)) fail('first canonical AAL2 plan is invalid')
  await boundary(first)
  const leaseId = await lease.acquire(first)
  if (!UUID.test(leaseId ?? '')) fail('acquired merge lease ID is invalid')
  let dispatchStarted = false
  try {
    const latest = await verifier(requestId)
    if (!validPlan(latest, requestId) || !samePlan(first, latest))
      fail('exact AAL2 decision, packet, PR or base changed after lease acquisition')
    await boundary(latest)
    // This is the last database check before the external call. Its row lock
    // also checks fresh proof and source expiry. Revocation remains blocked.
    dispatchStarted = true
    if (await lease.dispatch(leaseId) !== leaseId)
      fail('lease dispatch returned another identity')
  } catch (error) {
    if (!dispatchStarted) {
      await lease.abort(leaseId, `Pre-dispatch verification failed: ${error.message}`)
    }
    throw error
  }
  // No DB read can atomically protect GitHub main; the merge API must receive
  // the exact head SHA, and strict up-to-date protection must remain enabled.
  const proposedSha = await mergeEffect(first)
  const observedSha = await observeMerge(first, proposedSha)
  if (!SHA.test(observedSha ?? '') || observedSha !== proposedSha)
    fail('GitHub readback does not match the merge response')
  if (await lease.complete(leaseId, observedSha) !== leaseId)
    fail('lease completion returned another identity')
  return { requestId, leaseId, prNumber: first.prNumber,
    headSha: first.headSha, baseSha: first.baseSha, packetSha256: first.packetSha256,
    observedMergeSha: observedSha }
}

// Explicit wiring for a later custody-reviewed runner; not invoked anywhere.
export async function mergeApprovedProductionRelease({ requestId, supabaseUrl,
  serviceRoleKey, token, checkoutDir, mergerLogin, fetcher = fetch }) {
  const options = { requestId, supabaseUrl, serviceRoleKey, token,
    checkoutDir, trustedBaseCheckout: true, fetcher }
  return runTrustedProductionReleaseMerger({ requestId,
    attester: () => attestProductionRelease({ ...options, refreshApproved: true }),
    verifier: () => verifyApprovedProductionRelease(options),
    boundary: (plan) => readProtectedReleaseBoundary({ plan, token, mergerLogin, fetcher }),
    lease: createProductionReleaseLeaseStore({ supabaseUrl, serviceRoleKey, fetcher }),
    mergeEffect: createGithubMergeEffect({ token, fetcher }),
    observeMerge: (plan, proposedSha) => readObservedGithubMerge({ plan, proposedSha, token, fetcher }),
  })
}
