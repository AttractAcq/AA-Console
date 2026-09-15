import { PGlite } from '@electric-sql/pglite';
import { readFile } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { EventEmitter } from 'node:events';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { SupabaseClient } from '@supabase/supabase-js';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { handleMcpPipeline } from './pipeline-route.js';
import { handleMcpSalesAgents } from './sales-agents-route.js';
import { handleMcpContent } from './content-route.js';
import { handleMcpProof } from './proof-route.js';

const CLIENT = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const LEAD = '33333333-3333-4333-8333-333333333333';
const LEAD_B = '44444444-4444-4444-8444-444444444444';
const AGENT = '55555555-5555-4555-8555-555555555555';
const PAGE = '66666666-6666-4666-8666-666666666666';
const BRIEF = '77777777-7777-4777-8777-777777777777';
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
    '20260903104724_04_intelligence_and_strategy.sql',
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
    '20260907130000_53_client_brand_profiles.sql',
    '20260908192515_67_sales_agents.sql',
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
    '20260915120000_84_mcp_sales_agent_factory.sql',
  ]) await db.exec(await migration(file));
  await db.exec(`
    alter table client_sales_agents add column if not exists approved_at timestamptz;
    alter table client_pages add column if not exists publish_status text not null default 'unpublished';
    alter table client_pages add column if not exists site_repository_id uuid;
    create table if not exists client_sales_agent_deployments (
      id uuid primary key default gen_random_uuid(),
      client_id uuid not null references clients (id) on delete cascade,
      sales_agent_id uuid not null references client_sales_agents (id) on delete cascade,
      page_id uuid not null references client_pages (id) on delete cascade,
      site_repository_id uuid,
      public_id text not null unique default md5(random()::text),
      allowed_origin text not null,
      enabled boolean not null default false,
      deployed_at timestamptz,
      disabled_at timestamptz,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );
    create unique index if not exists client_sales_agent_deployments_one_live
      on client_sales_agent_deployments (page_id) where enabled;
    alter table client_proof_assets
      add column if not exists claim text,
      add column if not exists usage_rights text not null default 'not_cleared',
      add column if not exists strength text not null default 'medium',
      add column if not exists proof_type text,
      add column if not exists evidence text,
      add column if not exists avatar_relevance text,
      add column if not exists captured_on date,
      add column if not exists expires_on date,
      add column if not exists updated_at timestamptz not null default now(),
      add column if not exists ref_number text;
    create table if not exists creative_generations (
      id uuid primary key default gen_random_uuid(),
      client_id uuid not null references clients (id) on delete cascade,
      brief_id uuid not null references client_briefs (id) on delete cascade,
      job_id uuid references agent_jobs (id) on delete set null,
      media_type media_type not null,
      stage text not null default 'concept',
      quality text not null default 'medium',
      size text not null default '1024x1536',
      asset_id uuid,
      error text,
      created_at timestamptz not null default now()
    );
    create table if not exists brief_dispatches (
      id uuid primary key default gen_random_uuid(),
      client_id uuid not null references clients (id) on delete cascade,
      brief_id uuid not null references client_briefs (id) on delete cascade,
      member_id uuid not null references team_members (id) on delete cascade,
      assignment_id uuid references job_assignments (id) on delete set null,
      job_id uuid references agent_jobs (id) on delete set null,
      email_status text not null default 'pending',
      email_error text,
      emailed_at timestamptz,
      sent_by uuid,
      created_at timestamptz not null default now(),
      unique (brief_id, member_id)
    );
    insert into agents (agent_key, name, initials, domain, description, requires_upstream)
    values ('creative_build', 'Creative Build', 'CB', 'content', 'fixture', '{}'),
           ('brief_dispatch', 'Brief Dispatch', 'BD', 'content', 'fixture', '{}')
    on conflict (agent_key) do nothing;
    -- This HTTP fixture does not load 85/86/87. 89's assert_cos_prohibitions
    -- still includes those phases, so drop the leftover seed wildcards they
    -- would have replaced. Also drop marketing's leftover proof.* so the
    -- Phase 16b proof-outside-production check can run.
    delete from mcp_internal.mcp_bot_permissions
     where permission_pattern in ('economics.*', 'engineering.*', 'security.*', 'proof.*');
  `);
  await db.exec(await migration('20260916120000_89_mcp_sales_proof_production.sql'));
}, 60_000);
afterAll(async () => { await db?.close(); });
beforeEach(async () => {
  await db.exec(`reset role;
    truncate mcp_internal.mcp_pipeline_requests, mcp_internal.mcp_sales_agent_requests,
      mcp_internal.mcp_proof_requests, mcp_internal.mcp_content_requests, mcp_bot_clients,
      lead_events, client_leads, sales_agent_conversations, client_sales_agent_deployments,
      client_sales_agents, client_pages, client_proof_assets, client_briefs, client_ideas,
      creative_generations, brief_dispatches, agent_job_events, agent_jobs,
      ref_counters, clients, profiles, auth.users cascade;
    update mcp_internal.mcp_bots set status = 'active';
    update agents set paused = false, archived_at = null, requires_upstream = '{}';
    insert into clients (id,name,initials) values ('${CLIENT}','First','FI'),('${OTHER}','Other','OT');
    insert into client_leads (id,client_id,name,email,stage) values
      ('${LEAD}','${CLIENT}','Alpha Lead','a@example.com','lead'),
      ('${LEAD_B}','${OTHER}','Other Lead','b@example.com','lead');
    insert into client_sales_agents (id,client_id,name,purpose,status,built_at,approved_at) values
      ('${AGENT}','${CLIENT}','Closer','Qualify and book','live', now(), now());
    insert into client_pages (id,client_id,page_type,title,status,published_url,publish_status) values
      ('${PAGE}','${CLIENT}','landing','Harbour','approved','https://harbour.example.test/offer','published');
    insert into client_briefs (id,client_id,title,body,status,media_type)
      values ('${BRIEF}','${CLIENT}','Brief','Body','approved','image');
    insert into mcp_bot_clients (bot_id,client_id) values
      ('bot_sales_ops','${CLIENT}'), ('bot_production','${CLIENT}');
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
const content = (path: string, body: unknown, options?: Parameters<typeof call>[3]) =>
  call(handleMcpContent, `/internal/mcp/content/${path}`, body, {
    ...options,
    headers: { 'x-aa-bot-id': 'bot_production', ...options?.headers },
  });
const proof = (path: string, body: unknown, options?: Parameters<typeof call>[3]) =>
  call(handleMcpProof, `/internal/mcp/proof/${path}`, body, {
    ...options,
    headers: { 'x-aa-bot-id': 'bot_production', ...options?.headers },
  });

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

describe('Phase 11b sales agent factory routes', () => {
  it('generates a draft config for the granted client and rejects an unknown client', async () => {
    const ok = await salesAgents('generate-config', { client_id: CLIENT, role: 'inbound_qualifier' });
    expect(ok.status).toBe(200);
    expect(ok.body.role).toBe('inbound_qualifier');
    expect(ok.body.draft.qualification.length).toBeGreaterThanOrEqual(1);
    expect((await salesAgents('generate-config', { client_id: OTHER, role: 'inbound_qualifier' })).body.error.code)
      .toBe('client_forbidden');
    const badRole = await salesAgents('generate-config', { client_id: CLIENT, role: 'not-a-role' });
    expect(badRole.status).toBe(400);
    expect(badRole.body.error.code).toBe('invalid_request');
  });

  it('creates a per-client agent and replays idempotently', async () => {
    const created = await salesAgents('create', {
      client_id: CLIENT, role: 'inbound_qualifier', name: 'Front Desk', purpose: 'Qualify and book',
    });
    expect(created.status).toBe(200);
    expect(created.body.role).toBe('inbound_qualifier');
    expect(created.body.status).toBe('draft');
    const replay = await salesAgents('create', {
      client_id: CLIENT, role: 'inbound_qualifier', name: 'Front Desk', purpose: 'Qualify and book',
    });
    expect(replay.body.replayed).toBe(true);
    expect(replay.body.id).toBe(created.body.id);
  });

  it('updates knowledge on the granted client agent and rejects a cross-client id', async () => {
    const updated = await salesAgents('update-knowledge', {
      client_id: CLIENT, sales_agent_id: AGENT,
      objections: [{ objection: 'Too expensive', response: 'Compare to the alternative' }],
      guardrails: 'Never quote a price.',
    });
    expect(updated.status).toBe(200);
    expect(updated.body.guardrails).toBe('Never quote a price.');
    expect(updated.body.objections).toHaveLength(1);
    const empty = await salesAgents('update-knowledge', { client_id: CLIENT, sales_agent_id: AGENT });
    expect(empty.status).toBe(400);
    const denied = await salesAgents('update-knowledge', {
      client_id: OTHER, sales_agent_id: AGENT, guardrails: 'x',
    }, { headers: { 'idempotency-key': 'uk-cross' } });
    expect(denied.status).toBe(403);
    expect(denied.body.error.code).toBe('client_forbidden');
  });

  it('replaces qualification rules on the granted client agent', async () => {
    const updated = await salesAgents('update-qualification-rules', {
      client_id: CLIENT, sales_agent_id: AGENT,
      qualification: [{ question: 'What is your timeline?', why: 'Timing', good_answer: 'Now', disqualifier: 'Never' }],
    });
    expect(updated.status).toBe(200);
    expect(updated.body.qualification).toHaveLength(1);
    const badShape = await salesAgents('update-qualification-rules', {
      client_id: CLIENT, sales_agent_id: AGENT, qualification: [],
    }, { headers: { 'idempotency-key': 'uq-empty' } });
    expect(badShape.status).toBe(400);
  });

  it('runs a sandbox test with no live channel send and rejects a cross-client id', async () => {
    const tested = await salesAgents('test', {
      client_id: CLIENT, sales_agent_id: AGENT,
      transcript: [{ role: 'lead', text: 'Hi, I need help.' }, { role: 'agent', text: 'What is your timeline?' }],
    });
    expect(tested.status).toBe(200);
    expect(tested.body.sandbox).toBe(true);
    expect(tested.body.live_channel_send).toBe(false);
    expect(tested.body.turns_evaluated).toBe(2);
    const denied = await salesAgents('test', {
      client_id: OTHER, sales_agent_id: AGENT, transcript: [{ role: 'lead', text: 'Hi' }],
    }, { headers: { 'idempotency-key': 'test-cross' } });
    expect(denied.status).toBe(403);
    expect(denied.body.error.code).toBe('client_forbidden');
  });
});

describe('Phase 16b sales attach/enable/build + proof + assign/submit routes', () => {
  it('attaches with enabled false and origin from the published URL', async () => {
    const attached = await salesAgents('attach-to-page', {
      client_id: CLIENT, sales_agent_id: AGENT, page_id: PAGE,
    });
    expect(attached.status).toBe(200);
    expect(attached.body.enabled).toBe(false);
    expect(attached.body.allowed_origin).toBe('https://harbour.example.test');
    const again = await salesAgents('attach-to-page', {
      client_id: CLIENT, sales_agent_id: AGENT, page_id: PAGE,
    }, { headers: { 'idempotency-key': 'attach-2' } });
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('already_attached');
  });

  it('enables then disables an existing deployment', async () => {
    const attached = await salesAgents('attach-to-page', {
      client_id: CLIENT, sales_agent_id: AGENT, page_id: PAGE,
    });
    const enabled = await salesAgents('set-deployment-enabled', {
      client_id: CLIENT, deployment_id: attached.body.id, enabled: true,
    }, { headers: { 'idempotency-key': 'en-1' } });
    expect(enabled.status).toBe(200);
    expect(enabled.body.enabled).toBe(true);
    const disabled = await salesAgents('set-deployment-enabled', {
      client_id: CLIENT, deployment_id: attached.body.id, enabled: false,
    }, { headers: { 'idempotency-key': 'en-0' } });
    expect(disabled.body.enabled).toBe(false);
  });

  it('builds by enqueueing a sales_agent job', async () => {
    const built = await salesAgents('build', { client_id: CLIENT, sales_agent_id: AGENT });
    expect([200, 202]).toContain(built.status);
    expect(built.body.job_id).toMatch(/^[0-9a-f-]{36}$/i);
    const replay = await salesAgents('build', { client_id: CLIENT, sales_agent_id: AGENT });
    expect(replay.status).toBe(200);
    expect(replay.body.job_id).toBe(built.body.job_id);
  });

  it('creates proof as not_cleared and rejects usage_rights on the wire', async () => {
    const created = await proof('create', {
      client_id: CLIENT, media_type: 'text', body: 'A Google review.',
    });
    expect(created.status).toBe(200);
    expect(created.body.usage_rights).toBe('not_cleared');
    const rights = await proof('create', {
      client_id: CLIENT, media_type: 'text', body: 'x', usage_rights: 'approved',
    }, { headers: { 'idempotency-key': 'rights' } });
    expect(rights.status).toBe(400);
    const searched = await proof('search', { client_id: CLIENT });
    expect(searched.status).toBe(200);
    expect(searched.body.count).toBeGreaterThanOrEqual(1);
  });

  it('assign_production AI and submit_asset write pending media', async () => {
    const assigned = await content('assign-production', {
      client_id: CLIENT, brief_id: BRIEF, route: 'ai',
    });
    expect(assigned.status).toBe(200);
    expect(assigned.body.route).toBe('ai');
    const submitted = await content('submit-asset', {
      client_id: CLIENT, storage_path: 'clients/out.png', media_type: 'image', brief_id: BRIEF,
    }, { headers: { 'idempotency-key': 'sub-1' } });
    expect(submitted.status).toBe(200);
    expect(submitted.body.review_status).toBe('pending');
  });
});
