#!/usr/bin/env node

// Runs only from the protected default-branch checkout in pull_request_target.
// The PR commit is fetched as Git data; no PR file is checked out or executed.
import { readFileSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { verifyApprovedProductionRelease } from './production-release-attestation.mjs'

const REPOSITORY = 'AttractAcq/AA-Console'
const SHA = /^[0-9a-f]{40}$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const MARKER = /^AA-Release-Request: ([0-9a-f-]+)$/i

function fail(message) { throw new Error(`Trusted release check blocked: ${message}`) }

export function releaseRequestFromEvent(event, { eventName, repository, eventSha }) {
  if (eventName !== 'pull_request_target' || repository !== REPOSITORY
      || event?.repository?.full_name !== REPOSITORY)
    fail('event is not a trusted pull_request_target for this repository')
  const pr = event.pull_request
  if (!Number.isSafeInteger(event.number) || event.number <= 0
      || pr?.number !== event.number || pr?.state !== 'open' || pr?.draft !== false
      || pr?.html_url !== `https://github.com/${REPOSITORY}/pull/${event.number}`
      || pr?.base?.ref !== 'main' || pr?.base?.repo?.full_name !== REPOSITORY
      || pr?.head?.repo?.full_name !== REPOSITORY
      || !SHA.test(pr?.head?.sha ?? '') || !SHA.test(pr?.base?.sha ?? '')
      || eventSha !== pr.base.sha || pr.head.sha === pr.base.sha)
    fail('PR, protected base or exact event commits are invalid')
  if (typeof pr.body !== 'string' || pr.body.length > 256_000)
    fail('PR body is missing or too large')
  const markers = pr.body.split(/\r?\n/).map((line) => MARKER.exec(line))
    .filter(Boolean).map((match) => match[1])
  if (markers.length !== 1 || !UUID.test(markers[0]))
    fail('PR body must contain exactly one AA-Release-Request: UUID line')
  return { requestId: markers[0].toLowerCase(), prNumber: event.number,
    headSha: pr.head.sha, baseSha: pr.base.sha }
}

export async function checkApprovedProductionRelease({
  event, eventName, repository, eventSha, checkoutDir = process.cwd(),
  supabaseUrl, serviceRoleKey, token, verifier = verifyApprovedProductionRelease,
}) {
  const expected = releaseRequestFromEvent(event, { eventName, repository, eventSha })
  const result = await verifier({ requestId: expected.requestId,
    checkoutDir: resolve(checkoutDir), supabaseUrl, serviceRoleKey, token,
    trustedBaseCheckout: true })
  if (result.requestId !== expected.requestId || result.prNumber !== expected.prNumber
      || result.headSha !== expected.headSha || result.baseSha !== expected.baseSha)
    fail('latest approved release differs from the event PR and commits')
  return { requestId: result.requestId, prNumber: result.prNumber,
    headSha: result.headSha, baseSha: result.baseSha,
    sourceVersion: result.sourceVersion, packetSha256: result.packetSha256 }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    if (process.argv.length !== 2 || !process.env.GITHUB_EVENT_PATH)
      fail('this check must be invoked by the trusted GitHub workflow')
    if (statSync(process.env.GITHUB_EVENT_PATH).size > 1_000_000)
      fail('GitHub event payload is too large')
    const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'))
    const result = await checkApprovedProductionRelease({ event,
      eventName: process.env.GITHUB_EVENT_NAME,
      repository: process.env.GITHUB_REPOSITORY,
      eventSha: process.env.GITHUB_SHA,
      supabaseUrl: process.env.SUPABASE_URL,
      serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY,
      token: process.env.GITHUB_TOKEN,
    })
    process.stdout.write(`${JSON.stringify(result)}\n`)
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
