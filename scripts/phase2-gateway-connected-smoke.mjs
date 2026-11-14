// Local-only integration smoke. It writes temporary fixture rows to the local
// Supabase project; run against a fresh local database and reset it afterwards.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import http from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createClient } from '@supabase/supabase-js';
import { Store } from '../aa-mcp-gateway/src/audit/store.ts';
import { ActionEngine } from '../aa-mcp-gateway/src/policy/engine.ts';
import { registry } from '../aa-mcp-gateway/src/registry/tools.ts';
import { AAApiAdapter } from '../aa-mcp-gateway/src/adapters/aa-api.ts';
import { AaCanonicalApprovalBridge } from '../aa-mcp-gateway/src/approvals/canonical-bridge.ts';
import { handleMcpGatewayApproval } from '../agent-runtime/src/mcp/gateway-approval-route.ts';
import { handleMcpSites } from '../agent-runtime/src/mcp/sites-mcp-route.ts';

if (process.env.AA_LOCAL_GATEWAY_SMOKE !== '1') {
  throw new Error('Set AA_LOCAL_GATEWAY_SMOKE=1 to run this local-only write test.');
}

const envText = execFileSync('supabase', ['status', '-o', 'env'], {
  encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
});
const localEnv = Object.fromEntries(envText.split('\n').map((line) => {
  const i = line.indexOf('=');
  if (i < 0) return [line, ''];
  const value = line.slice(i + 1).trim();
  return [line.slice(0, i), value.startsWith('"') && value.endsWith('"')
    ? value.slice(1, -1) : value];
}));
const apiUrl = localEnv.API_URL;
const serviceKey = localEnv.SERVICE_ROLE_KEY;
if (!apiUrl || !serviceKey || !['127.0.0.1', 'localhost'].includes(new URL(apiUrl).hostname)) {
  throw new Error('A local Supabase API URL and service key are required.');
}

function sql(source) {
  const run = spawnSync('docker', ['exec', '-i', 'supabase_db_AA_Console',
    'psql', '-U', 'postgres', '-v', 'ON_ERROR_STOP=1', '-qAt'], {
    encoding: 'utf8', input: source,
  });
  if (run.status !== 0) throw new Error(`Local SQL failed: ${run.stderr.trim()}`);
  return run.stdout.trim().split('\n').at(-1) ?? '';
}

const admin = randomUUID();
const client = randomUUID();
const token = randomUUID();
const marketingToken = randomUUID();
const tokenHash = randomBytes(32).toString('hex');
const marketingTokenHash = randomBytes(32).toString('hex');
const secret = randomUUID();
const adminClaims = JSON.stringify({ sub: admin, role: 'authenticated', aal: 'aal2' });
sql(`insert into auth.users(id,instance_id,aud,role,email,encrypted_password,created_at,updated_at)
 values('${admin}','00000000-0000-0000-0000-000000000000','authenticated',
 'authenticated','gateway-smoke-${admin}@example.invalid','',now(),now());
 insert into public.profiles(id,role,email) values('${admin}','admin','gateway-smoke-${admin}@example.invalid');
 insert into public.clients(id,name,initials) values('${client}','Gateway connected smoke','GS');
 insert into public.mcp_bot_clients(bot_id,client_id) values('bot_production','${client}');
 insert into public.mcp_bot_clients(bot_id,client_id) values('bot_marketing','${client}');
 insert into mcp_internal.mcp_bot_tokens(token_id,bot_id,token_hash)
 values('${token}','bot_production',decode('${tokenHash}','hex')),
 ('${marketingToken}','bot_marketing',decode('${marketingTokenHash}','hex'));`);

const sb = createClient(apiUrl, serviceKey, { auth: { persistSession: false } });
let siteProviderCalls = 0;
const server = http.createServer((req, res) => {
  if (req.url?.startsWith('/internal/mcp/sites/')) {
    void handleMcpSites(req, res, sb, secret, {
      githubAppId: 'local-smoke', githubAppPrivateKey: 'local-smoke',
      githubInstallationId: '1', githubSitesOrg: 'example',
      publicRuntimeBase: 'https://example.invalid',
    }, { provisionSite: async (_store, _app, _site, request) => {
      siteProviderCalls++;
      return { created: true, repo: { owner: 'example', repo: request.repo,
        status: 'ready' }, pagesUrl: null };
    } });
  } else void handleMcpGatewayApproval(req, res, sb, secret, 'example');
});
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const store = new Store(':memory:');
try {
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const bridge = new AaCanonicalApprovalBridge(`http://127.0.0.1:${address.port}/`, secret);
  const origin = `http://127.0.0.1:${address.port}/`;
  const engine = new ActionEngine(store, registry,
    new AAApiAdapter({ url: origin, token: secret }), false, bridge);
  const identity = { bot: 'bot_production', clients: [client] };
  const input = { client_id: client, idempotency_key: `gateway-smoke-${randomUUID()}`,
    summary: 'Local connected approval smoke' };
  const pending = await engine.call(identity, 'workflow.create_approval', input,
    undefined, undefined, token);
  assert.equal(pending.status, 'approval_required');
  const approval = store.getApproval(pending.approval_id);
  assert.ok(approval.canonical_request_id);
  const statusBefore = sql(`begin;
    select set_config('request.jwt.claim.role','service_role',true);
    select status from public.approval_inbox_v6 where id='${approval.canonical_request_id}';`);
  assert.equal(statusBefore, 'pending');
  await assert.rejects(() => engine.executeApproval(pending.approval_id, [identity], token),
    /canonical_decision_required/);
  sql(`begin;
    select set_config('request.jwt.claim.sub','${admin}',true);
    select set_config('request.jwt.claim.role','authenticated',true);
    select set_config('request.jwt.claims','${adminClaims}',true);
    select public.decide_gateway_tool_review_v6('${pending.approval_id}',
      '${approval.canonical_request_id}',true);
    commit;`);
  const executed = await engine.executeApproval(pending.approval_id, [identity], token);
  assert.equal(executed.status, 'completed');
  assert.equal(executed.data?.decision, 'informational_only');
  const outcome = sql(`begin;
    select set_config('request.jwt.claim.sub','${admin}',true);
    select set_config('request.jwt.claim.role','authenticated',true);
    select set_config('request.jwt.claims','${adminClaims}',true);
    select execution_status from public.gateway_tool_execution_overview_v6
     where approval_id='${pending.approval_id}';`);
  assert.equal(outcome, 'completed');
  const marketing = { bot: 'bot_marketing', clients: [client] };
  const siteInput = { client_id: client, repo: 'gateway-smoke-site',
    idempotency_key: `gateway-site-${randomUUID()}` };
  const sitePending = await engine.call(marketing, 'sites.provision', siteInput,
    undefined, undefined, marketingToken);
  assert.equal(sitePending.status, 'approval_required');
  const siteCard = store.getApproval(sitePending.approval_id);
  const reviewedOrg = sql(`begin;
    select set_config('request.jwt.claim.role','service_role',true);
    select preview->'structured_payload'->>'provider_org'
     from public.approval_inbox_v6 where id='${siteCard.canonical_request_id}';`);
  assert.equal(reviewedOrg, 'example');
  await assert.rejects(() => engine.executeApproval(sitePending.approval_id,
    [marketing], marketingToken), /canonical_decision_required/);
  assert.equal(siteProviderCalls, 0);
  sql(`begin;
    select set_config('request.jwt.claim.sub','${admin}',true);
    select set_config('request.jwt.claim.role','authenticated',true);
    select set_config('request.jwt.claims','${adminClaims}',true);
    select public.decide_gateway_tool_review_v6('${sitePending.approval_id}',
      '${siteCard.canonical_request_id}',true);
    commit;`);
  const siteExecuted = await engine.executeApproval(sitePending.approval_id,
    [marketing], marketingToken);
  assert.equal(siteExecuted.status, 'completed');
  assert.equal(siteProviderCalls, 1);
  const siteOutcome = sql(`begin;
    select set_config('request.jwt.claim.sub','${admin}',true);
    select set_config('request.jwt.claim.role','authenticated',true);
    select set_config('request.jwt.claims','${adminClaims}',true);
    select execution_status||'|'||coalesce(sites_invocation_id,'')
     from public.gateway_tool_execution_overview_v6
     where approval_id='${sitePending.approval_id}';`);
  assert.match(siteOutcome, /^completed\|[A-Za-z0-9]/);
  console.log('Connected local gateway → runtime → Supabase → Inbox → Sites prewrite smoke passed.');
} finally {
  store.close();
  server.close();
  await once(server, 'close');
}
