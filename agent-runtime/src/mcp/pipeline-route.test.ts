import { PGlite } from '@electric-sql/pglite';
import { readFile } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { EventEmitter } from 'node:events';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { SupabaseClient } from '@supabase/supabase-js';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { handleMcpPipeline } from './pipeline-route.js';
import { handleMcpSalesAgents } from './sales-agents-route.js';

const CLIENT = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const LEAD = '33333333-3333-4333-8333-333333333333';
const LEAD_B = '44444444-4444-4444-8444-444444444444';
const AGENT = '55555555-5555-4555-8555-555555555555';
const SECRET = 'test-only-service-credential';
let db: PGlite;
const migration = async (file: string) =>
  readFile(new URL(`../../../supabase/migrations/${file}`, import.meta.url), 'utf8');

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    create role anon; create role authenticated; create role service_role bypassrls;
    create schema auth;
    create table auth.users (id uuid primary key, email text, raw_user_meta_data jsonb default '{}');
    create function auth.uid() returns uuid language sql stable as
      $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    create function auth.role() returns text language sql stable as
      $$ select current_setting('request.jwt.claim.role', true) $$;
    grant usage on schema public, auth to authenticated, service_role, anon;
  `);
  for (const file of [
    '20260903104450_01_foundations_roles_clients.sql',
    '20260903104529_02_team_and_operations.sql',
    '20260903104615_03_agent_registry_and_job_queue.sql',
    '20260903104816_05_content_chain_proof_ideas_briefs_media.sql',
    '20260903104850_06_distribution_conversion_leads.sql',
    '20260904080405_14_campaigns.sql',
    '20260904083559_15_brief_refs_and_job_link.sql',
    '20260904203418_23_idea_provenance_fields.sql',
    '20260907170000_55_structured_briefs.sql',
  ]) await db.exec(await migration(file));
  await db.exec(`
    alter table agents add column archived_at timestamptz;
    alter table agents add column requires_input boolean not null default false;
    alter table agent_jobs add column params jsonb not null default '{}';
    revoke execute on all functions in schema public from public, anon;
    grant execute on function enqueue_agent_job(text,uuid,text,uuid) to authenticated;
    -- Same minimal stand-in as isolation-rls.test.ts: migration 19 is not
    -- loaded by this partial fixture, but 60/67's client-read policies need it.
    create or replace function is_client_user(target uuid)
    returns boolean language sql stable security definer set search_path = public as $$
      select exists (select 1 from client_users cu where cu.user_id = auth.uid() and cu.client_id = target);
    $$;
    revoke execute on function is_client_user(uuid) from anon, public;
    grant execute on function is_client_user(uuid) to authenticated;
  `);
  for (const file of [
    '20260908030000_60_revenue_pipeline.sql',
    '20260908040000_61_lead_operations.sql',
    '20260908220000_67_sales_agents.sql',
    '20260907190000_56_repurposing.sql',
    '20260908080000_63_mcp_brief_enqueue.sql',
    '20260908080100_64_brief_job_idempotency.sql',
    '20260908190000_65_mcp_bot_auth_registry.sql',
    '20260908200000_66_mcp_domain_rls_bot_isolation.sql',
    '20260908230000_68_mcp_production_manager.sql',
    '20260908240000_69_mcp_phase5_read_rpc_volatile.sql',
    '20260909000000_70_mcp_approval_engine.sql',
    '20260909040000_74_mcp_production_bot_decide.sql',
    '20260909050000_75_mcp_distribution_manager.sql',
    '20260910000000_76_mcp_sales_ops.sql',
  ]) await db.exec(await migration(file));
}, 60_000);
afterAll(async () => { await db?.close(); });
beforeEach(async () => {
  await db.exec(`reset role;
    truncate mcp_internal.mcp_pipeline_requests, mcp_bot_clients,
      lead_events, client_leads, sales_agent_conversations, client_sales_agents,
      ref_counters, clients, profiles, auth.users cascade;
    update mcp_internal.mcp_bots set status = 'active';
    insert into clients (id,name,initials) values ('${CLIENT}','First','FI'),('${OTHER}','Other','OT');
    insert into client_leads (id,client_id,name,email,stage) values
      ('${LEAD}','${CLIENT}','Alpha Lead','a@example.com','lead'),
      ('${LEAD_B}','${OTHER}','Other Lead','b@example.com','lead');
    insert into client_sales_agents (id,client_id,name,purpose,status) values
      ('${AGENT}','${CLIENT}','Closer','Qualify and book','live');
    insert into mcp_bot_clients (bot_id,client_id) values ('bot_sales_ops','${CLIENT}');
    select set_config('request.jwt.claim.role','service_role',false);
    select set_config('request.jwt.claim.sub','',false);
  `);
});

function rpcAdapter() {
  const rpc = vi.fn((name: string, p: Record<string, unknown>) => ({
    abortSignal: async () => {
      try {
        const keys = Object.keys(p);
        const named = keys.map((k, i) => `${k} := $${i + 1}`).join(', ');
        const result = await db.query<{ result: unknown }>(
          `select ${name}(${named}) as result`,
          keys.map((k) => p[k]),
        );
        return { data: result.rows[0]?.result, error: null };
      } catch (e) {
        const error = e as { code: string; message: string };
        return { data: null, error: { code: error.code, message: error.message } };
      }
    },
  }));
  return { rpc, sb: { rpc } as unknown as SupabaseClient };
}

async function call(handler: typeof handleMcpPipeline, path: string, body: unknown, options: {
  headers?: Record<string, string | undefined>;
  secret?: string | null;
  method?: string;
} = {}) {
  const headers = {
    authorization: `Bearer ${SECRET}`, 'x-aa-bot-id': 'bot_sales_ops',
    'x-request-id': 'request-1', 'idempotency-key': 'execution-1',
    'content-type': 'application/json', ...options.headers,
  };
  const req = Readable.from([Buffer.from(JSON.stringify(body))]) as IncomingMessage;
  req.headers = headers;
  req.rawHeaders = Object.entries(headers).flatMap(([k, v]) => v === undefined ? [] : [k, v]);
  req.method = options.method ?? 'POST';
  (req as IncomingMessage).url = path;
  let status = 0;
  let jsonBody: any;
  const res = Object.assign(new EventEmitter(), {
    writeHead: (code: number) => { status = code; },
    setHeader: vi.fn(), end: (data: string) => { jsonBody = JSON.parse(data); },
  }) as unknown as ServerResponse;
  const { sb, rpc } = rpcAdapter();
  await handler(req, res, sb, options.secret === undefined ? SECRET : options.secret);
  return { status, body: jsonBody, rpc };
}
const pipeline = (path: string, body: unknown, options?: Parameters<typeof call>[3]) =>
  call(handleMcpPipeline, `/internal/mcp/pipeline/${path}`, body, options);
const salesAgents = (path: string, body: unknown, options?: Parameters<typeof call>[3]) =>
  call(handleMcpSalesAgents, `/internal/mcp/sales-agents/${path}`, body, options);

describe('Phase 11 pipeline routes', () => {
  it('requires the service secret', async () => {
    const result = await pipeline('list-leads', { client_id: CLIENT }, { secret: 'wrong' });
    expect(result.status).toBe(401);
  });

  it('lists only the granted client leads and rejects an unknown filter shape', async () => {
    const result = await pipeline('list-leads', { client_id: CLIENT });
    expect(result.status).toBe(200);
    expect(result.body.count).toBe(1);
    expect(result.body.leads[0].id).toBe(LEAD);
    expect(JSON.stringify(result.body)).not.toContain(LEAD_B);
    expect((await pipeline('list-leads', { client_id: OTHER })).body.error.code).toBe('client_forbidden');
    const malformed = await pipeline('list-leads', { client_id: CLIENT, stage: 'not-a-stage' });
    expect(malformed.status).toBe(400);
    expect(malformed.body.error.code).toBe('invalid_request');
  });

  it('gets one lead and rejects a cross-client lead id', async () => {
    const ok = await pipeline('get-lead', { client_id: CLIENT, lead_id: LEAD });
    expect(ok.status).toBe(200);
    expect(ok.body.stage).toBe('lead');
    const mismatch = await pipeline('get-lead', { client_id: CLIENT, lead_id: LEAD_B });
    expect(mismatch.status).toBe(403);
    expect(mismatch.body.error.code).toBe('client_mismatch');
  });

  it('reads stalled leads and the pipeline summary for the granted client', async () => {
    const stalled = await pipeline('get-stalled-leads', { client_id: CLIENT });
    expect(stalled.status).toBe(200);
    expect(stalled.body.stalled_leads.length).toBeGreaterThanOrEqual(1);
    const summary = await pipeline('get-pipeline-summary', { client_id: CLIENT });
    expect(summary.status).toBe(200);
    expect(summary.body.total_leads).toBe(1);
  });

  it('moves a lead stage, refuses sale/cash at the parse layer, and replays idempotently', async () => {
    const moved = await pipeline('update-stage', { client_id: CLIENT, lead_id: LEAD, stage: 'conversation' });
    expect(moved.status).toBe(200);
    expect(moved.body.stage).toBe('conversation');
    expect(moved.body.replayed).toBe(false);
    const replay = await pipeline('update-stage', { client_id: CLIENT, lead_id: LEAD, stage: 'conversation' });
    expect(replay.body.replayed).toBe(true);
    for (const stage of ['sale', 'cash']) {
      const denied = await pipeline('update-stage', {
        client_id: CLIENT, lead_id: LEAD, stage,
      }, { headers: { 'idempotency-key': `no-${stage}` } });
      expect(denied.status).toBe(400);
      expect(denied.body.error.code).toBe('invalid_request');
    }
  });

  it('writes a followup and rejects a body with unknown keys', async () => {
    const written = await pipeline('create-followup', {
      client_id: CLIENT, lead_id: LEAD, next_action: 'Call back Thursday',
    });
    expect(written.status).toBe(200);
    expect(written.body.next_action).toBe('Call back Thursday');
    const malformed = await pipeline('create-followup', {
      client_id: CLIENT, lead_id: LEAD, next_action: 'x', extra_field: 'nope',
    }, { headers: { 'idempotency-key': 'malformed-key' } });
    expect(malformed.status).toBe(400);
    expect(malformed.body.error.code).toBe('invalid_request');
  });
});

describe('Phase 11 sales-agents routes (reads only)', () => {
  it('lists only the granted client sales agents', async () => {
    const result = await salesAgents('list', { client_id: CLIENT });
    expect(result.status).toBe(200);
    expect(result.body.sales_agents[0].id).toBe(AGENT);
    expect((await salesAgents('list', { client_id: OTHER })).body.error.code).toBe('client_forbidden');
  });

  it('gets one sales agent and rejects a cross-client id', async () => {
    const ok = await salesAgents('get', { client_id: CLIENT, sales_agent_id: AGENT });
    expect(ok.status).toBe(200);
    expect(ok.body.name).toBe('Closer');
    const other = await salesAgents('get', { client_id: OTHER, sales_agent_id: AGENT });
    expect(other.status).toBe(403);
    expect(other.body.error.code).toBe('client_forbidden');
  });

  it('reads conversations, summarized as a turn count rather than a raw transcript', async () => {
    const result = await salesAgents('get-conversations', { client_id: CLIENT, sales_agent_id: AGENT });
    expect(result.status).toBe(200);
    expect(result.body.count).toBe(0);
    expect(result.body.conversations).toEqual([]);
  });
});
