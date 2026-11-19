#!/usr/bin/env node

// Read-only supplemental checkpoint for Supabase-managed Storage and the
// postgres-owned event trigger. Writes private evidence; it never changes DB.
import { closeSync, openSync, statSync, writeSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

const ref = 'vmmertwoboqiazcsougw'
const token = process.env.AA_SCHEMA_PARITY_READ_TOKEN
if (!token?.startsWith('sbp_fc')) throw Error('Scoped Database Read token unavailable')
if (process.argv.length !== 4 || process.argv[2] !== '--output') {
  throw Error('Usage: capture-staging-recovery-extras.mjs --output NEW_PRIVATE_JSON')
}
const output = resolve(process.argv[3])
if ((statSync(dirname(output)).mode & 0o077) !== 0) {
  throw Error('Output directory must be private (mode 0700)')
}
const endpoint = `https://api.supabase.com/v1/projects/${ref}/database/query/read-only`

async function read(query) {
  if (!/^select\b/i.test(query) || query.includes(';')) throw Error('Fixed SELECT required')
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
    signal: AbortSignal.timeout(40000),
  })
  if (!response.ok) throw Error(`Read-only query failed: HTTP ${response.status}`)
  const rows = await response.json()
  if (!Array.isArray(rows)) throw Error('Read-only query returned invalid rows')
  return rows
}

const queries = {
  storageObjectCount: 'select count(*)::integer as count from storage.objects',
  storageObjects: 'select id,bucket_id,name,updated_at,metadata from storage.objects order by bucket_id,name,id',
  storageBuckets: 'select to_jsonb(b) as definition from storage.buckets b order by b.id',
  storagePolicies: "select schemaname,tablename,policyname,permissive,roles,cmd,qual,with_check from pg_policies where schemaname='storage' order by tablename,policyname",
  ensureRls: "select e.evtname,e.evtevent,e.evttags,e.evtenabled,pg_get_userbyid(e.evtowner) as owner,e.evtfoid::regprocedure::text as handler,pg_get_functiondef(e.evtfoid) as handler_definition from pg_event_trigger e where e.evtname='ensure_rls'",
  cron: 'select to_jsonb(j) as definition from cron.job j order by j.jobname',
  vault: 'select count(*)::integer as count from vault.secrets',
}
const capture = { projectRef: ref, capturedAt: new Date().toISOString(),
  transport: 'supabase-management-read-only', queries: {} }
for (const [name, query] of Object.entries(queries)) capture.queries[name] = await read(query)
if (capture.queries.ensureRls.length !== 1 ||
    capture.queries.storageObjectCount.length !== 1 ||
    Number(capture.queries.storageObjectCount[0].count) !== capture.queries.storageObjects.length ||
    capture.queries.vault.length !== 1) {
  throw Error('Supplemental checkpoint returned inconsistent rows')
}
const fd = openSync(output, 'wx', 0o600)
try { writeSync(fd, JSON.stringify(capture, null, 2) + '\n') }
finally { closeSync(fd) }
console.log(JSON.stringify({ output, ref, capturedAt: capture.capturedAt,
  storageObjects: capture.queries.storageObjects.length,
  storageBuckets: capture.queries.storageBuckets.length,
  storagePolicies: capture.queries.storagePolicies.length,
  ensureRls: capture.queries.ensureRls.length,
  cronJobs: capture.queries.cron.length,
  vaultSecrets: capture.queries.vault[0].count }))
