import { createHash } from 'node:crypto'

export const APPROVED_RELEASE_APP_CHECK = 'Approved production release (AA App)'

const SHA = /^[0-9a-f]{40}$/
const HASH = /^[0-9a-f]{64}$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

// The App check itself is the trust root. This deterministic reference binds
// its exact-head result to one AAL2 Inbox decision, packet and trusted run.
export function approvedReleaseCheckExternalId(plan, runId, runAttempt) {
  if (!UUID.test(plan?.requestId ?? '') || !Number.isSafeInteger(plan?.prNumber)
      || plan.prNumber <= 0 || !SHA.test(plan?.headSha ?? '')
      || !SHA.test(plan?.baseSha ?? '') || plan.headSha === plan.baseSha
      || !HASH.test(plan?.sourceVersion ?? '') || !HASH.test(plan?.packetSha256 ?? '')
      || !Number.isSafeInteger(runId) || runId <= 0
      || !Number.isSafeInteger(runAttempt) || runAttempt <= 0)
    throw new Error('Approved release App check has an invalid exact binding')
  const fields = [1, 'AttractAcq/AA-Console', plan.requestId, plan.prNumber,
    plan.headSha, plan.baseSha, plan.sourceVersion, plan.packetSha256,
    runId, runAttempt]
  return `aa-release-head-v1:${createHash('sha256').update(JSON.stringify(fields)).digest('hex')}`
}
