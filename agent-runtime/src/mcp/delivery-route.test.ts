import { PGlite } from '@electric-sql/pglite';
import { readFile } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { EventEmitter } from 'node:events';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { SupabaseClient } from '@supabase/supabase-js';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { handleMcpContent } from './content-route.js';
import { handleMcpDelivery } from './delivery-route.js';

const CLIENT = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const IDEA = '33333333-3333-4333-8333-333333333333';
const IDEA_B = '44444444-4444-4444-8444-444444444444';
const BRIEF = '55555555-5555-4555-8555-555555555555';
const ASSET = '66666666-6666-4666-8666-666666666666';
const ASSET_B = '77777777-7777-4777-8777-777777777777';
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
    '20260904083559_15_brief_refs_and_job_link.sql',
    '20260903104939_07_account_and_admin.sql',
    '20260904203418_23_idea_provenance_fields.sql',
    '20260907170000_55_structured_briefs.sql',
  ]) await db.exec(await migration(file));
  await db.exec(`
    alter table agents add column archived_at timestamptz;
    alter table agents add column requires_input boolean not null default false;
    alter table agent_jobs add column params jsonb not null default '{}';
    revoke execute on all functions in schema public from public, anon;
    grant execute on function enqueue_agent_job(text,uuid,text,uuid) to authenticated;
  `);
  for (const file of [
    '20260907190000_56_repurposing.sql',
    '20260908080000_63_mcp_brief_enqueue.sql',
    '20260908080100_64_brief_job_idempotency.sql',
    '20260908190000_65_mcp_bot_auth_registry.sql',
    '20260908200000_66_mcp_domain_rls_bot_isolation.sql',
    '20260908230000_68_mcp_production_manager.sql',
    '20260908240000_69_mcp_phase5_read_rpc_volatile.sql',
    '20260909000000_70_mcp_approval_engine.sql',
    '20260909010000_71_mcp_client_delivery.sql',
    '20260908240000_69_mcp_phase5_read_rpc_volatile.sql',
  ]) await db.exec(await migration(file));
}, 60_000);
afterAll(async () => { await db?.close(); });
beforeEach(async () => {
  await db.exec(`reset role;
    truncate mcp_internal.mcp_content_requests, mcp_brief_requests, mcp_bot_clients,
      client_media_assets, client_briefs, client_ideas, agent_job_events, agent_jobs,
      ref_counters, clients, profiles, auth.users cascade;
    update agents set paused = false, archived_at = null, requires_upstream = '{}';
    update mcp_internal.mcp_bots set status = 'active';
    insert into clients (id,name,initials) values ('${CLIENT}','First','FI'),('${OTHER}','Other','OT');
    insert into client_ideas (id,client_id,title,source,status,strategic_reason)
      values ('${IDEA}','${CLIENT}','A real idea','manual','approved','Say this'),
             ('${IDEA_B}','${OTHER}','Other idea','manual','approved','Secret');
    insert into client_briefs (id,client_id,source_idea_id,title,body,status,hook)
      values ('${BRIEF}','${CLIENT}','${IDEA}','Brief','Body text','draft','A hook');
    insert into client_media_assets (id,client_id,brief_id,media_type,title,storage_path,review_status)
      values ('${ASSET}','${CLIENT}','${BRIEF}','image','Cut','path/a.png','pending'),
             ('${ASSET_B}','${OTHER}',null,'image','Leak','path/b.png','approved');
    insert into mcp_bot_clients (bot_id,client_id) values ('bot_client_delivery','${CLIENT}');
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

async function call(path: string, body: unknown, options: {
  headers?: Record<string, string | undefined>;
  secret?: string | null;
  method?: string;
  handler?: typeof handleMcpContent;
} = {}) {
  const headers = {
    authorization: `Bearer ${SECRET}`, 'x-aa-bot-id': 'bot_client_delivery',
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
  const handler = options.handler ?? handleMcpDelivery;
  await handler(req, res, sb, options.secret === undefined ? SECRET : options.secret);
  return { status, body: jsonBody, rpc };
}

const path = (s: string) => `/internal/mcp/delivery/${s}`;
const reads = ['get-client','get-status','get-plan','get-blockers','get-next-action','get-client-health'];
for (const view of reads) {
  it(`${view}: real granted read, other-client deny, revoked and suspended deny`, async () => {
    expect((await call(path(view), {client_id:CLIENT})).status).toBe(200);
    expect((await call(path(view), {client_id:OTHER})).body.error.code).toBe('client_forbidden');
    await db.exec(`delete from mcp_bot_clients;`);
    expect((await call(path(view), {client_id:CLIENT})).body.error.code).toBe('client_forbidden');
    await db.exec(`update mcp_internal.mcp_bots set status='suspended' where bot_id='bot_client_delivery'`);
    expect((await call(path(view), {client_id:CLIENT})).body.error.code).toBe('bot_not_active');
  });
}
it('lists only grants, paginates, and excludes revoked grants', async () => {
  expect((await call(path('list-clients'),{})).body.clients.map((c:any)=>c.id)).toEqual([CLIENT]);
  await db.exec(`insert into mcp_bot_clients values ('bot_client_delivery','${OTHER}',now())`);
  const first = await call(path('list-clients'),{limit:1});
  expect(first.body.next_cursor).toBe(CLIENT);
  expect((await call(path('list-clients'),{limit:1,after:CLIENT})).body.clients[0].id).toBe(OTHER);
  await db.exec('delete from mcp_bot_clients');
  expect((await call(path('list-clients'),{})).body.clients).toEqual([]);
  await db.exec(`update mcp_internal.mcp_bots set status='suspended' where bot_id='bot_client_delivery'`);
  expect((await call(path('list-clients'),{})).body.error.code).toBe('bot_not_active');
});
it('creates durable tasks, replays, conflicts and denies cross-client brief and revoked replay', async () => {
  const body = {client_id:CLIENT,title:'Collect input',due_date:'2026-01-01',brief_id:BRIEF};
  const first = await call(path('create-task'),body);
  expect(first.status).toBe(200);
  expect(first.body.replayed).toBe(false);
  const replay = await call(path('create-task'),body);
  expect(replay.body.task.id).toBe(first.body.task.id);
  expect(replay.body.replayed).toBe(true);
  expect((await call(path('create-task'),{...body,title:'Changed'})).body.error.code).toBe('idempotency_conflict');
  expect((await call(path('create-task'),{...body,client_id:OTHER})).body.error.code).toBe('client_forbidden');
  await db.exec(`insert into client_briefs(id,client_id,title,body) values ('${ASSET_B}','${OTHER}','Other','Secret')`);
  expect((await call(path('create-task'),{...body,brief_id:ASSET_B})).body.error.code).toBe('client_mismatch');
  const status = (await call(path('get-status'),{client_id:CLIENT})).body;
  expect(status.health).toBe('attention_required');
  expect(status.plan[0].id).toBe(first.body.task.id);
  await db.exec('delete from mcp_bot_clients');
  expect((await call(path('create-task'),body)).body.error.code).toBe('client_forbidden');
  await db.exec(`update mcp_internal.mcp_bots set status='suspended' where bot_id='bot_client_delivery'`);
  expect((await call(path('create-task'),body)).body.error.code).toBe('bot_not_active');
});
it('reports unknown health and outstanding onboarding honestly; caps output', async () => {
  expect((await call(path('get-client-health'),{client_id:CLIENT})).body.health).toBe('unknown');
  await db.exec(`insert into client_onboarding_steps(client_id,step_key,title) select '${CLIENT}',g::text,'Input '||g from generate_series(1,51) g`);
  const plan = (await call(path('get-plan'),{client_id:CLIENT})).body;
  expect(plan.truncated).toBe(true); expect(plan.total_open_records).toBe(51);
  expect(plan.plan).toHaveLength(50); expect(plan.plan[0].due_date).toBeNull();
});
it('keeps CDM production handoff working', async () => {
  expect((await call('/internal/mcp/content/get-production-status',{client_id:CLIENT,brief_id:BRIEF},{handler:handleMcpContent})).status).toBe(200);
});
it('validates auth and input before RPC', async () => {
  for (const body of [{client_id:CLIENT,title:' '},{client_id:CLIENT,title:'T',due_date:'2026-02-30'},{client_id:CLIENT,title:'T',member_id:BRIEF}]) {
    const r = await call(path('create-task'),body); expect(r.status).toBe(400); expect(r.rpc).not.toHaveBeenCalled();
  }
  const r=await call(path('list-clients'),{}, {secret:null}); expect(r.status).toBe(401); expect(r.rpc).not.toHaveBeenCalled();
});
it('all new functions are volatile and deny anon/authenticated execution', async () => {
  const result=await db.query<{signature:string;provolatile:string}>(`select oid::regprocedure::text signature,provolatile from pg_proc where proname like 'delivery_%' or proname like 'mcp_delivery_%'`);
  expect(result.rows).toHaveLength(6);
  for(const r of result.rows) {
    expect(r.provolatile).toBe('v');
    for(const role of ['anon','authenticated']) {
      expect((await db.query<{ok:boolean}>('select has_function_privilege($1,$2,\'EXECUTE\') ok',[role,r.signature])).rows[0]?.ok).toBe(false);
    }
  }
  for(const role of ['anon','authenticated']) {
    await db.exec(`set role ${role}`);
    await expect(db.query("select public.mcp_delivery_list_clients('bot_client_delivery')")).rejects.toThrow(/permission denied/);
    await db.exec('reset role');
  }
});
it('ledger forces RLS and task creation never creates assignments or jobs', async () => {
  const before = await db.query('select (select count(*) from job_assignments) assignments, (select count(*) from agent_jobs) jobs');
  await call(path('create-task'),{client_id:CLIENT,title:'Track only'});
  expect((await db.query('select (select count(*) from job_assignments) assignments, (select count(*) from agent_jobs) jobs')).rows).toEqual(before.rows);
  expect((await db.query(`select relrowsecurity,relforcerowsecurity from pg_class where oid='mcp_internal.mcp_delivery_tasks'::regclass`)).rows)
    .toEqual([{relrowsecurity:true,relforcerowsecurity:true}]);
  await db.exec(`insert into mcp_bot_clients values ('bot_client_delivery','${OTHER}',now())`);
  expect((await call(path('create-task'),{client_id:OTHER,title:'Track only'})).body.error.code).toBe('idempotency_conflict');
});
