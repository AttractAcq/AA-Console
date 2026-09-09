import { PGlite } from '@electric-sql/pglite';
import { readFile } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { EventEmitter } from 'node:events';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { SupabaseClient } from '@supabase/supabase-js';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { handleMcpContent } from './content-route.js';
import { handleMcpBrief } from './brief-route.js';

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
    insert into mcp_bot_clients (bot_id,client_id) values ('bot_production','${CLIENT}');
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
    authorization: `Bearer ${SECRET}`, 'x-aa-bot-id': 'bot_production',
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
  const handler = options.handler ?? handleMcpContent;
  await handler(req, res, sb, options.secret === undefined ? SECRET : options.secret);
  return { status, body: jsonBody, rpc };
}

describe('Phase 5 Production Manager content RPCs', () => {
  it('lists only the granted client ideas and never the other client', async () => {
    const result = await call('/internal/mcp/content/list-ideas', { client_id: CLIENT });
    expect(result.status).toBe(200);
    expect(result.body.client_id).toBe(CLIENT);
    expect(result.body.count).toBe(1);
    expect(result.body.ideas[0].id).toBe(IDEA);
    expect(result.body.ideas[0].title).toBe('A real idea');
    expect(JSON.stringify(result.body)).not.toContain(IDEA_B);
    expect(JSON.stringify(result.body)).not.toContain('Secret');
    expect((await call('/internal/mcp/content/list-ideas', { client_id: OTHER })).body.error.code)
      .toBe('client_forbidden');
  });

  it('gets one idea and rejects a cross-client idea id', async () => {
    const ok = await call('/internal/mcp/content/get-idea', { client_id: CLIENT, idea_id: IDEA });
    expect(ok.status).toBe(200);
    expect(ok.body.id).toBe(IDEA);
    expect(ok.body.strategic_reason).toBe('Say this');
    const mismatch = await call('/internal/mcp/content/get-idea', {
      client_id: CLIENT, idea_id: IDEA_B,
    });
    expect(mismatch.body.error.code).toBe('client_mismatch');
    expect(mismatch.status).toBe(403);
  });

  it('returns the original brief by idea or brief id', async () => {
    const byIdea = await call('/internal/mcp/content/get-brief', {
      client_id: CLIENT, idea_id: IDEA,
    });
    expect(byIdea.status).toBe(200);
    expect(byIdea.body.id).toBe(BRIEF);
    expect(byIdea.body.hook).toBe('A hook');
    const byBrief = await call('/internal/mcp/content/get-brief', {
      client_id: CLIENT, brief_id: BRIEF,
    });
    expect(byBrief.body.id).toBe(BRIEF);
    expect((await call('/internal/mcp/content/get-brief', {
      client_id: CLIENT, idea_id: IDEA_B,
    })).body.error.code).toBe('client_mismatch');
  });

  it('reports production status and a blocked distribution handoff', async () => {
    const result = await call('/internal/mcp/content/get-production-status', {
      client_id: CLIENT, idea_id: IDEA,
    });
    expect(result.status).toBe(200);
    expect(result.body.brief.id).toBe(BRIEF);
    expect(result.body.handoff.ready_for_distribution).toBe(false);
    expect(result.body.handoff.blocked_on).toBe('awaiting_asset_approval');
    expect(result.body.assets[0].id).toBe(ASSET);
  });

  it('records a revision, sets the brief back to draft, and replays', async () => {
    await db.exec(`update client_briefs set status = 'in_production' where id = '${BRIEF}'`);
    const first = await call('/internal/mcp/content/request-revision', {
      client_id: CLIENT, brief_id: BRIEF, summary: 'Hook is weak',
    });
    expect(first.status).toBe(200);
    expect(first.body.brief_status).toBe('draft');
    expect(first.body.replayed).toBe(false);
    expect((await db.query<{ status: string }>(
      `select status from client_briefs where id = '${BRIEF}'`,
    )).rows[0]?.status).toBe('draft');
    const replay = await call('/internal/mcp/content/request-revision', {
      client_id: CLIENT, brief_id: BRIEF, summary: 'Hook is weak',
    });
    expect(replay.body.replayed).toBe(true);
    const conflict = await call('/internal/mcp/content/request-revision', {
      client_id: CLIENT, brief_id: BRIEF, summary: 'Different reason',
    });
    expect(conflict.body.error.code).toBe('idempotency_conflict');
    expect((await call('/internal/mcp/content/request-revision', {
      client_id: CLIENT, asset_id: ASSET_B, summary: 'Steal',
    }, { headers: { 'idempotency-key': 'steal-1' } })).body.error.code).toBe('client_mismatch');
  });

  it('refuses to un-approve an approved asset on revision', async () => {
    await db.exec(`update client_media_assets set review_status = 'approved' where id = '${ASSET}'`);
    const result = await call('/internal/mcp/content/request-revision', {
      client_id: CLIENT, asset_id: ASSET, summary: 'Please redo',
    });
    expect(result.body.error.code).toBe('invalid_asset_status');
    expect((await db.query<{ review_status: string }>(
      `select review_status from client_media_assets where id = '${ASSET}'`,
    )).rows[0]?.review_status).toBe('approved');
  });

  it('requests approval without writing a human review decision', async () => {
    const pending = await call('/internal/mcp/content/request-approval', {
      client_id: CLIENT, asset_id: ASSET, summary: 'Ready for review',
    }, { headers: { 'idempotency-key': 'approval-1' } });
    expect(pending.status).toBe(200);
    expect(pending.body.queue).toBe('console_approvals');
    expect((await db.query<{ n: number }>(
      'select count(*)::int as n from client_asset_reviews',
    )).rows[0]?.n).toBe(0);
    expect((await db.query<{ review_status: string }>(
      `select review_status from client_media_assets where id = '${ASSET}'`,
    )).rows[0]?.review_status).toBe('pending');

    await db.exec(`delete from mcp_internal.mcp_content_requests;
      delete from client_media_assets;`);
    const briefOnly = await call('/internal/mcp/content/request-approval', {
      client_id: CLIENT, brief_id: BRIEF,
    }, { headers: { 'idempotency-key': 'approval-2' } });
    expect(briefOnly.body.queue).toBe('brief_ready_for_build');
    expect((await db.query<{ status: string }>(
      `select status from client_briefs where id = '${BRIEF}'`,
    )).rows[0]?.status).toBe('approved');
  });

  it('queues a repurpose plan only for an approved granted asset', async () => {
    expect((await call('/internal/mcp/content/create-repurpose-plan', {
      client_id: CLIENT, asset_id: ASSET, formats: ['reel'],
    })).body.error.code).toBe('invalid_asset_status');
    await db.exec(`update client_media_assets set review_status = 'approved' where id = '${ASSET}'`);
    const first = await call('/internal/mcp/content/create-repurpose-plan', {
      client_id: CLIENT, asset_id: ASSET, formats: ['reel', 'text_post'],
    });
    expect(first.status).toBe(202);
    expect(first.body.formats).toEqual(['reel', 'text_post']);
    expect(first.body.job_id).toMatch(/^[0-9a-f-]{36}$/i);
    const job = (await db.query<any>('select * from agent_jobs')).rows[0];
    expect(job.agent_key).toBe('repurpose');
    expect(job.created_by).toBeNull();
    expect(job.client_id).toBe(CLIENT);
    const replay = await call('/internal/mcp/content/create-repurpose-plan', {
      client_id: CLIENT, asset_id: ASSET, formats: ['reel', 'text_post'],
    });
    expect(replay.status).toBe(200);
    expect(replay.body.job_id).toBe(first.body.job_id);
    expect((await db.query<{ n: number }>('select count(*)::int as n from agent_jobs')).rows[0]?.n).toBe(1);
    expect((await call('/internal/mcp/content/create-repurpose-plan', {
      client_id: CLIENT, asset_id: ASSET_B, formats: ['reel'],
    }, { headers: { 'idempotency-key': 'repurpose-other' } })).body.error.code).toBe('client_mismatch');
    expect((await call('/internal/mcp/content/create-repurpose-plan', {
      client_id: CLIENT, asset_id: ASSET, formats: ['not-a-format'],
    }, { headers: { 'idempotency-key': 'repurpose-bad' } })).body.error.code).toBe('invalid_request');
  });

  it('does not change generate-brief routing or allow unauthenticated content calls', async () => {
    expect((await call('/internal/mcp/content/list-ideas', { client_id: CLIENT }, {
      headers: { authorization: 'Bearer wrong' },
    })).status).toBe(401);
    const brief = await call('/internal/mcp/content/generate-brief', {
      client_id: CLIENT, idea_id: IDEA,
    }, { handler: handleMcpBrief as any });
    expect(brief.status).toBe(202);
    expect(Object.keys(brief.body).sort()).toEqual(['client_id', 'job_id']);
  });

  it('anon and authenticated cannot execute the new Bot RPCs', async () => {
    for (const role of ['anon', 'authenticated']) {
      await db.exec(`set role ${role}`);
      await expect(db.query('select mcp_list_ideas($1,$2,$3,$4)', ['bot_production', CLIENT, 25, null]))
        .rejects.toThrow('permission denied');
      await expect(db.query(
        'select mcp_request_revision($1,$2,$3,$4,$5,$6,$7,$8)',
        ['bot_production', 'r', 'e', CLIENT, null, BRIEF, null, 'x'],
      )).rejects.toThrow('permission denied');
      await db.exec('reset role');
    }
  });

  it('revokes client grants on replay of a write', async () => {
    await db.exec(`update client_briefs set status = 'approved' where id = '${BRIEF}'`);
    await call('/internal/mcp/content/request-revision', {
      client_id: CLIENT, brief_id: BRIEF, summary: 'Redo',
    });
    await db.exec(`delete from mcp_bot_clients`);
    expect((await call('/internal/mcp/content/request-revision', {
      client_id: CLIENT, brief_id: BRIEF, summary: 'Redo',
    })).body.error.code).toBe('client_forbidden');
  });

  it('marks ready_for_distribution only after an approved asset', async () => {
    await db.exec(`update client_media_assets set review_status = 'approved' where id = '${ASSET}'`);
    const result = await call('/internal/mcp/content/get-production-status', {
      client_id: CLIENT, brief_id: BRIEF,
    });
    expect(result.body.handoff.ready_for_distribution).toBe(true);
    expect(result.body.handoff.approved_asset_id).toBe(ASSET);
    expect(result.body.handoff.blocked_on).toBeNull();
  });
});

describe('Phase 6 linked continuation HTTP', () => {
  const body = { client_id: CLIENT, asset_id: ASSET, formats: ['reel'], approval_execution_id: 'execution-1' };
  it('routes optional linkage to the secured resume RPC and retains correlation on 202/200', async () => {
    const requested = await call('/internal/mcp/content/request-approval', { client_id: CLIENT, asset_id: ASSET });
    expect(requested.body.approval.execution_id).toBe('execution-1');
    const waiting = await call('/internal/mcp/content/create-repurpose-plan', body);
    expect(waiting.status).toBe(409);
    expect(waiting.body.error.code).toBe('approval_required');
    expect(waiting.rpc.mock.calls[0]?.[0]).toBe('mcp_resume_approval');
    const user = '88888888-8888-4888-8888-888888888888';
    await db.exec(`insert into auth.users (id) values ('${user}');
      update profiles set role = 'admin' where id = '${user}';
      select set_config('request.jwt.claim.role','authenticated',false);
      select set_config('request.jwt.claim.sub','${user}',false);`);
    await db.query('select review_media_asset($1,$2,$3)', [ASSET, 'approved', 'Console']);
    await db.exec("select set_config('request.jwt.claim.role','service_role',false); select set_config('request.jwt.claim.sub','',false);");
    const first = await call('/internal/mcp/content/create-repurpose-plan', body, { headers: { 'idempotency-key': 'resume-1' } });
    expect(first.status).toBe(202);
    expect(first.body.approval_execution_id).toBe('execution-1');
    const retry = await call('/internal/mcp/content/create-repurpose-plan', body, { headers: { 'idempotency-key': 'resume-2' } });
    expect(retry.status).toBe(200);
    expect(retry.body.job_id).toBe(first.body.job_id);
    const status = await call('/internal/mcp/content/get-production-status', { client_id: CLIENT, asset_id: ASSET });
    expect(status.body.approvals[0].state).toBe('resumed');
    expect(status.body.approvals[0].resume.job_id).toBe(first.body.job_id);
  });

  it('rejects malformed root IDs and missing service authentication before SQL', async () => {
    for (const invalid of [null, '', 'bad root', 42, 'x'.repeat(129)]) {
      const result = await call('/internal/mcp/content/create-repurpose-plan', { ...body, approval_execution_id: invalid });
      expect(result.status).toBe(400);
      expect(result.rpc).not.toHaveBeenCalled();
    }
    const unauth = await call('/internal/mcp/content/create-repurpose-plan', body, { headers: { authorization: undefined } });
    expect(unauth.status).toBe(401);
    expect(unauth.rpc).not.toHaveBeenCalled();
    const absent = await call('/internal/mcp/content/create-repurpose-plan', body);
    expect(absent.status).toBe(404);
    expect(absent.body.error.code).toBe('approval_not_found');
  });
});
