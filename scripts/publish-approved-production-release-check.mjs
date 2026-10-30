// Held source only: no CLI, workflow step, installed App or credential.
// A later custody-reviewed broker may call this only after the protected-base
// approval workflow has completed successfully. It never runs PR-head code.
import { checkApprovedProductionRelease, releaseRequestFromEvent } from './check-approved-production-release.mjs'
import {
  APPROVED_RELEASE_APP_CHECK, approvedReleaseCheckExternalId,
} from './production-release-head-check-contract.mjs'

const REPOSITORY = 'AttractAcq/AA-Console'
const API = `https://api.github.com/repos/${REPOSITORY}`
const TRUSTED_WORKFLOW = '.github/workflows/production-release-approval.yml'
const SHA = /^[0-9a-f]{40}$/

function fail(message) { throw new Error(`Approved release App check blocked: ${message}`) }
function headers(token) {
  if (typeof token !== 'string' || token.length < 20) fail('GitHub credential is absent')
  return { Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'AA-Console-approved-release-head-check',
    Authorization: `Bearer ${token}` }
}
async function githubJson(path, token, fetcher) {
  let response
  try {
    response = await fetcher(`${API}${path}`, { method: 'GET', headers: headers(token),
      redirect: 'error', signal: AbortSignal.timeout(10000) })
  } catch { fail(`GitHub read failed at ${path}`) }
  if (response.status !== 200) fail(`GitHub read returned HTTP ${response.status} at ${path}`)
  const raw = await response.text()
  if (raw.length > 2_000_000) fail('GitHub read exceeded the size limit')
  try { return JSON.parse(raw) } catch { fail('GitHub read returned invalid JSON') }
}
function assertCurrentCandidate(event, context, approved, pr, main) {
  const current = releaseRequestFromEvent({ ...event, pull_request: pr }, context)
  if (current.requestId !== approved.requestId || current.prNumber !== approved.prNumber
      || current.headSha !== approved.headSha || current.baseSha !== approved.baseSha
      || main?.name !== 'main' || main?.commit?.sha !== approved.baseSha)
    fail('current main, PR marker, head or base changed')
}
function assertTrustedRun(run, approved, workflowRunId, workflowRunAttempt, now) {
  const startedAt = Date.parse(run?.created_at)
  const finishedAt = Date.parse(run?.updated_at)
  if (run?.id !== workflowRunId || run?.run_attempt !== workflowRunAttempt
      || run?.path !== TRUSTED_WORKFLOW || run?.event !== 'pull_request_target'
      || run?.head_sha !== approved.baseSha || run?.status !== 'completed'
      || run?.conclusion !== 'success'
      || !Number.isFinite(startedAt) || !Number.isFinite(finishedAt)
      || finishedAt < startedAt || finishedAt > now + 5000
      || now - finishedAt > 15 * 60_000
      || now - startedAt > 30 * 60_000
      || run?.repository?.full_name !== REPOSITORY
      || !Array.isArray(run?.pull_requests)
      || run.pull_requests.length !== 1
      || run.pull_requests[0]?.number !== approved.prNumber
      || run.pull_requests[0]?.head?.sha !== approved.headSha
      || run.pull_requests[0]?.base?.sha !== approved.baseSha)
    fail('protected-base workflow run does not match the approved candidate')
}

// GitHub's pull_request_target job can attach to the base commit. This
// dedicated App publishes a distinct check directly on the approved PR head.
// GitHub must independently associate the completed run to the one approved
// PR/head/base. The App external_id is an additional binding, not a substitute
// for that provenance. Empty associations fail until a separately verified
// run-bound event artifact exists. The merger also re-reads AAL2 state.
export async function publishApprovedProductionReleaseHeadCheck({
  event, eventName, repository, eventSha, workflowRunId, workflowRunAttempt,
  checkoutDir, supabaseUrl, serviceRoleKey, verificationToken, appToken,
  trustedApp, checker = checkApprovedProductionRelease, fetcher = fetch,
}) {
  const context = { eventName, repository, eventSha }
  const expected = releaseRequestFromEvent(event, context)
  if (!Number.isSafeInteger(workflowRunId) || workflowRunId <= 0
      || !Number.isSafeInteger(workflowRunAttempt) || workflowRunAttempt <= 0
      || !Number.isSafeInteger(trustedApp?.id) || trustedApp.id <= 0
      || typeof trustedApp?.slug !== 'string'
      || !/^[a-z0-9-]{1,80}$/.test(trustedApp.slug)
      || typeof verificationToken !== 'string' || verificationToken.length < 20
      || typeof appToken !== 'string' || appToken.length < 20
      || verificationToken === appToken)
    fail('reviewed App, run identity or distinct credentials are absent')
  const approved = await checker({ event, ...context, checkoutDir,
    supabaseUrl, serviceRoleKey, token: verificationToken })
  if (approved?.requestId !== expected.requestId
      || approved?.prNumber !== expected.prNumber
      || approved?.headSha !== expected.headSha
      || approved?.baseSha !== expected.baseSha
      || !SHA.test(approved.headSha) || !SHA.test(approved.baseSha))
    fail('canonical approved plan differs from the event candidate')
  const externalId = approvedReleaseCheckExternalId(approved,
    workflowRunId, workflowRunAttempt)
  const [pr, main, run] = await Promise.all([
    githubJson(`/pulls/${expected.prNumber}`, verificationToken, fetcher),
    githubJson('/branches/main', verificationToken, fetcher),
    githubJson(`/actions/runs/${workflowRunId}`, verificationToken, fetcher),
  ])
  assertCurrentCandidate(event, context, approved, pr, main)
  assertTrustedRun(run, approved, workflowRunId, workflowRunAttempt, Date.now())
  // The candidate may move during the parallel reads. Check main once more
  // immediately before the App writes the head-attached result.
  const finalMain = await githubJson('/branches/main', verificationToken, fetcher)
  if (finalMain?.commit?.sha !== approved.baseSha)
    fail('main advanced before the App check was created')
  const detailsUrl = `https://github.com/${REPOSITORY}/actions/runs/${workflowRunId}`
  const body = { name: APPROVED_RELEASE_APP_CHECK, head_sha: approved.headSha,
    status: 'completed', conclusion: 'success', details_url: detailsUrl,
    external_id: externalId,
    output: { title: 'Exact AAL2 production release approved',
      summary: `Inbox request ${approved.requestId}; exact PR #${approved.prNumber}; packet SHA-256 ${approved.packetSha256}. A later merger must re-read the decision and GitHub state.` } }
  let response
  try {
    response = await fetcher(`${API}/check-runs`, { method: 'POST',
      headers: { ...headers(appToken), 'Content-Type': 'application/json' },
      redirect: 'error', signal: AbortSignal.timeout(10000), body: JSON.stringify(body) })
  } catch { fail('GitHub App check creation outcome is ambiguous; do not retry automatically') }
  if (response.status !== 201)
    fail(`GitHub App check creation returned HTTP ${response.status}`)
  const raw = await response.text()
  if (raw.length > 2_000_000) fail('GitHub App check receipt exceeded the size limit')
  let receipt
  try { receipt = JSON.parse(raw) } catch { fail('GitHub App check receipt is invalid JSON') }
  if (!Number.isSafeInteger(receipt?.id) || receipt.id <= 0
      || receipt.name !== body.name || receipt.head_sha !== body.head_sha
      || receipt.status !== 'completed' || receipt.conclusion !== 'success'
      || receipt.external_id !== externalId || receipt.details_url !== detailsUrl
      || receipt.app?.id !== trustedApp.id || receipt.app?.slug !== trustedApp.slug)
    fail('GitHub App did not return the reviewed exact-head check')
  const [afterPr, afterMain] = await Promise.all([
    githubJson(`/pulls/${expected.prNumber}`, verificationToken, fetcher),
    githubJson('/branches/main', verificationToken, fetcher),
  ])
  assertCurrentCandidate(event, context, approved, afterPr, afterMain)
  return { checkRunId: receipt.id, externalId, ...approved,
    workflowRunId, workflowRunAttempt }
}
