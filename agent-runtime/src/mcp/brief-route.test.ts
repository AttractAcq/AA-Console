import { PGlite } from '@electric-sql/pglite';
import { readFile } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { EventEmitter } from 'node:events';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { SupabaseClient } from '@supabase/supabase-js';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { handleMcpBrief } from './brief-route.js';

const CLIENT = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const IDEA = '33333333-3333-4333-8333-333333333333';
const ADMIN = '44444444-4444-4444-8444-444444444444';
const SECRET = 'test-only-service-credential';
let db: PGlite;
const migration = async (file: string) => readFile(new URL(`../../../supabase/migrations/${file}`, import.meta.url), 'utf8');
// PGlite runs real PostgreSQL constraints, roles, RLS and PL/pgSQL locally.
// Only Supabase Auth and unrelated later additive columns are fixture setup;
// the queue, human approval RPC, content schema and both new migrations are real.
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
    '20260904083559_15_brief_refs_and_job_link.sql',
    '20260907170000_55_structured_briefs.sql',
  ]) await db.exec(await migration(file));
  await db.exec(`
    alter table agents add column archived_at timestamptz;
    alter table agents add column requires_input boolean not null default false;
    alter table agent_jobs add column params jsonb not null default '{}';
    revoke execute on all functions in schema public from public, anon;
    grant execute on function approve_idea_and_generate_brief(uuid) to authenticated;
    grant execute on function enqueue_agent_job(text,uuid,text,uuid) to authenticated;
  `);
  for (const file of [
    '20260907190000_56_repurposing.sql',
    '20260908080000_63_mcp_brief_enqueue.sql',
    '20260908080100_64_brief_job_idempotency.sql',
    '20260908190000_65_mcp_bot_auth_registry.sql',
    '20260908200000_66_mcp_domain_rls_bot_isolation.sql',
  ]) await db.exec(await migration(file));
}, 30_000);
afterAll(async () => { await db?.close(); });
beforeEach(async () => {
  await db.exec(`reset role;
    truncate mcp_brief_requests, mcp_bot_clients, client_briefs, client_ideas,
      agent_job_events, agent_jobs, ref_counters, clients, profiles, auth.users cascade;
    update agents set paused = false, archived_at = null, requires_upstream = '{}';
    update mcp_internal.mcp_bots set status = 'active';
    insert into auth.users (id) values ('${ADMIN}');
    update profiles set role = 'admin' where id = '${ADMIN}';
    insert into clients (id,name,initials) values ('${CLIENT}','First','FI'),('${OTHER}','Other','OT');
    insert into client_ideas (id,client_id,title,source,status)
      values ('${IDEA}','${CLIENT}','A real idea','manual','approved');
    insert into mcp_bot_clients (bot_id,client_id) values ('bot_production','${CLIENT}');
    select set_config('request.jwt.claim.role','service_role',false);
    select set_config('request.jwt.claim.sub','',false);
  `);
});

function adapter() {
  const rpc = vi.fn((_name: string, p: Record<string, unknown>) => ({
    abortSignal: async (_signal: AbortSignal) => {
      try {
        const result = await db.query<{ result: unknown }>(
          'select enqueue_mcp_brief($1,$2,$3,$4,$5) as result',
          [p.p_bot_id, p.p_request_id, p.p_execution_id, p.p_client_id, p.p_idea_id],
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
async function call(options: {
  headers?: Record<string, string | undefined>; body?: unknown; raw?: string;
  secret?: string | null; method?: string;
} = {}) {
  const headers = {
    authorization: `Bearer ${SECRET}`, 'x-aa-bot-id': 'bot_production',
    'x-request-id': 'request-1', 'idempotency-key': 'execution-1',
    'content-type': 'application/json', ...options.headers,
  };
  const req = Readable.from([Buffer.from(options.raw ?? JSON.stringify(options.body ?? { client_id: CLIENT, idea_id: IDEA }))]) as IncomingMessage;
  req.headers = headers;
  req.rawHeaders = Object.entries(headers).flatMap(([k, v]) => v === undefined ? [] : [k, v]);
  req.method = options.method ?? 'POST';
  let status = 0;
  let body: any;
  const res = Object.assign(new EventEmitter(), {
    writeHead: (code: number) => { status = code; },
    setHeader: vi.fn(), end: (data: string) => { body = JSON.parse(data); },
  }) as unknown as ServerResponse;
  const { sb, rpc } = adapter();
  await handleMcpBrief(req, res, sb, options.secret === undefined ? SECRET : options.secret);
  return { status, body, rpc };
}
async function count(table: string) {
  return (await db.query<{ n: number }>(`select count(*)::int as n from ${table}`)).rows[0]?.n;
}

describe('MCP HTTP contract through the transactional PostgreSQL queue', () => {
  it('queues an approved idea and attributes it without a human identity', async () => {
    const result = await call();
    expect(result.status).toBe(202);
    expect(Object.keys(result.body).sort()).toEqual(['client_id', 'job_id']);
    const job = (await db.query<any>('select * from agent_jobs')).rows[0];
    expect(result.body).toEqual({ job_id: job.id, client_id: CLIENT });
    expect(job).toMatchObject({ agent_key: 'brief', client_id: CLIENT, input_table: 'client_ideas', input_id: IDEA, created_by: null, status: 'queued' });
    expect(job.params).toEqual({ source: 'aa-mcp-gateway', bot_id: 'bot_production', request_id: 'request-1', execution_id: 'execution-1', client_id: CLIENT, idea_id: IDEA });
    expect((await db.query<any>('select * from mcp_brief_requests')).rows[0]).toMatchObject({ job_id: job.id, bot_id: 'bot_production', request_id: 'request-1', execution_id: 'execution-1' });
    expect((await db.query<any>('select payload from agent_job_events')).rows[0]?.payload).toEqual(job.params);
    expect((await db.query<any>('select status from client_ideas')).rows[0]?.status).toBe('briefed');
  });
  it.each([undefined, 'Bearer wrong', SECRET, 'Bearer '])('rejects missing/invalid auth: %s', async (authorization) => {
    const result = await call({ headers: { authorization } });
    expect(result.status).toBe(401);
    expect(result.body.error.code).toBe('unauthorized');
    expect(result.rpc).not.toHaveBeenCalled();
  });
  it('fails closed without a configured service secret', async () => {
    expect((await call({ secret: null })).status).toBe(401);
  });
  it.each([undefined, 'bot_unknown', '../bot_production'])('rejects invalid bot: %s', async (bot) => {
    const result = await call({ headers: { 'x-aa-bot-id': bot } });
    expect(result.body.error.code).toBe('invalid_bot');
    expect(result.status).toBe(403);
    expect(result.rpc).not.toHaveBeenCalled();
  });
  it('returns idea_not_found', async () => {
    const result = await call({ body: { client_id: CLIENT, idea_id: OTHER } });
    expect(result.status).toBe(404);
    expect(result.body.error.code).toBe('idea_not_found');
  });
  it('rejects idea/client mismatch even when the requested client is allowed', async () => {
    await db.exec(`update client_ideas set client_id = '${OTHER}'`);
    expect((await call()).body.error.code).toBe('client_mismatch');
    expect(await count('agent_jobs')).toBe(0);
  });
  it.each(['draft', 'rejected', 'briefed'])('never approves an idea in state %s', async (status) => {
    await db.query('update client_ideas set status = $1', [status]);
    const result = await call();
    expect(result.status).toBe(409);
    expect(result.body.error.code).toBe('invalid_idea_status');
    expect(await count('agent_jobs')).toBe(0);
    expect((await db.query<any>('select status from client_ideas')).rows[0]?.status).toBe(status);
  });
  it('returns the original durable job across repeated and overlapping requests', async () => {
    const results = await Promise.all([call(), call(), call({ headers: { 'x-request-id': 'retry-request' } })]);
    expect(results.map(r => r.status)).toEqual([202, 200, 200]);
    expect(results[1]?.body).toEqual(results[0]?.body);
    expect(results[2]?.body).toEqual(results[0]?.body);
    expect(await count('agent_jobs')).toBe(1);
    expect(await count('mcp_brief_requests')).toBe(1);
    expect(await count('agent_job_events')).toBe(1);
  });
  it('rejects execution-key reuse with a different payload', async () => {
    await call();
    expect((await call({ body: { client_id: CLIENT, idea_id: OTHER } })).body.error.code).toBe('idempotency_conflict');
    expect(await count('agent_jobs')).toBe(1);
  });
  it('rejects a second execution key for the already-queued idea', async () => {
    await call();
    expect((await call({ headers: { 'idempotency-key': 'execution-2' } })).body.error.code).toBe('invalid_idea_status');
    expect(await count('agent_jobs')).toBe(1);
  });
  it('denies cross-client scope before lookup and rechecks revocation on replay', async () => {
    expect((await call({ body: { client_id: OTHER, idea_id: IDEA } })).body.error.code).toBe('client_forbidden');
    await call();
    await db.exec('delete from mcp_bot_clients');
    expect((await call()).body.error.code).toBe('client_forbidden');
    expect(await count('agent_jobs')).toBe(1);
  });
  it('denies a suspended bot even with a remaining client grant', async () => {
    await db.query('select mcp_suspend_bot($1,$2,$3)', ['bot_production', 'operator', 'lock']);
    expect((await call()).body.error.code).toBe('bot_not_active');
    expect(await count('agent_jobs')).toBe(0);
  });
  it.each(['paused = true', 'archived_at = now()', "requires_upstream = '{icp}'"])('refuses unavailable brief agent: %s', async (patch) => {
    await db.exec(`update agents set ${patch} where agent_key = 'brief'`);
    const result = await call();
    expect(result.status).toBe(503);
    expect(result.body.error.code).toBe('brief_agent_unavailable');
    expect(await count('agent_jobs')).toBe(0);
    expect(await count('mcp_brief_requests')).toBe(0);
    expect((await db.query<any>('select status from client_ideas')).rows[0]?.status).toBe('approved');
  });
  it('rolls back the job and execution key when event persistence fails', async () => {
    await db.exec(`create function test_reject_event() returns trigger language plpgsql as $$ begin raise check_violation; end $$;
      create trigger test_reject_event before insert on agent_job_events for each row execute function test_reject_event();`);
    try {
      expect((await call()).body.error.code).toBe('queue_failure');
      expect(await count('agent_jobs')).toBe(0);
      expect(await count('mcp_brief_requests')).toBe(0);
    } finally {
      await db.exec('drop trigger test_reject_event on agent_job_events; drop function test_reject_event();');
    }
    expect((await call()).status).toBe(202);
  });
  it.each([
    { raw: '{broken' }, { raw: 'x'.repeat(4097) }, { body: [] },
    { body: { client_id: CLIENT, idea_id: 'bad' } },
    { body: { client_id: CLIENT, idea_id: IDEA, arbitrary: true } },
    { headers: { 'idempotency-key': undefined } },
    { headers: { 'x-request-id': 'bad request' } },
    { headers: { 'content-type': 'text/plain' } },
  ])('rejects malformed input without queue access (#%#)', async (options) => {
    const result = await call(options);
    expect(result.status).toBe(400);
    expect(result.body.error.code).toBe('invalid_request');
    expect(result.rpc).not.toHaveBeenCalled();
  });
  it('returns a structured method error', async () => {
    expect((await call({ method: 'GET' })).status).toBe(405);
  });
});

describe('database authorization, human compatibility and persistence invariant', () => {
  it('keeps human approve-and-brief callable and attributable to the admin', async () => {
    await db.exec(`update client_ideas set status = 'draft';
      select set_config('request.jwt.claim.sub','${ADMIN}',false);
      select set_config('request.jwt.claim.role','authenticated',false);
      set role authenticated;`);
    const result = await db.query<{ id: string }>('select approve_idea_and_generate_brief($1) as id', [IDEA]);
    await db.exec('reset role');
    const job = (await db.query<any>('select * from agent_jobs')).rows[0];
    expect(job.id).toBe(result.rows[0]?.id);
    expect(job.created_by).toBe(ADMIN);
    expect(job.params).toEqual({});
    expect((await db.query<any>('select status from client_ideas')).rows[0]?.status).toBe('briefed');
  });
  it('rejects service-role use of the human RPC without inventing auth.uid', async () => {
    await expect(db.query('select approve_idea_and_generate_brief($1)', [IDEA])).rejects.toThrow('Not permitted');
  });
  it('allows only service_role to call the bot RPC and exposes no internal helper', async () => {
    for (const role of ['anon', 'authenticated']) {
      await db.exec(`set role ${role}`);
      await expect(db.query('select enqueue_mcp_brief($1,$2,$3,$4,$5)', ['bot_production','r','e',CLIENT,IDEA])).rejects.toThrow('permission denied');
      await expect(db.query('select * from mcp_bot_clients')).rejects.toThrow('permission denied');
      await db.exec('reset role');
    }
    await db.exec('set role service_role');
    await expect(db.query("select enqueue_agent_job_internal('brief',$1,'client_ideas',$2,null)", [CLIENT,IDEA])).rejects.toThrow('permission denied');
    expect((await call()).status).toBe(202);
    await db.exec('reset role');
  });
  it('enforces at most one original brief per job while preserving repurpose fan-out', async () => {
    const result = await call();
    const insert = (format: string | null = null) => db.query(
      'insert into client_briefs (client_id,source_idea_id,title,job_id,repurpose_format) values ($1,$2,$3,$4,$5)',
      [CLIENT,IDEA,'Written brief',result.body.job_id,format]);
    await insert();
    await expect(insert()).rejects.toThrow('client_briefs_original_job_unique');
    // Constraint still applies when a source idea is deleted or detached.
    await db.exec('update client_briefs set source_idea_id = null');
    await expect(insert()).rejects.toThrow('client_briefs_original_job_unique');
    await insert('reel'); await insert('text_post');
    expect(await count('client_briefs')).toBe(3);
  });
});
