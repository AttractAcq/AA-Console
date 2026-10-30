import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { canonicalJson, REQUIRED_RELEASE_CHECKS, verifyGithubReleaseCandidate } from './verify-github-release-candidate.mjs'

const REPO = 'AttractAcq/AA-Console'
const RELEASED = '20261030160000'
const SQL_280 = 'create table public.first_release_test (id integer);\n'
const SQL_281 = 'create table public.second_release_test (id integer);\n'
const hash = (value) => createHash('sha256').update(value).digest('hex')

function git(directory, ...args) {
  return execFileSync('git', ['-C', directory, ...args], { encoding: 'utf8' }).trim()
}

function checkoutFixture(t, { releaseWorkflow = false } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'aa-release-verifier-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  git(directory, 'init', '-q')
  git(directory, 'config', 'user.name', 'Fixture')
  git(directory, 'config', 'user.email', 'fixture@example.invalid')
  mkdirSync(join(directory, 'supabase', 'migrations'), { recursive: true })
  mkdirSync(join(directory, 'supabase', 'verification'), { recursive: true })
  mkdirSync(join(directory, '.github', 'workflows'), { recursive: true })
  writeFileSync(join(directory, '.github', 'workflows', 'ci.yml'), 'name: CI\n')
  if (releaseWorkflow) {
    writeFileSync(join(directory, '.github', 'workflows', 'production-release-approval.yml'),
      'name: Production release approval\n')
    mkdirSync(join(directory, 'scripts'), { recursive: true })
    for (const path of [
      'check-approved-production-release.mjs',
      'verify-approved-production-release.mjs',
      'production-release-attestation.mjs',
      'verify-github-release-candidate.mjs',
    ]) writeFileSync(join(directory, 'scripts', path), '// trusted release gate\n')
  }
  writeFileSync(join(directory, 'supabase', 'verification', 'released-migration-version.txt'), `${RELEASED}\n`)
  writeFileSync(join(directory, 'supabase', 'migrations', `${RELEASED}_279_approval.sql`), 'select 1;\n')
  // A stacked PR inherits 280 from its base and adds 281 itself. Both must
  // appear in the packet, not just the PR diff.
  writeFileSync(join(directory, 'supabase', 'migrations', '20261101000000_280_first.sql'), SQL_280)
  git(directory, 'add', '.')
  git(directory, 'commit', '-qm', 'released')
  const baseSha = git(directory, 'rev-parse', 'HEAD')
  writeFileSync(join(directory, 'supabase', 'migrations', '20261101010000_281_second.sql'), SQL_281)
  git(directory, 'add', '.')
  git(directory, 'commit', '-qm', 'pending')
  return { directory, baseSha, headSha: git(directory, 'rev-parse', 'HEAD') }
}

function apiFixture(checkout) {
  const { baseSha, headSha } = checkout
  const repository = { id: 42, full_name: REPO }
  const pr = {
    number: 7, state: 'open', merged_at: null,
    html_url: `https://github.com/${REPO}/pull/7`,
    head: { sha: headSha, ref: 'feature', repo: { id: 42, full_name: REPO } },
    base: { sha: baseSha, ref: 'main', repo: { id: 42, full_name: REPO } },
  }
  const checks = REQUIRED_RELEASE_CHECKS.map((name, index) => ({
    id: 1001 + index, name, head_sha: headSha, status: 'completed',
    conclusion: 'success', app: { slug: 'github-actions' },
    details_url: `https://github.com/${REPO}/actions/runs/6001/job/${1001 + index}`,
  }))
  const workflow = {
    id: 6001, name: 'CI', path: '.github/workflows/ci.yml', event: 'pull_request',
    head_sha: headSha, status: 'completed', conclusion: 'success',
    head_repository: { id: 42, full_name: REPO },
    pull_requests: [{ number: 7, head: { sha: headSha }, base: { sha: baseSha } }],
  }
  return { repository, pr, checks, workflow }
}

function fetchFixture(data, overrides = {}) {
  return async (rawUrl, request) => {
    assert.equal(request.method, 'GET')
    assert.equal(request.redirect, 'error')
    const url = new URL(rawUrl)
    const path = `${url.pathname}${url.search}`
    if (overrides[path]) return Response.json(overrides[path])
    if (url.pathname === `/repos/${REPO}`) return Response.json(data.repository)
    if (url.pathname === `/repos/${REPO}/pulls/7`) return Response.json(data.pr)
    if (url.pathname.endsWith('/check-runs')) return Response.json({ total_count: data.checks.length, check_runs: data.checks })
    if (url.pathname === `/repos/${REPO}/actions/runs/6001`) return Response.json(data.workflow)
    return Response.json({ error: 'unexpected fixture request' }, { status: 404 })
  }
}

async function verify(checkout, data = apiFixture(checkout), fetcher = fetchFixture(data)) {
  return verifyGithubReleaseCandidate({ prNumber: 7, checkoutDir: checkout.directory, fetcher })
}

test('produces deterministic typed premerge evidence from GitHub and committed SQL bytes', async (t) => {
  const checkout = checkoutFixture(t)
  const packet = await verify(checkout)
  assert.equal(packet.premergePrHeadSha, checkout.headSha)
  assert.equal(packet.futureDeploymentSha, null)
  assert.equal(packet.productionSchemaVerified, false)
  assert.equal(packet.releaseAuthorized, false)
  assert.equal(packet.checks.workflowRunId, '6001')
  assert.equal(packet.checks.workflowSha256, hash('name: CI\n'))
  assert.deepEqual(packet.checks.required.map((item) => item.name), REQUIRED_RELEASE_CHECKS)
  assert.equal(packet.migrations.sourceMarkerHead, RELEASED)
  assert.equal(packet.migrations.targetHead, '20261101010000')
  assert.deepEqual(packet.migrations.pending.map((item) => item.sha256), [hash(SQL_280), hash(SQL_281)])
  const { packetSha256, ...body } = packet
  assert.equal(packetSha256, hash(canonicalJson(body)))
  assert.deepEqual(await verify(checkout), packet)
})

test('hashes the committed PR tree even when a local SQL file was edited after checkout', async (t) => {
  const checkout = checkoutFixture(t)
  writeFileSync(join(checkout.directory, 'supabase', 'migrations', '20261101000000_280_first.sql'), 'uncommitted edit\n')
  const packet = await verify(checkout)
  assert.equal(packet.migrations.pending[0].sha256, hash(SQL_280))
})

test('trusted base mode reads the PR commit as data without checking it out', async (t) => {
  const checkout = checkoutFixture(t)
  git(checkout.directory, 'checkout', '--detach', checkout.baseSha)
  const packet = await verifyGithubReleaseCandidate({ prNumber: 7,
    checkoutDir: checkout.directory, fetcher: fetchFixture(apiFixture(checkout)),
    trustedBaseCheckout: true })
  assert.equal(packet.pr.head.sha, checkout.headSha)
  assert.equal(git(checkout.directory, 'rev-parse', 'HEAD'), checkout.baseSha)
  await assert.rejects(verify(checkout), /checked-out HEAD differs from the GitHub PR head/)
})

test('trusted base mode rejects a checkout that is not the exact GitHub PR base', async (t) => {
  const checkout = checkoutFixture(t)
  await assert.rejects(verifyGithubReleaseCandidate({ prNumber: 7,
    checkoutDir: checkout.directory, fetcher: fetchFixture(apiFixture(checkout)),
    trustedBaseCheckout: true }), /trusted checkout HEAD differs/)
})

test('fails closed on missing, duplicate, pending, failed, wrong-SHA and wrong-app required checks', async (t) => {
  const checkout = checkoutFixture(t)
  for (const [label, change] of [
    ['missing', (data) => data.checks.pop()],
    ['duplicated', (data) => data.checks.push({ ...data.checks[0], id: 1999,
      details_url: `https://github.com/${REPO}/actions/runs/6001/job/1999` })],
    ['pending', (data) => { data.checks[0].status = 'in_progress'; data.checks[0].conclusion = null }],
    ['failed', (data) => { data.checks[0].conclusion = 'failure' }],
    ['wrong SHA', (data) => { data.checks[0].head_sha = 'a'.repeat(40) }],
    ['wrong app', (data) => { data.checks[0].app.slug = 'another-app' }],
  ]) {
    const data = apiFixture(checkout)
    change(data)
    await assert.rejects(verify(checkout, data), /Release candidate verification failed/, label)
  }
})

test('does not combine successful jobs from different workflow runs or accept a wrong workflow', async (t) => {
  const checkout = checkoutFixture(t)
  const mixed = apiFixture(checkout)
  mixed.checks[0].details_url = `https://github.com/${REPO}/actions/runs/6002/job/1001`
  await assert.rejects(verify(checkout, mixed), /different CI workflow runs/)
  for (const change of [
    (data) => { data.workflow.path = '.github/workflows/other.yml' },
    (data) => { data.workflow.head_sha = 'b'.repeat(40) },
    (data) => { data.workflow.pull_requests[0].base.sha = 'c'.repeat(40) },
    (data) => { data.workflow.conclusion = 'failure' },
  ]) {
    const data = apiFixture(checkout)
    change(data)
    await assert.rejects(verify(checkout, data), /not a successful exact-head CI run/)
  }
})

test('requires every GitHub check-run page before accepting the four protected jobs', async (t) => {
  const checkout = checkoutFixture(t)
  const data = apiFixture(checkout)
  const noise = Array.from({ length: 97 }, (_, index) => ({
    id: 2000 + index, name: `unrelated ${index}`, head_sha: checkout.headSha,
    status: 'completed', conclusion: 'success', app: { slug: 'github-actions' },
  }))
  data.checks.push(...noise)
  const paged = async (rawUrl, request) => {
    const url = new URL(rawUrl)
    if (url.pathname.endsWith('/check-runs')) {
      const page = Number(url.searchParams.get('page'))
      return Response.json({ total_count: data.checks.length,
        check_runs: data.checks.slice((page - 1) * 100, page * 100) })
    }
    return fetchFixture(data)(rawUrl, request)
  }
  const packet = await verify(checkout, data, paged)
  assert.equal(packet.checks.required.length, 4)

  const incomplete = async (rawUrl, request) => {
    const url = new URL(rawUrl)
    if (url.pathname.endsWith('/check-runs') && url.searchParams.get('page') === '2')
      return Response.json({ total_count: data.checks.length, check_runs: [] })
    return paged(rawUrl, request)
  }
  await assert.rejects(verify(checkout, data, incomplete), /pagination ended early/)
})

test('rejects a changed PR base and a checkout that is not the GitHub PR head', async (t) => {
  const checkout = checkoutFixture(t)
  const staleBase = apiFixture(checkout)
  staleBase.pr.base.sha = 'd'.repeat(40)
  staleBase.workflow.pull_requests[0].base.sha = 'd'.repeat(40)
  await assert.rejects(verify(checkout, staleBase), /cannot verify cat-file/)

  const staleHead = apiFixture(checkout)
  staleHead.pr.head.sha = 'e'.repeat(40)
  staleHead.workflow.head_sha = 'e'.repeat(40)
  staleHead.workflow.pull_requests[0].head.sha = 'e'.repeat(40)
  staleHead.checks.forEach((check) => { check.head_sha = 'e'.repeat(40) })
  await assert.rejects(verify(checkout, staleHead), /checked-out HEAD differs/)
})

test('rejects a forked or changed repository identity', async (t) => {
  const checkout = checkoutFixture(t)
  const data = apiFixture(checkout)
  data.pr.head.repo.id = 43
  await assert.rejects(verify(checkout, data), /head\/base repositories/)
})

test('rejects a force push or base advance during verification', async (t) => {
  const checkout = checkoutFixture(t)
  const data = apiFixture(checkout)
  const initial = fetchFixture(data)
  let prReads = 0
  const fetcher = (url, request) => {
    if (new URL(url).pathname === `/repos/${REPO}/pulls/7` && ++prReads === 2)
      return Response.json({ ...data.pr, base: { ...data.pr.base, sha: 'f'.repeat(40) } })
    return initial(url, request)
  }
  await assert.rejects(verify(checkout, data, fetcher), /changed during verification/)
  assert.equal(prReads, 2)
})

test('rejects modification of released SQL even if later pending migrations are valid', async (t) => {
  const checkout = checkoutFixture(t)
  writeFileSync(join(checkout.directory, 'supabase', 'migrations', `${RELEASED}_279_approval.sql`), 'select 2;\n')
  git(checkout.directory, 'add', '.')
  git(checkout.directory, 'commit', '-qm', 'rewrite released migration')
  const data = apiFixture({ ...checkout, headSha: git(checkout.directory, 'rev-parse', 'HEAD') })
  await assert.rejects(verifyGithubReleaseCandidate({ prNumber: 7, checkoutDir: checkout.directory,
    fetcher: fetchFixture(data) }), /rewrites or removes released migration SQL/)
})

test('rejects a PR that advances the source release marker to hide pending SQL', async (t) => {
  const checkout = checkoutFixture(t)
  writeFileSync(join(checkout.directory, 'supabase', 'verification', 'released-migration-version.txt'),
    '20261101010000\n')
  git(checkout.directory, 'add', '.')
  git(checkout.directory, 'commit', '-qm', 'advance marker without production evidence')
  const data = apiFixture({ ...checkout, headSha: git(checkout.directory, 'rev-parse', 'HEAD') })
  await assert.rejects(verifyGithubReleaseCandidate({ prNumber: 7, checkoutDir: checkout.directory,
    fetcher: fetchFixture(data) }), /changes the source released-schema marker/)
})

test('rejects a PR that changes the workflow defining the four required jobs', async (t) => {
  const checkout = checkoutFixture(t)
  writeFileSync(join(checkout.directory, '.github', 'workflows', 'ci.yml'), 'name: CI\n# weakened in PR\n')
  git(checkout.directory, 'add', '.')
  git(checkout.directory, 'commit', '-qm', 'change CI workflow')
  const data = apiFixture({ ...checkout, headSha: git(checkout.directory, 'rev-parse', 'HEAD') })
  await assert.rejects(verifyGithubReleaseCandidate({ prNumber: 7, checkoutDir: checkout.directory,
    fetcher: fetchFixture(data) }), /changes the CI workflow/)
})

test('allows the reviewed gate bootstrap but rejects later release-check workflow edits', async (t) => {
  const bootstrap = checkoutFixture(t)
  writeFileSync(join(bootstrap.directory, '.github', 'workflows', 'production-release-approval.yml'),
    'name: Production release approval\n')
  git(bootstrap.directory, 'add', '.')
  git(bootstrap.directory, 'commit', '-qm', 'install trusted release check')
  const bootstrapHead = git(bootstrap.directory, 'rev-parse', 'HEAD')
  const bootstrapData = apiFixture({ ...bootstrap, headSha: bootstrapHead })
  const bootstrapPacket = await verifyGithubReleaseCandidate({ prNumber: 7,
    checkoutDir: bootstrap.directory, fetcher: fetchFixture(bootstrapData) })
  assert.equal(bootstrapPacket.pr.head.sha, bootstrapHead)

  const installed = checkoutFixture(t, { releaseWorkflow: true })
  writeFileSync(join(installed.directory, '.github', 'workflows', 'production-release-approval.yml'),
    'name: Production release approval\n# weakened in PR\n')
  git(installed.directory, 'add', '.')
  git(installed.directory, 'commit', '-qm', 'weaken trusted release check')
  const changed = apiFixture({ ...installed, headSha: git(installed.directory, 'rev-parse', 'HEAD') })
  await assert.rejects(verifyGithubReleaseCandidate({ prNumber: 7,
    checkoutDir: installed.directory, fetcher: fetchFixture(changed) }),
  /changes trusted production release gate code/)

  const code = checkoutFixture(t, { releaseWorkflow: true })
  writeFileSync(join(code.directory, 'scripts', 'check-approved-production-release.mjs'),
    '// weakened release check\n')
  git(code.directory, 'add', '.')
  git(code.directory, 'commit', '-qm', 'weaken trusted release script')
  const changedCode = apiFixture({ ...code, headSha: git(code.directory, 'rev-parse', 'HEAD') })
  await assert.rejects(verifyGithubReleaseCandidate({ prNumber: 7,
    checkoutDir: code.directory, fetcher: fetchFixture(changedCode) }),
  /changes trusted production release gate code: scripts\/check-approved-production-release.mjs/)
})

test('rejects a non-200 GitHub API response without trusting fixture claims', async (t) => {
  const checkout = checkoutFixture(t)
  const data = apiFixture(checkout)
  const fetcher = async (url, request) => {
    if (new URL(url).pathname.endsWith('/check-runs')) return Response.json({ message: 'rate limited' }, { status: 403 })
    return fetchFixture(data)(url, request)
  }
  await assert.rejects(verify(checkout, data, fetcher), /HTTP 403/)
})
