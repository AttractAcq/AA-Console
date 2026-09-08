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
      mcp_internal.mcp_bot_tokens, client_ideas, agent_job_events, agent_jobs,
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
    for (const name of ['mcp_bots', 'mcp_bot_tokens', 'mcp_bot_clients', 'mcp_brief_requests']) {
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
    expect(src.rows[0]?.def).not.toMatch(/can_access_client/);
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
    expect(campaigns.rows.every((r) => r.client_id === CLIENT_A)).toBe(true);
    const periods = await db.query('select * from finance_periods');
    expect(periods.rows.length).toBe(0);
    const clients = await db.query<{ id: string }>('select id from clients');
    expect(clients.rows.map((r) => r.id)).toEqual([CLIENT_A]);
    await db.exec('reset role');
    await asService();
  });
});
