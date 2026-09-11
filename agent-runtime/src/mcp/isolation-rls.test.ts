import { PGlite } from '@electric-sql/pglite';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const CLIENT_A = '11111111-1111-4111-8111-111111111111';
const CLIENT_B = '22222222-2222-4222-8222-222222222222';
const IDEA_A = '33333333-3333-4333-8333-333333333333';
const IDEA_B = '44444444-4444-4444-8444-444444444444';
const USER_A = '55555555-5555-4555-8555-555555555555';
const HASH = createHash('sha256').update('x'.repeat(40)).digest('hex');
let db: PGlite;
const migration = async (file: string) =>
  readFile(new URL(`../../../supabase/migrations/${file}`, import.meta.url), 'utf8');

async function asService() {
  await db.exec(`reset role;
    select set_config('request.jwt.claim.role','service_role',false);
    select set_config('request.jwt.claim.sub','',false);`);
}

async function enqueue(
  bot: string, requestId: string, executionId: string, clientId: string, ideaId: string,
) {
  return db.query<{ result: unknown }>(
    'select enqueue_mcp_brief($1,$2,$3,$4,$5) as result',
    [bot, requestId, executionId, clientId, ideaId],
  );
}

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
    '20260903104939_07_account_and_admin.sql',
    '20260904080405_14_campaigns.sql',
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
    -- Migration 19 (not otherwise loaded by this partial fixture) is where
    -- lead_events'/client_sales_agents'/sales_agent_conversations' own
    -- client-read policies (migrations 60/67) get this from. Defined inline,
    -- verbatim, rather than loading migration 19's full table sweep, which
    -- touches several tables this fixture does not create.
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
    '20260909010000_71_mcp_client_delivery.sql',
    '20260909020000_72_mcp_cos_orchestration.sql',
    '20260910120000_78_mcp_admin_calendar.sql',
  ]) await db.exec(await migration(file));
  await db.exec(`
    grant select on table clients, client_ideas, campaigns, finance_periods,
      client_leads, client_billing, finance_entries to authenticated;
    grant execute on function is_admin() to authenticated;
    grant execute on function current_role_of() to authenticated;
    grant execute on function can_access_client(uuid) to authenticated;
  `);
}, 60_000);

afterAll(async () => { await db?.close(); });

beforeEach(async () => {
  await db.exec(`reset role;
    truncate mcp_brief_requests, mcp_bot_clients, mcp_internal.mcp_bot_token_audit,
      mcp_internal.mcp_bot_tokens, mcp_internal.mcp_content_requests,
      mcp_internal.mcp_pipeline_requests, scheduled_posts,
      client_media_assets, client_ideas, agent_job_events, agent_jobs,
      campaigns, lead_events, client_leads, sales_agent_conversations, client_sales_agents,
      finance_entries, finance_periods, client_billing,
      client_users, clients, profiles, auth.users cascade;
    update mcp_internal.mcp_bots set status = 'active';
    update agents set paused = false, archived_at = null, requires_upstream = '{}';
    insert into auth.users (id) values ('${USER_A}');
    update profiles set role = 'client' where id = '${USER_A}';
    insert into clients (id,name,initials) values
      ('${CLIENT_A}','Alpha','AA'),('${CLIENT_B}','Beta','BB');
    insert into client_users (client_id, user_id) values ('${CLIENT_A}', '${USER_A}');
    insert into client_ideas (id,client_id,title,source,status) values
      ('${IDEA_A}','${CLIENT_A}','Idea A','manual','approved'),
      ('${IDEA_B}','${CLIENT_B}','Idea B','manual','approved');
    insert into mcp_bot_clients (bot_id, client_id) values ('bot_production', '${CLIENT_A}');
    insert into campaigns (campaign_ref, client_id, target_role, daily_spend)
      values ('A-1','${CLIENT_A}','owner',1), ('B-1','${CLIENT_B}','owner',1);
    insert into finance_periods (period, mrr) values ('2026-01-01', 1);
  `);
  await asService();
});

describe('Phase 4 RLS inventory (relrowsecurity must be on)', () => {
  it('records RLS on every present Bot-touched table and fails if any present table is off', async () => {
    const rows = await db.query<{
      nsp: string; rel: string; present: boolean; rls_enabled: boolean;
      rls_forced: boolean; policy_count: number;
    }>('select * from mcp_internal.bot_touched_rls_status() order by nsp, rel');
    const present = rows.rows.filter((r) => r.present);
    const missing = rows.rows.filter((r) => !r.present).map((r) => `${r.nsp}.${r.rel}`);
    const off = present.filter((r) => !r.rls_enabled);
    expect(off, `RLS disabled on ${off.map((r) => r.rel).join(',')}`).toEqual([]);
    expect(present.length).toBeGreaterThan(10);
    for (const name of [
      'clients', 'client_ideas', 'agent_jobs', 'mcp_bot_clients', 'mcp_brief_requests',
      'mcp_bots', 'mcp_bot_tokens', 'campaigns', 'finance_periods', 'client_leads',
      'lead_events', 'client_sales_agents', 'sales_agent_conversations',
    ]) {
      expect(present.some((r) => r.rel === name && r.rls_enabled)).toBe(true);
    }
    for (const name of [
      'mcp_bots', 'mcp_bot_tokens', 'mcp_bot_clients', 'mcp_brief_requests', 'mcp_content_requests',
      'mcp_pipeline_requests',
    ]) {
      expect(present.find((r) => r.rel === name)?.rls_forced).toBe(true);
    }
    // Partial PGlite fixture: later domain tables may be absent. Isolation is
    // claimed only for present tables. Full apply on staging must have none missing.
    expect(missing.every((n) => n.startsWith('public.') || n.startsWith('mcp_internal.'))).toBe(true);
  });
});

describe('Phase 4 permission matcher (SQL)', () => {
  it('allows exact or single-segment domain.* and rejects substring / multi-dot abuse', async () => {
    const q = (grant: string, tool: string) =>
      db.query<{ m: boolean }>('select mcp_internal.permission_matches($1,$2) as m', [grant, tool]);
    expect((await q('content.generate_brief', 'content.generate_brief')).rows[0]?.m).toBe(true);
    expect((await q('content.*', 'content.generate_brief')).rows[0]?.m).toBe(true);
    expect((await q('content.*', 'content.foo.bar')).rows[0]?.m).toBe(false);
    expect((await q('content.*', 'content.')).rows[0]?.m).toBe(false);
    expect((await q('content.*', 'content')).rows[0]?.m).toBe(false);
    expect((await q('content.*', 'contentX.generate_brief')).rows[0]?.m).toBe(false);
    expect((await q('content.generate', 'content.generate_brief')).rows[0]?.m).toBe(false);
    expect((await q('content*', 'content.generate_brief')).rows[0]?.m).toBe(false);
    expect((await q('*', 'content.generate_brief')).rows[0]?.m).toBe(false);
    expect((await q('content.*.x', 'content.generate_brief')).rows[0]?.m).toBe(false);
    await expect(db.exec(
      `insert into mcp_internal.mcp_bot_permissions (bot_id, permission_pattern, granted_by)
       values ('bot_production', 'content.*.x', 'test')`,
    )).rejects.toThrow();
    await expect(db.exec(
      `insert into mcp_internal.mcp_bot_permissions (bot_id, permission_pattern, granted_by)
       values ('bot_production', '*', 'test')`,
    )).rejects.toThrow();
  });
});

describe('Phase 4 CoS domain prohibitions', () => {
  it('seed stays clean and the write trigger rejects forbidden grants', async () => {
    await db.query('select mcp_internal.assert_cos_prohibitions()');
    expect((await db.query<{ m: boolean }>(
      "select mcp_internal.bot_has_permission('bot_production','economics.get_costs') as m",
    )).rows[0]?.m).toBe(false);
    expect((await db.query<{ m: boolean }>(
      "select mcp_internal.bot_has_permission('bot_production','security.get_system_status') as m",
    )).rows[0]?.m).toBe(false);
    expect((await db.query<{ m: boolean }>(
      "select mcp_internal.bot_has_permission('bot_production','sales_agents.deploy') as m",
    )).rows[0]?.m).toBe(false);
    expect((await db.query<{ m: boolean }>(
      "select mcp_internal.bot_has_permission('bot_finance','content.generate_brief') as m",
    )).rows[0]?.m).toBe(false);
    expect((await db.query<{ m: boolean }>(
      "select mcp_internal.bot_has_permission('bot_finance','content.submit_asset') as m",
    )).rows[0]?.m).toBe(false);
    expect((await db.query<{ m: boolean }>(
      "select mcp_internal.bot_has_permission('bot_security_devops','economics.get_revenue') as m",
    )).rows[0]?.m).toBe(false);
    expect((await db.query<{ m: boolean }>(
      "select mcp_internal.bot_has_permission('bot_security_devops','attribution.get_revenue_attribution') as m",
    )).rows[0]?.m).toBe(false);
    expect((await db.query<{ n: number }>(
      `select count(*)::int as n from mcp_internal.mcp_bot_permissions
        where bot_id = 'bot_security_devops'
          and (permission_pattern like '%finance%' or permission_pattern = 'finance_periods')`,
    )).rows[0]?.n).toBe(0);

    await expect(db.exec(
      `insert into mcp_internal.mcp_bot_permissions (bot_id, permission_pattern, granted_by)
       values ('bot_production', 'economics.*', 'test')`,
    )).rejects.toThrow(/CoS: bot_production/);
    await expect(db.exec(
      `insert into mcp_internal.mcp_bot_permissions (bot_id, permission_pattern, granted_by)
       values ('bot_finance', 'content.*', 'test')`,
    )).rejects.toThrow(/CoS: bot_finance/);
    await expect(db.exec(
      `insert into mcp_internal.mcp_bot_permissions (bot_id, permission_pattern, granted_by)
       values ('bot_security_devops', 'economics.*', 'test')`,
    )).rejects.toThrow(/CoS: bot_security_devops/);
    await expect(db.exec(
      `insert into mcp_internal.mcp_bot_permissions (bot_id, permission_pattern, granted_by)
       values ('bot_security_devops', 'finance_periods', 'test')`,
    )).rejects.toThrow();
    await expect(db.exec(
      `insert into mcp_internal.mcp_bot_permissions (bot_id, permission_pattern, granted_by)
       values ('bot_security_devops', 'attribution.get_revenue_attribution', 'test')`,
    )).rejects.toThrow(/CoS: bot_security_devops/);
  });
});

describe('Phase 4 cross-client isolation on an RLS-enabled database', () => {
  it('positive: same-client enqueue succeeds for a granted active bot', async () => {
    const result = await enqueue('bot_production', 'r1', 'e1', CLIENT_A, IDEA_A);
    expect(result.rows[0]?.result).toMatchObject({ client_id: CLIENT_A, replayed: false });
    expect((await db.query<{ n: number }>('select count(*)::int as n from agent_jobs')).rows[0]?.n).toBe(1);
    expect((await db.query<{ clients: string[] }>(
      "select mcp_list_bot_clients('bot_production') as clients",
    )).rows[0]?.clients).toEqual([CLIENT_A]);
  });

  it('negative: other-client id is client_forbidden and leaks no rows', async () => {
    await expect(enqueue('bot_production', 'r1', 'e1', CLIENT_B, IDEA_B)).rejects.toThrow('client_forbidden');
    expect((await db.query<{ n: number }>('select count(*)::int as n from agent_jobs')).rows[0]?.n).toBe(0);
    expect((await db.query<{ n: number }>('select count(*)::int as n from mcp_brief_requests')).rows[0]?.n).toBe(0);
    expect((await db.query<{ status: string }>(
      `select status from client_ideas where id = '${IDEA_B}'`,
    )).rows[0]?.status).toBe('approved');
  });

  it('negative: other-client resource with granted client_id is client_mismatch', async () => {
    await expect(enqueue('bot_production', 'r1', 'e1', CLIENT_A, IDEA_B)).rejects.toThrow('client_mismatch');
    expect((await db.query<{ n: number }>('select count(*)::int as n from agent_jobs')).rows[0]?.n).toBe(0);
    expect((await db.query<{ status: string }>(
      `select status from client_ideas where id = '${IDEA_B}'`,
    )).rows[0]?.status).toBe('approved');
  });

  it('revoked client grant is denied even on idempotent replay', async () => {
    await enqueue('bot_production', 'r1', 'e1', CLIENT_A, IDEA_A);
    await db.exec(`delete from mcp_bot_clients where bot_id = 'bot_production' and client_id = '${CLIENT_A}'`);
    await expect(enqueue('bot_production', 'r1', 'e1', CLIENT_A, IDEA_A)).rejects.toThrow('client_forbidden');
    expect((await db.query<{ n: number }>('select count(*)::int as n from agent_jobs')).rows[0]?.n).toBe(1);
  });

  it('ungranted bot is client_forbidden (migration seeds no client grants)', async () => {
    await expect(enqueue('bot_finance', 'r1', 'e1', CLIENT_A, IDEA_A)).rejects.toThrow('client_forbidden');
  });

  it('suspended bot is denied at the RPC even with a remaining client grant', async () => {
    await db.query('select mcp_issue_bot_token($1,$2,$3,$4)', ['bot_production', HASH, 'operator', 'test']);
    await db.query('select mcp_suspend_bot($1,$2,$3)', ['bot_production', 'operator', 'lock']);
    expect((await db.query<{ result: { status?: string } }>(
      'select mcp_resolve_bot_token($1) as result', [HASH],
    )).rows[0]?.result.status).toBe('suspended');
    await expect(enqueue('bot_production', 'r1', 'e1', CLIENT_A, IDEA_A)).rejects.toThrow('bot_not_active');
    expect((await db.query<{ n: number }>('select count(*)::int as n from agent_jobs')).rows[0]?.n).toBe(0);
  });

  it('Bot RPCs do not use can_access_client; human enqueue still does', async () => {
    const src = await db.query<{ def: string }>(
      "select pg_get_functiondef('enqueue_mcp_brief(text,text,text,uuid,uuid)'::regprocedure) as def",
    );
    expect(src.rows[0]?.def).toContain('require_bot_client_grant');
    expect(src.rows[0]?.def).not.toMatch(/can_access_client\s*\(/);
    const human = await db.query<{ def: string }>(
      "select pg_get_functiondef('enqueue_agent_job(text,uuid,text,uuid)'::regprocedure) as def",
    );
    expect(human.rows[0]?.def).toMatch(/can_access_client/);
  });

  it('anon and authenticated cannot execute Bot RPCs or read token hashes', async () => {
    for (const role of ['anon', 'authenticated']) {
      await db.exec(`set role ${role}`);
      await expect(enqueue('bot_production', 'r1', 'e1', CLIENT_A, IDEA_A)).rejects.toThrow('permission denied');
      await expect(db.query("select mcp_list_bot_clients('bot_production')")).rejects.toThrow('permission denied');
      await expect(db.query('select * from mcp_internal.mcp_bot_tokens')).rejects.toThrow('permission denied');
      await expect(db.query('select * from mcp_bot_clients')).rejects.toThrow('permission denied');
      await db.exec('reset role');
    }
    await asService();
  });

  it('authenticated RLS on domain tables hides the other client (RLS actually filters)', async () => {
    await db.exec(`
      select set_config('request.jwt.claim.role','authenticated',false);
      select set_config('request.jwt.claim.sub','${USER_A}',false);
      set role authenticated;
    `);
    const ideas = await db.query<{ client_id: string }>('select client_id from client_ideas');
    expect(ideas.rows.map((r) => r.client_id).sort()).toEqual([CLIENT_A]);
    const campaigns = await db.query<{ client_id: string }>('select client_id from campaigns');
    expect(campaigns.rows.map((r) => String(r.client_id)).sort()).toEqual([CLIENT_A]);
    const leaked = await db.query<{ n: number }>(
      `select count(*)::int as n from campaigns where client_id = '${CLIENT_B}'`,
    );
    expect(leaked.rows[0]?.n).toBe(0);
    const periods = await db.query('select * from finance_periods');
    expect(periods.rows.length).toBe(0);
    const clients = await db.query<{ id: string }>('select id from clients');
    expect(clients.rows.map((r) => r.id)).toEqual([CLIENT_A]);
    await db.exec('reset role');
    await asService();
  });
});

describe('Phase 5 Production Manager isolation', () => {
  const BRIEF_A = 'aaaaaaa1-aaaa-4aaa-8aaa-aaaaaaaaaaa1';
  const BRIEF_B = 'bbbbbbb1-bbbb-4bbb-8bbb-bbbbbbbbbbb1';
  const ASSET_A = 'aaaaaaa2-aaaa-4aaa-8aaa-aaaaaaaaaaa2';
  const ASSET_B = 'bbbbbbb2-bbbb-4bbb-8bbb-bbbbbbbbbbb2';

  const contentRpcs = [
    'mcp_internal.list_ideas(text,uuid,integer,text)',
    'mcp_internal.get_idea(text,uuid,uuid)',
    'mcp_internal.get_brief(text,uuid,uuid,uuid)',
    'mcp_internal.get_production_status(text,uuid,uuid,uuid,uuid)',
    'mcp_internal.request_revision(text,text,text,uuid,uuid,uuid,uuid,text)',
    'mcp_internal.request_approval(text,text,text,uuid,uuid,uuid,uuid,text)',
    'mcp_internal.create_repurpose_plan(text,text,text,uuid,uuid,text[])',
  ];

  beforeEach(async () => {
    await db.exec(`
      insert into client_briefs (id, client_id, source_idea_id, title, body, status)
        values ('${BRIEF_A}','${CLIENT_A}','${IDEA_A}','Brief A','Body A','draft'),
               ('${BRIEF_B}','${CLIENT_B}','${IDEA_B}','Brief B','Secret B','draft');
      insert into client_media_assets (id, client_id, brief_id, media_type, title, storage_path, review_status)
        values ('${ASSET_A}','${CLIENT_A}','${BRIEF_A}','image','Cut A','path/a.png','pending'),
               ('${ASSET_B}','${CLIENT_B}','${BRIEF_B}','image','Cut B','path/b.png','approved');
    `);
  });

  it('every new content RPC uses require_active_bot + require_bot_client_grant and never can_access_client', async () => {
    const grant = await db.query<{ def: string }>(
      "select pg_get_functiondef('mcp_internal.require_bot_client_grant(text,uuid)'::regprocedure) as def",
    );
    expect(grant.rows[0]?.def).toContain('require_active_bot');
    expect(grant.rows[0]?.def).toMatch(/for\s+share/i);
    expect(grant.rows[0]?.def).not.toMatch(/can_access_client\s*\(/);
    for (const sig of contentRpcs) {
      const src = await db.query<{ def: string }>(
        `select pg_get_functiondef('${sig}'::regprocedure) as def`,
      );
      expect(src.rows[0]?.def, sig).toContain('require_active_bot');
      expect(src.rows[0]?.def, sig).toContain('require_bot_client_grant');
      expect(src.rows[0]?.def, sig).not.toMatch(/can_access_client\s*\(/);
      expect(src.rows[0]?.def, sig).not.toMatch(/\breview_media_asset\s*\(/);
    }
    const readRpcs = [
      'mcp_internal.list_ideas(text,uuid,integer,text)',
      'mcp_internal.get_idea(text,uuid,uuid)',
      'mcp_internal.get_brief(text,uuid,uuid,uuid)',
      'mcp_internal.get_production_status(text,uuid,uuid,uuid,uuid)',
      'public.mcp_list_ideas(text,uuid,integer,text)',
      'public.mcp_get_idea(text,uuid,uuid)',
      'public.mcp_get_brief(text,uuid,uuid,uuid)',
      'public.mcp_get_production_status(text,uuid,uuid,uuid,uuid)',
    ];
    for (const sig of readRpcs) {
      const vol = await db.query<{ vol: string }>(
        `select provolatile as vol from pg_proc where oid = '${sig}'::regprocedure`,
      );
      expect(vol.rows[0]?.vol, `${sig} must be VOLATILE (FOR SHARE in grant helper)`).toBe('v');
    }
    for (const role of ['anon', 'authenticated']) {
      await db.exec(`set role ${role}`);
      await expect(db.query('select mcp_list_ideas($1,$2,$3,$4)', ['bot_production', CLIENT_A, 25, null]))
        .rejects.toThrow('permission denied');
      await expect(db.query('select mcp_get_brief($1,$2,$3,$4)', ['bot_production', CLIENT_A, null, IDEA_A]))
        .rejects.toThrow('permission denied');
      await expect(db.query(
        'select mcp_request_revision($1,$2,$3,$4,$5,$6,$7,$8)',
        ['bot_production', 'r', 'e', CLIENT_A, null, BRIEF_A, null, 'x'],
      )).rejects.toThrow('permission denied');
      await db.exec('reset role');
    }
    await asService();
  });

  it('list_ideas / get_idea are client-scoped (forbidden vs mismatch)', async () => {
    const ok = await db.query<{ result: { count: number; ideas: { id: string }[] } }>(
      'select mcp_list_ideas($1,$2,$3,$4) as result',
      ['bot_production', CLIENT_A, 25, null],
    );
    expect(ok.rows[0]?.result.count).toBe(1);
    expect(ok.rows[0]?.result.ideas.map((i) => i.id)).toEqual([IDEA_A]);
    await expect(db.query(
      'select mcp_list_ideas($1,$2,$3,$4)',
      ['bot_production', CLIENT_B, 25, null],
    )).rejects.toThrow('client_forbidden');
    await expect(db.query(
      'select mcp_get_idea($1,$2,$3)',
      ['bot_production', CLIENT_A, IDEA_B],
    )).rejects.toThrow('client_mismatch');
  });

  it('get_brief and get_production_status reject other-client id and resource', async () => {
    const brief = await db.query<{ result: { id: string } }>(
      'select mcp_get_brief($1,$2,$3,$4) as result',
      ['bot_production', CLIENT_A, BRIEF_A, null],
    );
    expect(brief.rows[0]?.result.id).toBe(BRIEF_A);
    await expect(db.query(
      'select mcp_get_brief($1,$2,$3,$4)',
      ['bot_production', CLIENT_B, BRIEF_B, null],
    )).rejects.toThrow('client_forbidden');
    await expect(db.query(
      'select mcp_get_brief($1,$2,$3,$4)',
      ['bot_production', CLIENT_A, BRIEF_B, null],
    )).rejects.toThrow('client_mismatch');
    const status = await db.query<{ result: { brief: { id: string } } }>(
      'select mcp_get_production_status($1,$2,$3,$4,$5) as result',
      ['bot_production', CLIENT_A, IDEA_A, null, null],
    );
    expect(status.rows[0]?.result.brief.id).toBe(BRIEF_A);
    await expect(db.query(
      'select mcp_get_production_status($1,$2,$3,$4,$5)',
      ['bot_production', CLIENT_A, null, null, ASSET_B],
    )).rejects.toThrow('client_mismatch');
  });

  it('request_revision and request_approval isolate writes; approval does not decide', async () => {
    const revision = await db.query<{ result: { brief_status: string } }>(
      'select mcp_request_revision($1,$2,$3,$4,$5,$6,$7,$8) as result',
      ['bot_production', 'rev-r', 'rev-e', CLIENT_A, null, BRIEF_A, null, 'Hook is weak'],
    );
    expect(revision.rows[0]?.result.brief_status).toBe('draft');
    await expect(db.query(
      'select mcp_request_revision($1,$2,$3,$4,$5,$6,$7,$8)',
      ['bot_production', 'rev-b', 'rev-b', CLIENT_B, null, BRIEF_B, null, 'Steal'],
    )).rejects.toThrow('client_forbidden');
    await expect(db.query(
      'select mcp_request_revision($1,$2,$3,$4,$5,$6,$7,$8)',
      ['bot_production', 'rev-m', 'rev-m', CLIENT_A, null, BRIEF_B, null, 'Steal'],
    )).rejects.toThrow('client_mismatch');
    expect((await db.query<{ status: string }>(
      `select status from client_briefs where id = '${BRIEF_B}'`,
    )).rows[0]?.status).toBe('draft');

    const approval = await db.query<{ result: { queue: string } }>(
      'select mcp_request_approval($1,$2,$3,$4,$5,$6,$7,$8) as result',
      ['bot_production', 'ap-r', 'ap-e', CLIENT_A, null, null, ASSET_A, null],
    );
    expect(approval.rows[0]?.result.queue).toBe('console_approvals');
    expect((await db.query<{ n: number }>(
      'select count(*)::int as n from client_asset_reviews',
    )).rows[0]?.n).toBe(0);
    await expect(db.query(
      'select mcp_request_approval($1,$2,$3,$4,$5,$6,$7,$8)',
      ['bot_production', 'ap-b', 'ap-b', CLIENT_A, null, null, ASSET_B, null],
    )).rejects.toThrow('client_mismatch');
  });

  it('create_repurpose_plan is granted-client only and refuses the other client asset', async () => {
    await db.exec(`update client_media_assets set review_status = 'approved' where id = '${ASSET_A}'`);
    const ok = await db.query<{ result: { client_id: string } }>(
      'select mcp_create_repurpose_plan($1,$2,$3,$4,$5,$6) as result',
      ['bot_production', 'rp-r', 'rp-e', CLIENT_A, ASSET_A, ['reel']],
    );
    expect(ok.rows[0]?.result.client_id).toBe(CLIENT_A);
    await expect(db.query(
      'select mcp_create_repurpose_plan($1,$2,$3,$4,$5,$6)',
      ['bot_production', 'rp-b', 'rp-b', CLIENT_B, ASSET_B, ['reel']],
    )).rejects.toThrow('client_forbidden');
    await expect(db.query(
      'select mcp_create_repurpose_plan($1,$2,$3,$4,$5,$6)',
      ['bot_production', 'rp-m', 'rp-m', CLIENT_A, ASSET_B, ['reel']],
    )).rejects.toThrow('client_mismatch');
    expect((await db.query<{ n: number }>(
      `select count(*)::int as n from agent_jobs where client_id = '${CLIENT_B}'`,
    )).rows[0]?.n).toBe(0);
  });

  it('suspended bot is bot_not_active on Phase 5 RPCs even with a remaining grant', async () => {
    await db.query('select mcp_issue_bot_token($1,$2,$3,$4)', ['bot_production', HASH, 'operator', 'test']);
    await db.query('select mcp_suspend_bot($1,$2,$3)', ['bot_production', 'operator', 'lock']);
    await expect(db.query(
      'select mcp_list_ideas($1,$2,$3,$4)',
      ['bot_production', CLIENT_A, 25, null],
    )).rejects.toThrow('bot_not_active');
    await expect(db.query(
      'select mcp_get_idea($1,$2,$3)',
      ['bot_production', CLIENT_A, IDEA_A],
    )).rejects.toThrow('bot_not_active');
  });
  const requestApproval = (execution = 'approval-root', client = CLIENT_A, asset: string | null = ASSET_A) => db.query<{ result: any }>(
    'select mcp_request_approval($1,$2,$3,$4,$5,$6,$7,$8) as result',
    ['bot_production', 'approval-request', execution, client, null, asset ? null : BRIEF_A, asset, null],
  );
  const productionStatus = () => db.query<{ result: any }>(
    'select mcp_get_production_status($1,$2,$3,$4,$5) as result',
    ['bot_production', CLIENT_A, null, null, ASSET_A],
  );
  const resumeApproval = (overrides: Partial<{ bot: string; client: string; asset: string; root: string; formats: string[]; execution: string }> = {}) =>
    db.query<{ result: any }>('select mcp_resume_approval($1,$2,$3,$4,$5,$6,$7) as result', [
      overrides.bot ?? 'bot_production', 'resume-request', overrides.execution ?? 'resume-receipt',
      overrides.client ?? CLIENT_A, overrides.asset ?? ASSET_A, overrides.formats ?? ['reel'],
      overrides.root ?? 'approval-root',
    ]);
  async function humanReview(decision: 'approved' | 'rejected', asset = ASSET_A) {
    await db.exec(`reset role;
      grant execute on function review_media_asset(uuid,review_status,text) to authenticated;
      select set_config('request.jwt.claim.role','authenticated',false);
      select set_config('request.jwt.claim.sub','${USER_A}',false);
      set role authenticated;`);
    await db.query('select review_media_asset($1,$2,$3)', [asset, decision, 'Human Console fixture']);
    await asService();
  }

  it('Phase 6 pauses, observes real human Console approval and resumes one durable logical execution', async () => {
    const first = (await requestApproval()).rows[0]!.result;
    const replay = (await requestApproval()).rows[0]!.result;
    expect(first.approval).toEqual({ execution_id: 'approval-root', request_id: 'approval-request' });
    expect(replay.replayed).toBe(true);
    expect((await productionStatus()).rows[0]!.result.approvals[0].state).toBe('waiting_for_human');
    await expect(resumeApproval()).rejects.toThrow('approval_required');
    expect((await db.query('select * from client_asset_reviews')).rows).toHaveLength(0);
    await humanReview('approved');
    const approved = (await productionStatus()).rows[0]!.result;
    expect(approved.handoff.ready_for_distribution).toBe(true);
    expect(approved.approvals[0]).toMatchObject({ state: 'approved', decision: { reviewed_by: USER_A, decision: 'approved' } });
    const resumed = (await resumeApproval()).rows[0]!.result;
    const repeated = (await resumeApproval({ execution: 'different-gateway-receipt' })).rows[0]!.result;
    expect(resumed.approval_execution_id).toBe('approval-root');
    expect(resumed.replayed).toBe(false);
    expect(repeated.replayed).toBe(true);
    expect(repeated.job_id).toBe(resumed.job_id);
    await expect(resumeApproval({ formats: ['carousel'] })).rejects.toThrow('idempotency_conflict');
    const status = (await productionStatus()).rows[0]!.result;
    expect(status.approvals[0]).toMatchObject({ state: 'resumed', execution_id: 'approval-root', resume: { job_id: resumed.job_id } });
    expect((await db.query("select * from agent_jobs where agent_key = 'repurpose'")).rows).toHaveLength(1);
    expect((await db.query('select * from mcp_internal.mcp_content_requests where approval_execution_id is not null')).rows).toHaveLength(1);
    expect((await db.query("select * from mcp_internal.mcp_content_requests where tool = 'content.request_approval'")).rows).toHaveLength(1);
    await requestApproval('another-root');
    await expect(resumeApproval({ root: 'another-root' })).rejects.toThrow('idempotency_conflict');
    await humanReview('rejected');
    expect((await productionStatus()).rows[0]!.result.approvals[0].state).toBe('rejected');
    expect((await productionStatus()).rows[0]!.result.handoff.ready_for_distribution).toBe(false);
    await expect(resumeApproval()).rejects.toThrow('approval_required');
  });

  it('Phase 6 brief-only wait follows human build and review, and standalone asset waits also resolve', async () => {
    await db.exec(`delete from client_media_assets where id = '${ASSET_A}'`);
    await requestApproval('approval-root', CLIENT_A, null);
    const q = () => db.query<{ result: any }>('select mcp_get_production_status($1,$2,$3,$4,$5) as result',
      ['bot_production', CLIENT_A, null, BRIEF_A, null]);
    expect((await q()).rows[0]!.result.approvals[0].state).toBe('awaiting_production');
    await db.exec(`insert into client_media_assets (id,client_id,brief_id,media_type,title,storage_path)
      values ('${ASSET_A}','${CLIENT_A}','${BRIEF_A}','image','Built by human','a.png')`);
    await humanReview('approved');
    expect((await q()).rows[0]!.result.approvals[0].state).toBe('approved');
    await resumeApproval();
    expect((await q()).rows[0]!.result.approvals[0].state).toBe('resumed');
    await db.exec(`update client_media_assets set brief_id = null where id = '${ASSET_A}'`);
    await requestApproval('standalone');
    expect((await productionStatus()).rows[0]!.result.handoff.ready_for_distribution).toBe(true);
  });

  it('Phase 6 requires human review evidence and cannot use an approved sibling for an exact asset wait', async () => {
    await requestApproval();
    await db.exec(`update client_media_assets set review_status = 'approved' where id = '${ASSET_A}'`);
    expect((await productionStatus()).rows[0]!.result.handoff.ready_for_distribution).toBe(false);
    await expect(resumeApproval()).rejects.toThrow('approval_required');
    const sibling = 'aaaaaaa3-aaaa-4aaa-8aaa-aaaaaaaaaaa3';
    await db.exec(`update client_media_assets set review_status = 'pending' where id = '${ASSET_A}';
      insert into client_media_assets (id,client_id,brief_id,media_type,title,storage_path)
        values ('${sibling}','${CLIENT_A}','${BRIEF_A}','image','Sibling','s.png')`);
    await humanReview('approved', sibling);
    const status = (await productionStatus()).rows[0]!.result;
    expect(status.handoff.ready_for_distribution).toBe(false);
    expect(status.handoff.approved_asset_id).toBeNull();
    await expect(resumeApproval({ asset: sibling })).rejects.toThrow('approval_resource_mismatch');
  });

  it('Phase 6 isolates new RPCs and approval projections by Bot, client and resource', async () => {
    await requestApproval();
    await humanReview('approved');
    await expect(resumeApproval({ client: CLIENT_B })).rejects.toThrow('client_forbidden');
    await expect(resumeApproval({ asset: ASSET_B })).rejects.toThrow('client_mismatch');
    await db.exec(`insert into mcp_bot_clients (bot_id,client_id) values ('bot_distribution','${CLIENT_A}');`);
    await expect(resumeApproval({ bot: 'bot_distribution' })).rejects.toThrow('approval_not_found');
    const otherBot = await db.query<{ result: any }>('select mcp_get_production_status($1,$2,$3,$4,$5) as result',
      ['bot_distribution', CLIENT_A, null, null, ASSET_A]);
    expect(otherBot.rows[0]!.result.approvals).toEqual([]);
    await db.exec(`insert into mcp_bot_clients (bot_id,client_id) values ('bot_production','${CLIENT_B}');`);
    await expect(resumeApproval({ client: CLIENT_B, asset: ASSET_B })).rejects.toThrow('client_mismatch');
    await expect(db.query('select mcp_internal.get_approval($1,$2,$3)',
      ['bot_production', CLIENT_B, 'approval-root'])).rejects.toThrow('client_mismatch');
    await expect(resumeApproval({ root: 'missing' })).rejects.toThrow('approval_not_found');
  });

  it('Phase 6 revocation and suspension deny reads and resumed replays before lookup', async () => {
    await requestApproval();
    await humanReview('approved');
    await resumeApproval();
    await db.exec(`delete from mcp_bot_clients where bot_id = 'bot_production';`);
    await expect(resumeApproval()).rejects.toThrow('client_forbidden');
    await expect(productionStatus()).rejects.toThrow('client_forbidden');
    await expect(requestApproval()).rejects.toThrow('client_forbidden');
    await db.exec(`insert into mcp_bot_clients (bot_id,client_id) values ('bot_production','${CLIENT_A}');
      update mcp_internal.mcp_bots set status = 'suspended' where bot_id = 'bot_production';`);
    await expect(resumeApproval()).rejects.toThrow('bot_not_active');
    await expect(productionStatus()).rejects.toThrow('bot_not_active');
    await expect(requestApproval()).rejects.toThrow('bot_not_active');
    await expect(db.query('select mcp_internal.get_approval($1,$2,$3)',
      ['bot_production', CLIENT_A, 'approval-root'])).rejects.toThrow('bot_not_active');
  });

  it('Phase 6 enforces execute ACLs, forced ledger RLS, active/grant helpers and VOLATILE reads', async () => {
    const signatures = [
      'mcp_internal.get_approval(text,uuid,text)',
      'mcp_internal.resume_approval(text,text,text,uuid,uuid,text[],text)',
      'public.mcp_resume_approval(text,text,text,uuid,uuid,text[],text)',
    ];
    for (const sig of signatures) {
      const def = (await db.query<{ def: string; volatility: string }>(
        'select pg_get_functiondef(oid) as def, provolatile as volatility from pg_proc where oid = $1::regprocedure', [sig])).rows[0]!;
      expect(def.def).toContain('require_active_bot');
      expect(def.def).toContain('require_bot_client_grant');
      expect(def.def).not.toMatch(/(?:can_access_client|review_media_asset)\s*\(/);
      expect(def.volatility).toBe('v');
      for (const role of ['anon', 'authenticated', 'service_role']) {
        expect((await db.query<{ allowed: boolean }>('select has_function_privilege($1,$2,\'EXECUTE\') as allowed', [role, sig])).rows[0]!.allowed)
          .toBe(role === 'service_role');
      }
    }
    for (const name of ['mcp_internal.get_production_status(text,uuid,uuid,uuid,uuid)',
      'public.mcp_get_production_status(text,uuid,uuid,uuid,uuid)',
      'public.mcp_list_ideas(text,uuid,integer,text)', 'public.mcp_get_idea(text,uuid,uuid)',
      'public.mcp_get_brief(text,uuid,uuid,uuid)']) {
      expect((await db.query<{ v: string }>('select provolatile as v from pg_proc where oid = $1::regprocedure', [name])).rows[0]!.v).toBe('v');
    }
    for (const role of ['anon', 'authenticated']) {
      await db.exec(`set role ${role}`);
      await expect(resumeApproval()).rejects.toThrow('permission denied');
      await db.exec('reset role');
    }
    await asService();
    await db.exec('set role service_role');
    await expect(db.query('select * from mcp_internal.mcp_content_requests')).rejects.toThrow('permission denied');
    await db.exec('reset role');
    await requestApproval();
    await humanReview('approved');
    await db.exec('set role service_role');
    expect((await resumeApproval()).rows[0]!.result.job_id).toBeTruthy();
  });

  it('Phase 6 P1-1 binds resumed brief decisions to the continuation asset', async () => {
    await requestApproval('approval-root', CLIENT_A, null);
    await humanReview('approved');
    const resumed = (await resumeApproval()).rows[0]!.result;
    const sibling = 'aaaaaaa3-aaaa-4aaa-8aaa-aaaaaaaaaaa3';
    await db.exec(`insert into client_media_assets (id,client_id,brief_id,media_type,title,storage_path)
      values ('${sibling}','${CLIENT_A}','${BRIEF_A}','image','Different asset','s.png')`);
    await humanReview('approved', sibling);
    await humanReview('rejected');
    const status = (await db.query<{ result: any }>('select mcp_get_production_status($1,$2,$3,$4,$5) as result',
      ['bot_production', CLIENT_A, null, BRIEF_A, null])).rows[0]!.result;
    expect(status.approvals[0].resume.job_id).toBe(resumed.job_id);
    expect(status.approvals[0].resume.asset_id).toBe(ASSET_A);
    expect(status.approvals[0].decision.asset_id).toBe(ASSET_A);
    expect(status.approvals[0].decision.decision).toBe('rejected');
    expect(status.approvals[0].approved_asset_id).toBeNull();
    expect(status.approvals[0].state).toBe('rejected');
    expect(status.handoff.ready_for_distribution).toBe(false);
  });

  it('Phase 6 P1-2 evaluates blockers beyond the latest 50 displayed requests', async () => {
    await requestApproval();
    await humanReview('rejected');
    const sibling = 'aaaaaaa3-aaaa-4aaa-8aaa-aaaaaaaaaaa3';
    await db.exec(`insert into client_media_assets (id,client_id,brief_id,media_type,title,storage_path)
      values ('${sibling}','${CLIENT_A}','${BRIEF_A}','image','Approved sibling','s.png')`);
    await humanReview('approved', sibling);
    const q = () => db.query<{ result: any }>('select mcp_get_production_status($1,$2,$3,$4,$5) as result',
      ['bot_production', CLIENT_A, null, BRIEF_A, null]);
    const before = (await q()).rows[0]!.result;
    expect(before.handoff.ready_for_distribution).toBe(false);
    for (let n = 0; n < 50; n++) await requestApproval(`new-${n}`, CLIENT_A, sibling);
    const after = (await q()).rows[0]!.result;
    expect(after.approvals).toHaveLength(50);
    expect(after.approvals.some((a: any) => a.execution_id === 'approval-root')).toBe(false);
    expect(after.handoff.ready_for_distribution).toBe(false);
    // Only a real human decision resolves the old wait, even while it is off-page.
    await humanReview('approved');
    expect((await q()).rows[0]!.result.handoff.ready_for_distribution).toBe(true);
  });

});

describe('Phase 9b Production Bot decide isolation', () => {
  const DRAFT_IDEA_A = '99999991-9999-4999-8999-999999999991';
  const DRAFT_IDEA_B = '99999992-9999-4999-8999-999999999992';
  const PENDING_ASSET_A = '99999993-9999-4999-8999-999999999993';
  const PENDING_ASSET_B = '99999994-9999-4999-8999-999999999994';

  const approveIdea = (
    bot = 'bot_production', client = CLIENT_A, idea = DRAFT_IDEA_A, execution = 'idea-exec',
  ) => db.query<{ result: any }>(
    'select mcp_approve_idea($1,$2,$3,$4,$5) as result',
    [bot, 'idea-req', execution, client, idea],
  );
  const approveAsset = (
    overrides: Partial<{ bot: string; client: string; asset: string; decision: string; execution: string; reason: string | null }> = {},
  ) => db.query<{ result: any }>(
    'select mcp_approve_asset($1,$2,$3,$4,$5,$6,$7) as result',
    [
      overrides.bot ?? 'bot_production', 'asset-req', overrides.execution ?? 'asset-exec',
      overrides.client ?? CLIENT_A, overrides.asset ?? PENDING_ASSET_A,
      overrides.decision ?? 'approved', overrides.reason ?? null,
    ],
  );

  beforeEach(async () => {
    await db.exec(`
      insert into client_ideas (id,client_id,title,source,status) values
        ('${DRAFT_IDEA_A}','${CLIENT_A}','Draft A','manual','draft'),
        ('${DRAFT_IDEA_B}','${CLIENT_B}','Draft B','manual','draft');
      insert into client_media_assets (id,client_id,media_type,title,storage_path,review_status) values
        ('${PENDING_ASSET_A}','${CLIENT_A}','image','Cut A','path/pa.png','pending'),
        ('${PENDING_ASSET_B}','${CLIENT_B}','image','Cut B','path/pb.png','pending');
      insert into mcp_bot_clients (bot_id, client_id) values ('bot_marketing', '${CLIENT_A}');
    `);
  });

  it('every new RPC uses require_active_bot + require_bot_client_grant, never can_access_client/review_media_asset, and hard-codes bot_production', async () => {
    const internalSignatures = [
      'mcp_internal.approve_idea(text,text,text,uuid,uuid)',
      'mcp_internal.approve_asset(text,text,text,uuid,uuid,text,text)',
    ];
    const publicSignatures = [
      'public.mcp_approve_idea(text,text,text,uuid,uuid)',
      'public.mcp_approve_asset(text,text,text,uuid,uuid,text,text)',
    ];
    for (const sig of internalSignatures) {
      const src = await db.query<{ def: string }>(
        `select pg_get_functiondef('${sig}'::regprocedure) as def`,
      );
      expect(src.rows[0]?.def, sig).toContain('require_active_bot');
      expect(src.rows[0]?.def, sig).toContain('require_bot_client_grant');
      expect(src.rows[0]?.def, sig).not.toMatch(/can_access_client\s*\(/);
      expect(src.rows[0]?.def, sig).not.toMatch(/\breview_media_asset\s*\(/);
    }
    for (const sig of publicSignatures) {
      const src = await db.query<{ def: string }>(
        `select pg_get_functiondef('${sig}'::regprocedure) as def`,
      );
      expect(src.rows[0]?.def, sig).not.toMatch(/can_access_client\s*\(/);
      expect(src.rows[0]?.def, sig).not.toMatch(/\breview_media_asset\s*\(/);
    }
    for (const sig of ['mcp_internal.approve_idea(text,text,text,uuid,uuid)', 'mcp_internal.approve_asset(text,text,text,uuid,uuid,text,text)']) {
      const src = await db.query<{ def: string }>(`select pg_get_functiondef('${sig}'::regprocedure) as def`);
      expect(src.rows[0]?.def, sig).toContain('bot_forbidden');
    }
    for (const role of ['anon', 'authenticated']) {
      await db.exec(`set role ${role}`);
      await expect(db.query('select mcp_approve_idea($1,$2,$3,$4,$5)',
        ['bot_production', 'r', 'e', CLIENT_A, DRAFT_IDEA_A])).rejects.toThrow('permission denied');
      await expect(db.query('select mcp_approve_asset($1,$2,$3,$4,$5,$6,$7)',
        ['bot_production', 'r', 'e', CLIENT_A, PENDING_ASSET_A, 'approved', null])).rejects.toThrow('permission denied');
      await db.exec('reset role');
    }
    await asService();
  });

  it('approves a draft idea for the granted client and composes with generate_brief; leaves other states alone', async () => {
    const approved = (await approveIdea()).rows[0]!.result;
    expect(approved.idea_status).toBe('approved');
    expect(approved.replayed).toBe(false);
    expect((await db.query<{ status: string }>(
      `select status from client_ideas where id = '${DRAFT_IDEA_A}'`,
    )).rows[0]?.status).toBe('approved');

    const replay = (await approveIdea()).rows[0]!.result;
    expect(replay.replayed).toBe(true);

    // Composes with the existing, unchanged generate_brief RPC.
    const brief = await db.query<{ result: any }>(
      'select enqueue_mcp_brief($1,$2,$3,$4,$5) as result',
      ['bot_production', 'brief-req', 'brief-exec', CLIENT_A, DRAFT_IDEA_A],
    );
    expect(brief.rows[0]?.result.job_id).toBeTruthy();
    expect((await db.query<{ status: string }>(
      `select status from client_ideas where id = '${DRAFT_IDEA_A}'`,
    )).rows[0]?.status).toBe('briefed');

    // Already-briefed idea: idempotent no-op, not an error, under a new execution id.
    const noop = (await approveIdea('bot_production', CLIENT_A, DRAFT_IDEA_A, 'idea-exec-2')).rows[0]!.result;
    expect(noop.idea_status).toBe('briefed');

    // Rejected idea cannot be Bot-approved.
    await db.exec(`update client_ideas set status = 'rejected' where id = '${DRAFT_IDEA_B}'`);
    await expect(approveIdea('bot_production', CLIENT_B, DRAFT_IDEA_B, 'idea-exec-3'))
      .rejects.toThrow('client_forbidden');
    await db.exec(`insert into mcp_bot_clients (bot_id,client_id) values ('bot_production','${CLIENT_B}')`);
    await expect(approveIdea('bot_production', CLIENT_B, DRAFT_IDEA_B, 'idea-exec-4'))
      .rejects.toThrow('invalid_idea_status');
  });

  it('idea approve is client-scoped: forbidden vs mismatch, and a different payload under the same key conflicts', async () => {
    await expect(approveIdea('bot_production', CLIENT_B, DRAFT_IDEA_B)).rejects.toThrow('client_forbidden');
    await expect(approveIdea('bot_production', CLIENT_A, DRAFT_IDEA_B)).rejects.toThrow('client_mismatch');
    await approveIdea();
    await expect(db.query('select mcp_approve_idea($1,$2,$3,$4,$5)',
      ['bot_production', 'idea-req', 'idea-exec', CLIENT_A, DRAFT_IDEA_B])).rejects.toThrow('idempotency_conflict');
  });

  it('decides a pending asset for the granted client, writes one ledger row with Bot attribution, and refuses to redecide', async () => {
    const decided = (await approveAsset()).rows[0]!.result;
    expect(decided.decision).toBe('approved');
    expect(decided.reviewed_by_bot).toBe('bot_production');
    expect((await db.query<{ review_status: string }>(
      `select review_status from client_media_assets where id = '${PENDING_ASSET_A}'`,
    )).rows[0]?.review_status).toBe('approved');
    const review = (await db.query<{ reviewed_by: string | null; reviewed_by_bot: string | null; decision: string }>(
      `select reviewed_by, reviewed_by_bot, decision from client_asset_reviews where asset_id = '${PENDING_ASSET_A}'`,
    )).rows[0]!;
    expect(review.reviewed_by_bot).toBe('bot_production');
    expect(review.reviewed_by).toBeNull();
    expect(review.decision).toBe('approved');
    expect((await db.query<{ n: number }>(
      "select count(*)::int as n from mcp_internal.mcp_content_requests where tool = 'content.approve_asset'",
    )).rows[0]?.n).toBe(1);

    // Replay is idempotent; a second, fresh decision on the now-decided asset is refused.
    const replay = (await approveAsset()).rows[0]!.result;
    expect(replay.replayed).toBe(true);
    await expect(approveAsset({ execution: 'asset-exec-2' })).rejects.toThrow('invalid_asset_status');

    // A decided asset stays out of the Console pending queue, same as a human decision.
    expect((await db.query<{ n: number }>(
      `select count(*)::int as n from approvals_queue where id = '${PENDING_ASSET_A}'`,
    )).rows[0]?.n).toBe(0);
  });

  it('a rejected Bot decision, an unknown asset, and cross-client access are all refused correctly', async () => {
    await expect(approveAsset({ client: CLIENT_A, asset: '00000000-0000-4000-8000-000000000000' }))
      .rejects.toThrow('asset_not_found');
    await expect(approveAsset({ client: CLIENT_B, asset: PENDING_ASSET_B })).rejects.toThrow('client_forbidden');
    await expect(approveAsset({ client: CLIENT_A, asset: PENDING_ASSET_B })).rejects.toThrow('client_mismatch');
    const rejected = (await approveAsset({ decision: 'rejected', execution: 'asset-rej' })).rows[0]!.result;
    expect(rejected.decision).toBe('rejected');
    expect((await db.query<{ review_status: string }>(
      `select review_status from client_media_assets where id = '${PENDING_ASSET_A}'`,
    )).rows[0]?.review_status).toBe('rejected');
    await expect(db.query('select mcp_approve_asset($1,$2,$3,$4,$5,$6,$7)',
      ['bot_production', 'r', 'bad-decision', CLIENT_A, PENDING_ASSET_A, 'maybe', null])).rejects.toThrow('invalid_request');
  });

  it('human Console review can still decide, or override, an asset the Bot already decided', async () => {
    await approveAsset();
    await db.exec(`
      grant execute on function review_media_asset(uuid,review_status,text) to authenticated;
      select set_config('request.jwt.claim.role','authenticated',false);
      select set_config('request.jwt.claim.sub','${USER_A}',false);
      set role authenticated;
    `);
    await db.query('select review_media_asset($1,$2,$3)', [PENDING_ASSET_A, 'rejected', 'Human override']);
    await asService();
    expect((await db.query<{ review_status: string }>(
      `select review_status from client_media_assets where id = '${PENDING_ASSET_A}'`,
    )).rows[0]?.review_status).toBe('rejected');
    const rows = (await db.query<{ reviewed_by: string | null; reviewed_by_bot: string | null }>(
      `select reviewed_by, reviewed_by_bot from client_asset_reviews where asset_id = '${PENDING_ASSET_A}' order by created_at`,
    )).rows;
    expect(rows).toHaveLength(2);
    expect(rows[0]?.reviewed_by_bot).toBe('bot_production');
    expect(rows[1]?.reviewed_by).toBe(USER_A);
  });

  it('a Bot-approved asset is repurposable directly, without going through content.request_approval', async () => {
    await approveAsset();
    const plan = await db.query<{ result: any }>(
      'select mcp_create_repurpose_plan($1,$2,$3,$4,$5,$6) as result',
      ['bot_production', 'rp-r', 'rp-e', CLIENT_A, PENDING_ASSET_A, ['reel']],
    );
    expect(plan.rows[0]?.result.job_id).toBeTruthy();
  });

  it('a Bot-approved asset does not satisfy the Phase 6 human-evidence resume gate', async () => {
    await approveAsset();
    const requested = await db.query<{ result: any }>(
      'select mcp_request_approval($1,$2,$3,$4,$5,$6,$7,$8) as result',
      ['bot_production', 'appr-req', 'appr-exec', CLIENT_A, null, null, PENDING_ASSET_A, null],
    );
    expect(requested.rows[0]?.result.queue).toBe('already_approved');
    await expect(db.query(
      'select mcp_resume_approval($1,$2,$3,$4,$5,$6,$7) as result',
      ['bot_production', 'resume-req', 'resume-exec', CLIENT_A, PENDING_ASSET_A, ['reel'], 'appr-exec'],
    )).rejects.toThrow('approval_required');
  });

  it('bot_forbidden: no Bot other than bot_production can call either RPC, even with an active status and a valid client grant', async () => {
    await expect(approveIdea('bot_marketing', CLIENT_A, DRAFT_IDEA_A)).rejects.toThrow('bot_forbidden');
    await expect(approveAsset({ bot: 'bot_marketing' })).rejects.toThrow('bot_forbidden');
    await expect(approveIdea('bot_finance', CLIENT_A, DRAFT_IDEA_A)).rejects.toThrow('client_forbidden');
  });

  it('suspended bot is bot_not_active before the bot_forbidden check would otherwise fire, even with a remaining grant', async () => {
    await db.query('select mcp_issue_bot_token($1,$2,$3,$4)', ['bot_production', HASH, 'operator', 'test']);
    await db.query('select mcp_suspend_bot($1,$2,$3)', ['bot_production', 'operator', 'lock']);
    await expect(approveIdea()).rejects.toThrow('bot_not_active');
    await expect(approveAsset()).rejects.toThrow('bot_not_active');
  });

  it('revoked grant denies replay before lookup', async () => {
    await approveIdea();
    await db.exec(`delete from mcp_bot_clients where bot_id = 'bot_production' and client_id = '${CLIENT_A}'`);
    await expect(approveIdea('bot_production', CLIENT_A, DRAFT_IDEA_A, 'idea-exec-revoked')).rejects.toThrow('client_forbidden');
    await expect(approveAsset({ execution: 'asset-exec-revoked' })).rejects.toThrow('client_forbidden');
  });

  it('permission grants no exact-name row for either tool outside bot_production, and bot_production retains content.*', async () => {
    const rows = (await db.query<{ n: number }>(
      `select count(*)::int as n from mcp_internal.mcp_bot_permissions
        where permission_pattern in ('content.select_idea', 'content.approve_asset') and bot_id <> 'bot_production'`,
    )).rows;
    expect(rows[0]?.n).toBe(0);
    const wildcard = (await db.query<{ n: number }>(
      "select count(*)::int as n from mcp_internal.mcp_bot_permissions where bot_id = 'bot_production' and permission_pattern = 'content.*'",
    )).rows;
    expect(wildcard[0]?.n).toBe(1);
  });
});

describe('Phase 10 Distribution Manager isolation', () => {
  const APPROVED_ASSET_A = '99999995-9999-4999-8999-999999999995';
  const APPROVED_ASSET_B = '99999996-9999-4999-8999-999999999996';
  const PENDING_ASSET_A = '99999997-9999-4999-8999-999999999997';

  const queue = (
    overrides: Partial<{
      bot: string; client: string; asset: string; scheduled_for: string; channel: string; execution: string;
    }> = {},
  ) => db.query<{ result: any }>(
    'select mcp_queue_distribution($1,$2,$3,$4,$5,$6,$7) as result',
    [
      overrides.bot ?? 'bot_distribution', 'sched-req', overrides.execution ?? 'sched-exec',
      overrides.client ?? CLIENT_A, overrides.asset ?? APPROVED_ASSET_A,
      overrides.scheduled_for ?? '2026-12-01', overrides.channel ?? 'organic',
    ],
  );
  const record = (
    overrides: Partial<{
      bot: string; client: string; schedule: string; status: string; execution: string;
      external_id: string | null; failure_reason: string | null;
    }> = {},
  ) => db.query<{ result: any }>(
    'select mcp_record_publication($1,$2,$3,$4,$5,$6,$7,$8) as result',
    [
      overrides.bot ?? 'bot_distribution', 'pub-req', overrides.execution ?? 'pub-exec',
      overrides.client ?? CLIENT_A, overrides.schedule,
      overrides.status ?? 'published', overrides.external_id ?? null, overrides.failure_reason ?? null,
    ],
  );

  beforeEach(async () => {
    await db.exec(`
      insert into client_media_assets (id,client_id,media_type,title,storage_path,review_status) values
        ('${APPROVED_ASSET_A}','${CLIENT_A}','image','Approved A','path/aa.png','approved'),
        ('${APPROVED_ASSET_B}','${CLIENT_B}','image','Approved B','path/ab.png','approved'),
        ('${PENDING_ASSET_A}','${CLIENT_A}','image','Pending A','path/pa.png','pending');
      insert into mcp_bot_clients (bot_id, client_id) values ('bot_distribution', '${CLIENT_A}');
    `);
  });

  it('every new RPC uses require_active_bot + require_bot_client_grant, never can_access_client/schedule_asset, and hard-codes bot_distribution', async () => {
    const internalSignatures = [
      'mcp_internal.queue_distribution(text,text,text,uuid,uuid,date,text)',
      'mcp_internal.record_publication(text,text,text,uuid,uuid,text,text,text)',
    ];
    const publicSignatures = [
      'public.mcp_queue_distribution(text,text,text,uuid,uuid,date,text)',
      'public.mcp_record_publication(text,text,text,uuid,uuid,text,text,text)',
    ];
    for (const sig of internalSignatures) {
      const src = await db.query<{ def: string }>(
        `select pg_get_functiondef('${sig}'::regprocedure) as def`,
      );
      expect(src.rows[0]?.def, sig).toContain('require_active_bot');
      expect(src.rows[0]?.def, sig).toContain('require_bot_client_grant');
      expect(src.rows[0]?.def, sig).toContain('bot_forbidden');
      expect(src.rows[0]?.def, sig).not.toMatch(/can_access_client\s*\(/);
      expect(src.rows[0]?.def, sig).not.toMatch(/\bschedule_asset\s*\(/);
    }
    for (const sig of publicSignatures) {
      const src = await db.query<{ def: string }>(`select pg_get_functiondef('${sig}'::regprocedure) as def`);
      expect(src.rows[0]?.def, sig).not.toMatch(/can_access_client\s*\(/);
      expect(src.rows[0]?.def, sig).not.toMatch(/\bschedule_asset\s*\(/);
    }
    for (const role of ['anon', 'authenticated']) {
      await db.exec(`set role ${role}`);
      await expect(db.query('select mcp_queue_distribution($1,$2,$3,$4,$5,$6,$7)',
        ['bot_distribution', 'r', 'e', CLIENT_A, APPROVED_ASSET_A, '2026-12-01', 'organic'])).rejects.toThrow('permission denied');
      await expect(db.query('select mcp_record_publication($1,$2,$3,$4,$5,$6,$7,$8)',
        ['bot_distribution', 'r', 'e', CLIENT_A, '00000000-0000-4000-8000-000000000000', 'published', null, null])).rejects.toThrow('permission denied');
      await db.exec('reset role');
    }
    await asService();
  });

  it('schedules an approved asset for the granted client, writes one ledger row, and replays idempotently', async () => {
    const scheduled = (await queue()).rows[0]!.result;
    expect(scheduled.publication_status).toBe('scheduled');
    expect(scheduled.created_by_bot).toBe('bot_distribution');
    expect(scheduled.replayed).toBe(false);
    const row = (await db.query<{ publication_status: string; created_by_bot: string; created_by: string | null }>(
      `select publication_status, created_by_bot, created_by from scheduled_posts where id = '${scheduled.schedule_id}'`,
    )).rows[0]!;
    expect(row.publication_status).toBe('scheduled');
    expect(row.created_by_bot).toBe('bot_distribution');
    expect(row.created_by).toBeNull();
    expect((await db.query<{ n: number }>(
      "select count(*)::int as n from mcp_internal.mcp_content_requests where tool = 'content.queue_distribution'",
    )).rows[0]?.n).toBe(1);

    const replay = (await queue()).rows[0]!.result;
    expect(replay.replayed).toBe(true);
    await expect(db.query('select mcp_queue_distribution($1,$2,$3,$4,$5,$6,$7)',
      ['bot_distribution', 'sched-req', 'sched-exec', CLIENT_A, APPROVED_ASSET_A, '2026-12-31', 'organic']))
      .rejects.toThrow('idempotency_conflict');
  });

  it('schedule is client-scoped and only ever accepts an approved asset', async () => {
    await expect(queue({ client: CLIENT_B, asset: APPROVED_ASSET_B })).rejects.toThrow('client_forbidden');
    await expect(queue({ asset: APPROVED_ASSET_B })).rejects.toThrow('client_mismatch');
    await expect(queue({ asset: PENDING_ASSET_A, execution: 'sched-pending' })).rejects.toThrow('invalid_asset_status');
    await expect(queue({ asset: '00000000-0000-4000-8000-000000000000', execution: 'sched-unknown' }))
      .rejects.toThrow('asset_not_found');
    await expect(queue({ channel: 'tiktok', execution: 'sched-bad-channel' })).rejects.toThrow('invalid_request');
  });

  it('records publication for the granted client, writes one ledger row, and refuses to redecide', async () => {
    const scheduled = (await queue()).rows[0]!.result;
    const published = (await record({ schedule: scheduled.schedule_id, status: 'published', external_id: 'meta-1' })).rows[0]!.result;
    expect(published.publication_status).toBe('published');
    expect(published.published_by_bot).toBe('bot_distribution');
    const row = (await db.query<{ publication_status: string; external_id: string; published_by_bot: string; published_at: string | null }>(
      `select publication_status, external_id, published_by_bot, published_at from scheduled_posts where id = '${scheduled.schedule_id}'`,
    )).rows[0]!;
    expect(row.publication_status).toBe('published');
    expect(row.external_id).toBe('meta-1');
    expect(row.published_by_bot).toBe('bot_distribution');
    expect(row.published_at).not.toBeNull();
    expect((await db.query<{ n: number }>(
      "select count(*)::int as n from mcp_internal.mcp_content_requests where tool = 'content.record_publication'",
    )).rows[0]?.n).toBe(1);

    const replay = (await record({ schedule: scheduled.schedule_id, status: 'published', external_id: 'meta-1' })).rows[0]!.result;
    expect(replay.replayed).toBe(true);
    await expect(record({ schedule: scheduled.schedule_id, status: 'failed', execution: 'pub-redecide' }))
      .rejects.toThrow('invalid_schedule_status');
  });

  it('publication record is client-scoped and refuses an unknown or malformed status', async () => {
    const scheduled = (await queue()).rows[0]!.result;
    // bot_distribution has no grant for CLIENT_B; insert its schedule row
    // directly (not via the RPC) purely as a cross-client resource fixture.
    const OTHER_SCHEDULE = '99999998-9999-4999-8999-999999999998';
    await db.exec(
      `insert into scheduled_posts (id, asset_id, scheduled_for, channel, created_by_bot)
         values ('${OTHER_SCHEDULE}', '${APPROVED_ASSET_B}', '2026-12-01', 'organic', 'bot_distribution')`,
    );
    await expect(record({ client: CLIENT_B, schedule: scheduled.schedule_id })).rejects.toThrow('client_forbidden');
    await expect(record({ schedule: OTHER_SCHEDULE, execution: 'pub-mismatch' })).rejects.toThrow('client_mismatch');
    await expect(record({ schedule: '00000000-0000-4000-8000-000000000000', execution: 'pub-unknown' }))
      .rejects.toThrow('schedule_not_found');
    await expect(record({ schedule: scheduled.schedule_id, status: 'maybe', execution: 'pub-bad-status' }))
      .rejects.toThrow('invalid_request');
  });

  it('get_production_status distribution field reflects the schedule/publication lifecycle without disturbing Phase 6 approvals', async () => {
    const scheduled = (await queue()).rows[0]!.result;
    const before = (await db.query<{ result: any }>(
      'select mcp_get_production_status($1,$2,$3,$4,$5) as result',
      ['bot_distribution', CLIENT_A, null, null, APPROVED_ASSET_A],
    )).rows[0]!.result;
    expect(before.distribution).toHaveLength(1);
    expect(before.distribution[0]).toMatchObject({ id: scheduled.schedule_id, publication_status: 'scheduled' });
    expect(before.approvals).toEqual([]);

    await record({ schedule: scheduled.schedule_id, status: 'published' });
    const after = (await db.query<{ result: any }>(
      'select mcp_get_production_status($1,$2,$3,$4,$5) as result',
      ['bot_distribution', CLIENT_A, null, null, APPROVED_ASSET_A],
    )).rows[0]!.result;
    expect(after.distribution[0]).toMatchObject({ id: scheduled.schedule_id, publication_status: 'published' });
  });

  it('bot_forbidden: no Bot other than bot_distribution can call either RPC, even with an active status and a valid client grant', async () => {
    await db.exec(`insert into mcp_bot_clients (bot_id,client_id) values ('bot_production','${CLIENT_A}') on conflict do nothing;`);
    await expect(queue({ bot: 'bot_production' })).rejects.toThrow('bot_forbidden');
    const scheduled = (await queue()).rows[0]!.result;
    await expect(record({ bot: 'bot_production', schedule: scheduled.schedule_id, execution: 'pub-prod-denied' }))
      .rejects.toThrow('bot_forbidden');
    await expect(queue({ bot: 'bot_finance', execution: 'sched-finance' })).rejects.toThrow('client_forbidden');
  });

  it('suspended bot is bot_not_active before the bot_forbidden check would otherwise fire, even with a remaining grant', async () => {
    await db.query('select mcp_issue_bot_token($1,$2,$3,$4)', ['bot_distribution', HASH, 'operator', 'test']);
    await db.query('select mcp_suspend_bot($1,$2,$3)', ['bot_distribution', 'operator', 'lock']);
    await expect(queue()).rejects.toThrow('bot_not_active');
  });

  it('revoked grant denies replay before lookup', async () => {
    const scheduled = (await queue()).rows[0]!.result;
    await db.exec(`delete from mcp_bot_clients where bot_id = 'bot_distribution' and client_id = '${CLIENT_A}'`);
    await expect(queue({ execution: 'sched-revoked' })).rejects.toThrow('client_forbidden');
    await expect(record({ schedule: scheduled.schedule_id, execution: 'pub-revoked' })).rejects.toThrow('client_forbidden');
  });

  it('permission grants no exact-name row for either tool outside bot_distribution, and bot_distribution retains both', async () => {
    const rows = (await db.query<{ n: number }>(
      `select count(*)::int as n from mcp_internal.mcp_bot_permissions
        where permission_pattern in ('content.queue_distribution', 'content.record_publication') and bot_id <> 'bot_distribution'`,
    )).rows;
    expect(rows[0]?.n).toBe(0);
    const granted = (await db.query<{ n: number }>(
      `select count(*)::int as n from mcp_internal.mcp_bot_permissions
        where bot_id = 'bot_distribution' and permission_pattern in ('content.queue_distribution', 'content.record_publication')`,
    )).rows;
    expect(granted[0]?.n).toBe(2);
  });
});

describe('Phase 11 Sales Ops isolation', () => {
  const LEAD_A = '9999a001-9999-4999-8999-999999999901';
  const LEAD_B = '9999a002-9999-4999-8999-999999999902';
  const AGENT_A = '9999a003-9999-4999-8999-999999999903';

  const stage = (
    overrides: Partial<{
      bot: string; client: string; lead: string; stage: string; note: string | null; execution: string;
    }> = {},
  ) => db.query<{ result: any }>(
    'select mcp_update_lead_stage($1,$2,$3,$4,$5,$6,$7) as result',
    [
      overrides.bot ?? 'bot_sales_ops', 'stage-req', overrides.execution ?? 'stage-exec',
      overrides.client ?? CLIENT_A, overrides.lead ?? LEAD_A,
      overrides.stage ?? 'conversation', overrides.note ?? null,
    ],
  );
  const followup = (
    overrides: Partial<{
      bot: string; client: string; lead: string; next_action: string; next_action_due: string | null; execution: string;
    }> = {},
  ) => db.query<{ result: any }>(
    'select mcp_create_followup($1,$2,$3,$4,$5,$6,$7) as result',
    [
      overrides.bot ?? 'bot_sales_ops', 'fu-req', overrides.execution ?? 'fu-exec',
      overrides.client ?? CLIENT_A, overrides.lead ?? LEAD_A,
      overrides.next_action ?? 'Call back Thursday', overrides.next_action_due ?? null,
    ],
  );

  beforeEach(async () => {
    await db.exec(`
      insert into client_leads (id, client_id, name, email, stage) values
        ('${LEAD_A}', '${CLIENT_A}', 'Alpha Lead', 'a@example.com', 'lead'),
        ('${LEAD_B}', '${CLIENT_B}', 'Beta Lead', 'b@example.com', 'lead');
      insert into client_sales_agents (id, client_id, name, purpose, status) values
        ('${AGENT_A}', '${CLIENT_A}', 'Closer', 'Qualify and book', 'live');
      insert into mcp_bot_clients (bot_id, client_id) values ('bot_sales_ops', '${CLIENT_A}');
    `);
  });

  it('every new RPC uses require_active_bot + require_bot_client_grant, never can_access_client, and hard-codes bot_sales_ops on the two writes', async () => {
    const internalSignatures = [
      'mcp_internal.list_leads(text,uuid,integer,text)',
      'mcp_internal.get_lead(text,uuid,uuid)',
      'mcp_internal.get_stalled_leads(text,uuid,integer,integer)',
      'mcp_internal.get_pipeline_summary(text,uuid)',
      'mcp_internal.list_sales_agents(text,uuid,integer)',
      'mcp_internal.get_sales_agent(text,uuid,uuid)',
      'mcp_internal.get_sales_agent_conversations(text,uuid,uuid,integer)',
      'mcp_internal.update_lead_stage(text,text,text,uuid,uuid,text,text)',
      'mcp_internal.create_followup(text,text,text,uuid,uuid,text,date)',
    ];
    for (const sig of internalSignatures) {
      const src = await db.query<{ def: string }>(`select pg_get_functiondef('${sig}'::regprocedure) as def`);
      expect(src.rows[0]?.def, sig).toContain('require_active_bot');
      expect(src.rows[0]?.def, sig).toContain('require_bot_client_grant');
      expect(src.rows[0]?.def, sig).not.toMatch(/can_access_client\s*\(/);
    }
    for (const sig of [
      'mcp_internal.update_lead_stage(text,text,text,uuid,uuid,text,text)',
      'mcp_internal.create_followup(text,text,text,uuid,uuid,text,date)',
    ]) {
      const src = await db.query<{ def: string }>(`select pg_get_functiondef('${sig}'::regprocedure) as def`);
      expect(src.rows[0]?.def, sig).toContain('bot_forbidden');
    }
    for (const role of ['anon', 'authenticated']) {
      await db.exec(`set role ${role}`);
      await expect(db.query('select mcp_list_leads($1,$2,$3,$4)', ['bot_sales_ops', CLIENT_A, 25, null]))
        .rejects.toThrow('permission denied');
      await expect(db.query('select mcp_update_lead_stage($1,$2,$3,$4,$5,$6,$7)',
        ['bot_sales_ops', 'r', 'e', CLIENT_A, LEAD_A, 'conversation', null])).rejects.toThrow('permission denied');
      await expect(db.query('select mcp_create_followup($1,$2,$3,$4,$5,$6,$7)',
        ['bot_sales_ops', 'r', 'e', CLIENT_A, LEAD_A, 'x', null])).rejects.toThrow('permission denied');
      await db.exec('reset role');
    }
    await asService();
  });

  it('reads are client-scoped: same-client succeeds, cross-client id is client_forbidden, cross-client resource is client_mismatch', async () => {
    const leads = (await db.query<{ result: any }>(
      'select mcp_list_leads($1,$2,$3,$4) as result', ['bot_sales_ops', CLIENT_A, 25, null],
    )).rows[0]!.result;
    expect(leads.leads.some((l: any) => l.id === LEAD_A)).toBe(true);
    expect(leads.leads.some((l: any) => l.id === LEAD_B)).toBe(false);

    await expect(db.query('select mcp_list_leads($1,$2,$3,$4)', ['bot_sales_ops', CLIENT_B, 25, null]))
      .rejects.toThrow('client_forbidden');
    await expect(db.query('select mcp_get_lead($1,$2,$3)', ['bot_sales_ops', CLIENT_A, LEAD_B]))
      .rejects.toThrow('client_mismatch');
    await expect(db.query('select mcp_get_sales_agent($1,$2,$3)', ['bot_sales_ops', CLIENT_B, AGENT_A]))
      .rejects.toThrow('client_forbidden');

    const summary = (await db.query<{ result: any }>(
      'select mcp_get_pipeline_summary($1,$2) as result', ['bot_sales_ops', CLIENT_A],
    )).rows[0]!.result;
    expect(summary.total_leads).toBeGreaterThanOrEqual(1);

    const agents = (await db.query<{ result: any }>(
      'select mcp_list_sales_agents($1,$2,$3) as result', ['bot_sales_ops', CLIENT_A, 25],
    )).rows[0]!.result;
    expect(agents.sales_agents.some((a: any) => a.id === AGENT_A)).toBe(true);
  });

  it('update_lead_stage moves the lead, writes one Bot-attributed timeline event, records one ledger row, and replays idempotently', async () => {
    const moved = (await stage()).rows[0]!.result;
    expect(moved.stage).toBe('conversation');
    expect(moved.from_stage).toBe('lead');
    expect(moved.replayed).toBe(false);
    const row = (await db.query<{ stage: string }>(
      `select stage from client_leads where id = '${LEAD_A}'`,
    )).rows[0]!;
    expect(row.stage).toBe('conversation');
    const event = (await db.query<{ kind: string; created_by_bot: string | null; created_by: string | null; to_stage: string }>(
      `select kind, created_by_bot, created_by, to_stage from lead_events where lead_id = '${LEAD_A}' order by occurred_at desc limit 1`,
    )).rows[0]!;
    expect(event.kind).toBe('stage_change');
    expect(event.created_by_bot).toBe('bot_sales_ops');
    expect(event.created_by).toBeNull();
    expect(event.to_stage).toBe('conversation');
    expect((await db.query<{ n: number }>(
      "select count(*)::int as n from mcp_internal.mcp_pipeline_requests where tool = 'pipeline.update_stage'",
    )).rows[0]?.n).toBe(1);

    const replay = (await stage()).rows[0]!.result;
    expect(replay.replayed).toBe(true);
    await expect(stage({ stage: 'appointment', execution: 'stage-exec' })).rejects.toThrow('idempotency_conflict');
  });

  it('update_lead_stage refuses sale/cash target stages, requires a reason to move to lost, and is client-scoped', async () => {
    await expect(stage({ stage: 'sale', execution: 's1' })).rejects.toThrow('invalid_stage');
    await expect(stage({ stage: 'cash', execution: 's2' })).rejects.toThrow('invalid_stage');
    await expect(stage({ stage: 'lost', note: null, execution: 's3' })).rejects.toThrow('lost_reason_required');
    const lost = (await stage({ stage: 'lost', note: 'Went with a competitor', execution: 's4' })).rows[0]!.result;
    expect(lost.stage).toBe('lost');
    await expect(stage({ client: CLIENT_B, lead: LEAD_B, execution: 's5' })).rejects.toThrow('client_forbidden');
    await expect(stage({ lead: LEAD_B, execution: 's6' })).rejects.toThrow('client_mismatch');
    await expect(stage({ lead: '00000000-0000-4000-8000-000000000000', execution: 's7' })).rejects.toThrow('lead_not_found');
  });

  it('create_followup writes next_action, a followup timeline event, one ledger row, and replays idempotently', async () => {
    const written = (await followup()).rows[0]!.result;
    expect(written.next_action).toBe('Call back Thursday');
    expect(written.replayed).toBe(false);
    const row = (await db.query<{ next_action: string }>(
      `select next_action from client_leads where id = '${LEAD_A}'`,
    )).rows[0]!;
    expect(row.next_action).toBe('Call back Thursday');
    const event = (await db.query<{ kind: string; created_by_bot: string | null }>(
      `select kind, created_by_bot from lead_events where lead_id = '${LEAD_A}' order by occurred_at desc limit 1`,
    )).rows[0]!;
    expect(event.kind).toBe('followup');
    expect(event.created_by_bot).toBe('bot_sales_ops');
    expect((await db.query<{ n: number }>(
      "select count(*)::int as n from mcp_internal.mcp_pipeline_requests where tool = 'pipeline.create_followup'",
    )).rows[0]?.n).toBe(1);

    const replay = (await followup()).rows[0]!.result;
    expect(replay.replayed).toBe(true);
    await expect(followup({ next_action: 'Something else', execution: 'fu-exec' })).rejects.toThrow('idempotency_conflict');
    await expect(followup({ client: CLIENT_B, lead: LEAD_B, execution: 'fu-cross' })).rejects.toThrow('client_forbidden');
    await expect(followup({ lead: LEAD_B, execution: 'fu-mismatch' })).rejects.toThrow('client_mismatch');
  });

  it('bot_forbidden: no Bot other than bot_sales_ops can call either write RPC, even with an active status and a valid client grant', async () => {
    await db.exec(`insert into mcp_bot_clients (bot_id,client_id) values ('bot_production','${CLIENT_A}') on conflict do nothing;`);
    await expect(stage({ bot: 'bot_production', execution: 'prod-denied' })).rejects.toThrow('bot_forbidden');
    await expect(followup({ bot: 'bot_production', execution: 'prod-denied-fu' })).rejects.toThrow('bot_forbidden');
    await expect(stage({ bot: 'bot_finance', execution: 'finance-denied' })).rejects.toThrow('client_forbidden');
  });

  it('suspended bot is bot_not_active even with a remaining grant', async () => {
    await db.query('select mcp_issue_bot_token($1,$2,$3,$4)', ['bot_sales_ops', HASH, 'operator', 'test']);
    await db.query('select mcp_suspend_bot($1,$2,$3)', ['bot_sales_ops', 'operator', 'lock']);
    await expect(stage()).rejects.toThrow('bot_not_active');
    await expect(db.query('select mcp_list_leads($1,$2,$3,$4)', ['bot_sales_ops', CLIENT_A, 25, null]))
      .rejects.toThrow('bot_not_active');
  });

  it('revoked grant denies replay before lookup', async () => {
    await stage();
    await db.exec(`delete from mcp_bot_clients where bot_id = 'bot_sales_ops' and client_id = '${CLIENT_A}'`);
    await expect(stage({ execution: 'stage-revoked' })).rejects.toThrow('client_forbidden');
    await expect(followup({ execution: 'fu-revoked' })).rejects.toThrow('client_forbidden');
    await expect(db.query('select mcp_list_leads($1,$2,$3,$4)', ['bot_sales_ops', CLIENT_A, 25, null]))
      .rejects.toThrow('client_forbidden');
  });

  it('permission grants no exact-name row for either write tool outside bot_sales_ops, and the wildcard/proof.* rows are gone', async () => {
    const other = (await db.query<{ n: number }>(
      `select count(*)::int as n from mcp_internal.mcp_bot_permissions
        where permission_pattern in ('pipeline.update_stage', 'pipeline.create_followup') and bot_id <> 'bot_sales_ops'`,
    )).rows;
    expect(other[0]?.n).toBe(0);
    const exact = (await db.query<{ n: number }>(
      `select count(*)::int as n from mcp_internal.mcp_bot_permissions
        where bot_id = 'bot_sales_ops'`,
    )).rows;
    expect(exact[0]?.n).toBe(17);
    const wildcardsOrProof = (await db.query<{ n: number }>(
      `select count(*)::int as n from mcp_internal.mcp_bot_permissions
        where bot_id = 'bot_sales_ops'
          and permission_pattern in ('pipeline.*', 'sales_agents.*', 'proof.search', 'proof.get')`,
    )).rows;
    expect(wildcardsOrProof[0]?.n).toBe(0);
    const elsewhere = (await db.query<{ n: number }>(
      `select count(*)::int as n from mcp_internal.mcp_bot_permissions
        where bot_id <> 'bot_sales_ops'
          and (permission_pattern like 'pipeline.%' or permission_pattern like 'sales_agents.%')`,
    )).rows;
    expect(elsewhere[0]?.n).toBe(0);
    // Ongoing guard, not just this migration: a future stray wildcard row must
    // still be rejected by the ordinary insert/update/delete trigger.
    await expect(db.exec(
      `insert into mcp_internal.mcp_bot_permissions (bot_id, permission_pattern, granted_by)
       values ('bot_production', 'pipeline.list_leads', 'test')`,
    )).rejects.toThrow(/Phase 11: pipeline/);
  });
});

describe('Phase 12 Admin isolation and ledger', () => {
 const create = async (client=CLIENT_A,execution='admin-create',bot='bot_admin',title='Meeting') => {
   const q=await db.query<{result:any}>(`select public.mcp_admin_create_event($1,$2,'request-12',$3,'meeting',$4,null,'2026-10-01T10:00:00Z','2026-10-01T11:00:00Z') result`,[bot,client,execution,title]);
   return q.rows[0]!.result;
 };
 const change=async(id:string,execution='admin-update',client=CLIENT_A,version=1)=>{
   const q=await db.query<{result:any}>(`select public.mcp_admin_update_event('bot_admin',$1,'request-update',$2,$3,$4,'completed','Meeting',null,'2026-10-01T10:00:00Z','2026-10-01T11:00:00Z') result`,[client,execution,id,version]);return q.rows[0]!.result;
 };
 beforeEach(async()=>{await db.exec(`insert into mcp_bot_clients(bot_id,client_id) values('bot_admin','${CLIENT_A}')`);});
 it('creates and replays exactly once, including update after terminal state',async()=>{
  const first=await create();expect((await create()).event).toEqual(first.event);
  const updated=await change(first.event.id);expect(updated.event.version).toBe(2);
  expect((await change(first.event.id)).event).toEqual(updated.event);
  expect((await db.query('select * from mcp_internal.mcp_admin_events')).rows).toHaveLength(1);
  expect((await db.query('select * from mcp_internal.mcp_admin_requests')).rows).toHaveLength(2);
 });
 it('different client, action or payload cannot reuse execution',async()=>{
  const first=await create();
  await db.exec(`insert into mcp_bot_clients(bot_id,client_id) values('bot_admin','${CLIENT_B}')`);
  await expect(create(CLIENT_B)).rejects.toThrow('idempotency_conflict');
  await expect(create(CLIENT_A,'admin-create','bot_admin','Different')).rejects.toThrow('idempotency_conflict');
  await expect(change(first.event.id,'admin-create')).rejects.toThrow('idempotency_conflict');
 });
 it('all RPCs deny ungranted client, invalid client and suspended bot',async()=>{
  const first=await create();
  for(const client of [CLIENT_B,'99999999-9999-4999-8999-999999999999']){
   await expect(create(client)).rejects.toThrow('client_forbidden');
   await expect(change(first.event.id,'foreign',client)).rejects.toThrow('client_forbidden');
   await expect(db.query(`select mcp_admin_list_events('bot_admin',$1)`,[client])).rejects.toThrow('client_forbidden');
   await expect(db.query(`select mcp_admin_get_event('bot_admin',$1,$2)`,[client,first.event.id])).rejects.toThrow('client_forbidden');
  }
  await db.exec(`update mcp_internal.mcp_bots set status='suspended' where bot_id='bot_admin'`);
  await expect(create()).rejects.toThrow('bot_not_active');
  await expect(change(first.event.id)).rejects.toThrow('bot_not_active');
  await expect(db.query(`select mcp_admin_list_events('bot_admin',$1)`,[CLIENT_A])).rejects.toThrow('bot_not_active');
  await expect(db.query(`select mcp_admin_get_event('bot_admin',$1,$2)`,[CLIENT_A,first.event.id])).rejects.toThrow('bot_not_active');
 });
 it('revoked client grant denies saved create and update replay',async()=>{
  const first=await create();await change(first.event.id);
  await db.exec(`delete from mcp_bot_clients where bot_id='bot_admin'`);
  await expect(create()).rejects.toThrow('client_forbidden');
  await expect(change(first.event.id)).rejects.toThrow('client_forbidden');
 });
 it('removed exact permission denies replay even with admin wildcard',async()=>{
  await create();
  await db.exec('begin');
  try {
   await db.exec(`delete from mcp_internal.mcp_bot_permissions where bot_id='bot_admin' and permission_pattern='admin.create_event'; insert into mcp_internal.mcp_bot_permissions(bot_id,permission_pattern,granted_by) values('bot_admin','admin.*','test')`);
   await expect(create()).rejects.toThrow('bot_forbidden');
  } finally {await db.exec('rollback');}
 });
 it('other active bot with grant cannot call Admin even with explicit permissions',async()=>{
  await db.exec('begin');
  try {
   await db.exec(`insert into mcp_internal.mcp_bot_permissions(bot_id,permission_pattern,granted_by) values('bot_production','admin.create_event','test')`);
   await expect(create(CLIENT_A,'foreign-bot','bot_production')).rejects.toThrow('bot_forbidden');
  } finally {await db.exec('rollback');}
 });
 it('foreign event ID and missing ID return the same denial; cursor cannot cross clients',async()=>{
  const first=await create();
  await db.exec(`insert into mcp_bot_clients(bot_id,client_id) values('bot_admin','${CLIENT_B}')`);
  for(const id of [first.event.id,IDEA_B]){
   await expect(db.query(`select mcp_admin_get_event('bot_admin',$1,$2)`,[CLIENT_B,id])).rejects.toThrow('event_not_found');
   await expect(change(id,'foreign-resource',CLIENT_B)).rejects.toThrow('event_not_found');
   await expect(db.query(`select mcp_admin_list_events('bot_admin',$1,25,$2)`,[CLIENT_B,id])).rejects.toThrow('event_not_found');
  }
 });
 for(const role of ['anon','authenticated']) it(`${role} cannot execute public or internal Admin RPCs`,async()=>{
  const first=await create();
  await db.exec(`set role ${role}; select set_config('request.jwt.claim.role','${role}',false)`);
  for(const prefix of ['public.mcp_','mcp_internal.']) {
   await expect(db.query(`select ${prefix}admin_list_events('bot_admin',$1)`,[CLIENT_A])).rejects.toThrow(/permission denied/);
   await expect(db.query(`select ${prefix}admin_get_event('bot_admin',$1,$2)`,[CLIENT_A,first.event.id])).rejects.toThrow(/permission denied/);
   await expect(db.query(`select ${prefix}admin_create_event('bot_admin',$1,'req','exec','reminder','Title',null,now(),null)`,[CLIENT_A])).rejects.toThrow(/permission denied/);
   await expect(db.query(`select ${prefix}admin_update_event('bot_admin',$1,'req','exec',$2,1,'cancelled','Title',null,now(),null)`,[CLIENT_A,first.event.id])).rejects.toThrow(/permission denied/);
  }
 });
 for(const role of ['anon','authenticated','service_role']) it(`${role} has no direct Admin table access`,async()=>{
  await db.exec(`set role ${role}`);
  for(const table of ['mcp_admin_events','mcp_admin_requests']){
   await expect(db.query(`select * from mcp_internal.${table}`)).rejects.toThrow(/permission denied/);
   await expect(db.query(`delete from mcp_internal.${table}`)).rejects.toThrow(/permission denied/);
  }
 });
 it('RLS is enabled and forced; exact Admin grants are 15',async()=>{
  const tables=await db.query<{relrowsecurity:boolean;relforcerowsecurity:boolean}>(`select relrowsecurity,relforcerowsecurity from pg_class where relname in ('mcp_admin_events','mcp_admin_requests')`);
  expect(tables.rows).toHaveLength(2);expect(tables.rows.every(x=>x.relrowsecurity&&x.relforcerowsecurity)).toBe(true);
  const grants=await db.query<{permission_pattern:string}>(`select permission_pattern from mcp_internal.mcp_bot_permissions where bot_id='bot_admin'`);
  expect(grants.rows).toHaveLength(15);expect(grants.rows.some(x=>x.permission_pattern.includes('*'))).toBe(false);
 });
 it('service role can execute guarded wrappers, not internal functions',async()=>{
  await db.exec(`set role service_role`);
  expect((await create()).event.created_by_bot).toBe('bot_admin');
  await expect(db.query(`select mcp_internal.admin_list_events('bot_admin',$1)`,[CLIENT_A])).rejects.toThrow(/permission denied/);
 });
 it('SQL rejects invalid temporal structure/status regardless of route validation',async()=>{
  for(const [kind,start,end] of [['meeting','2026-10-01',null],['reminder','infinity',null],['admin','2026-10-02','2026-10-01'],['external','2026-10-01',null]]){
   await expect(db.query(`select mcp_admin_create_event('bot_admin',$1,'req','exec',$2,'Title',null,$3,$4)`,[CLIENT_A,kind,start,end])).rejects.toThrow('invalid_request');
  }
  const first=await create();
  await expect(db.query(`select mcp_admin_update_event('bot_admin',$1,'req','exec',$2,1,'published','Title',null,now(),now()+interval '1 hour')`,[CLIENT_A,first.event.id])).rejects.toThrow('invalid_request');
 });
 it('Admin workflow assignment denies ungranted assignee before mutation and replay',async()=>{
  const task=await db.query<{result:any}>(`select mcp_workflow_task('bot_admin',$1,'create_task',p_title:='Admin fixture',p_request_id:='request',p_execution_id:='task-create') result`,[CLIENT_A]);
  const id=task.rows[0]!.result.task.id;
  const assign=()=>db.query(`select mcp_workflow_task('bot_admin',$1,'assign_task',p_task_id:=$2,p_assignee:='bot_client_delivery',p_request_id:='request',p_execution_id:='task-assign')`,[CLIENT_A,id]);
  await expect(assign()).rejects.toThrow('client_forbidden');
  await db.exec(`insert into mcp_bot_clients(bot_id,client_id) values('bot_client_delivery','${CLIENT_A}')`);
  await assign();await assign();
  await db.exec(`delete from mcp_bot_clients where bot_id='bot_client_delivery'`);
  await expect(assign()).rejects.toThrow('client_forbidden');
 });
 it('Admin token resolver reports revoked credentials without affecting other bots',async()=>{
  await db.query('select mcp_issue_bot_token($1,$2,$3,$4)',['bot_admin',HASH,'local-test','fixture']);
  expect((await db.query<{result:any}>('select mcp_resolve_bot_token($1) result',[HASH])).rows[0]!.result.status).toBe('active');
  await db.query('select mcp_revoke_bot_token($1,$2,$3)',[HASH,'local-test','fixture']);
  expect((await db.query<{result:any}>('select mcp_resolve_bot_token($1) result',[HASH])).rows[0]!.result.status).toBe('revoked_token');
  expect((await db.query<{status:string}>("select status from mcp_internal.mcp_bots where bot_id='bot_production'")).rows[0]!.status).toBe('active');
 });
 it('concurrently submitted identical requests create one record; receipt survives timezone changes',async()=>{
  const results=await Promise.all(Array.from({length:5},()=>create()));
  expect(new Set(results.map(r=>r.event.id)).size).toBe(1);
  await db.exec("set timezone='Pacific/Auckland'");
  try {expect((await create()).event).toEqual(results[0].event);} finally {await db.exec("set timezone='UTC'");}
  const updates=await Promise.allSettled([change(results[0].event.id,'update-a'),change(results[0].event.id,'update-b')]);
  expect(updates.filter(x=>x.status==='fulfilled')).toHaveLength(1);
  expect((await db.query('select * from mcp_internal.mcp_admin_events')).rows).toHaveLength(1);
 });
 it('Admin member assignments require active client membership',async()=>{
  const task=await db.query<{result:any}>(`select mcp_workflow_task('bot_admin',$1,'create_task',p_title:='Member fixture',p_request_id:='request',p_execution_id:='member-create') result`,[CLIENT_A]);
  await db.query("insert into team_members(id,category,name,initials) values($1,'smm','Fixture','FX')",[IDEA_B]);
  const assign=()=>db.query(`select mcp_workflow_task('bot_admin',$1,'assign_task',p_task_id:=$2,p_assignee:=$3,p_request_id:='request',p_execution_id:='member-assign')`,[CLIENT_A,task.rows[0]!.result.task.id,`member:${IDEA_B}`]);
  await expect(assign()).rejects.toThrow('invalid_assignee');
  await db.query('insert into client_assignments(member_id,client_id) values($1,$2)',[IDEA_B,CLIENT_A]);
  await assign();
  await db.query('update client_assignments set ended_at=now() where member_id=$1',[IDEA_B]);
  await expect(assign()).rejects.toThrow('invalid_assignee');
 });
 it('all eight event RPC definitions guard identity/client and forbid human access helpers',async()=>{
  const functions=await db.query<{def:string}>(`select pg_get_functiondef(p.oid) def from pg_proc p join pg_namespace n on n.oid=p.pronamespace where (n.nspname='public' and p.proname in ('mcp_admin_list_events','mcp_admin_get_event','mcp_admin_create_event','mcp_admin_update_event')) or (n.nspname='mcp_internal' and p.proname in ('admin_list_events','admin_get_event','admin_create_event','admin_update_event'))`);
  expect(functions.rows).toHaveLength(8);
  for(const row of functions.rows){expect(row.def).toContain('require_active_bot');expect(row.def).toContain('require_bot_client_grant');expect(row.def).not.toMatch(/can_access_client\s*\(/);expect(row.def).toContain('SECURITY DEFINER');expect(row.def).toContain('pg_catalog');}
 });

});
