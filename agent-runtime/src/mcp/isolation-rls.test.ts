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
      mcp_internal.mcp_bot_tokens, mcp_internal.mcp_content_requests, client_ideas, agent_job_events, agent_jobs,
      campaigns, client_leads, finance_entries, finance_periods, client_billing,
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
    ]) {
      expect(present.some((r) => r.rel === name && r.rls_enabled)).toBe(true);
    }
    for (const name of [
      'mcp_bots', 'mcp_bot_tokens', 'mcp_bot_clients', 'mcp_brief_requests', 'mcp_content_requests',
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

});
