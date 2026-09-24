import { PGlite } from '@electric-sql/pglite';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

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
    '20260903104724_04_intelligence_and_strategy.sql',
    '20260903104816_05_content_chain_proof_ideas_briefs_media.sql',
    '20260903104850_06_distribution_conversion_leads.sql',
    '20260903104939_07_account_and_admin.sql',
    '20260904080405_14_campaigns.sql',
    '20260904083559_15_brief_refs_and_job_link.sql',
    '20260907170000_55_structured_briefs.sql',
    '20260908010000_59_page_html.sql',
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
    '20260909030000_73_mcp_marketing_director.sql',
    '20260909040000_74_mcp_production_bot_decide.sql',
    '20260909050000_75_mcp_distribution_manager.sql',
    '20260910000000_76_mcp_sales_ops.sql',
    '20260909010000_71_mcp_client_delivery.sql',
    '20260909020000_72_campaign_execution.sql',
    '20260909020100_72_mcp_cos_orchestration.sql',
    '20260911210000_78_mcp_admin_calendar.sql',
    '20260915120000_84_mcp_sales_agent_factory.sql',
  ]) await db.exec(await migration(file));
  for (const file of [
    '20260911205529_79_client_marketing_spend.sql',
    '20260915180000_85_mcp_finance_controller.sql',
    '20260915200000_86_mcp_engineering_ops.sql',
    '20260915220000_87_mcp_security_devops.sql',
    '20260913000000_82_page_revisions.sql',
    '20260913010000_83_page_polish_agents.sql',
    '20260916130000_89_mcp_conversion_campaign.sql',
  ]) await db.exec(await migration(file));
  // Phase 16b: do not load migration 80 (extensions.gen_random_bytes) or 39/57/81.
  // Stub the columns and tables the new RPCs touch, then load 90 and 93.
  await db.exec(`
    alter table client_sales_agents add column approved_at timestamptz;
    alter table client_pages add column if not exists publish_status text not null default 'unpublished';
    alter table client_pages add column if not exists site_repository_id uuid;
    alter table client_proof_assets
      add column ref_number text,
      add column proof_type text,
      add column claim text,
      add column evidence text,
      add column avatar_relevance text,
      add column strength text not null default 'medium',
      add column usage_rights text not null default 'not_cleared',
      add column captured_on date,
      add column expires_on date,
      add column updated_at timestamptz not null default now();
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
    alter table client_sales_agent_deployments enable row level security;
    alter table client_sales_agent_deployments force row level security;
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
      created_at timestamptz not null default now(),
      constraint creative_generations_no_ai_video check (media_type <> 'video')
    );
    create table if not exists creative_renders (
      id uuid primary key default gen_random_uuid(),
      generation_id uuid not null references creative_generations (id) on delete cascade,
      client_id uuid not null references clients (id) on delete cascade,
      job_id uuid references agent_jobs (id) on delete set null,
      quality text not null default 'medium',
      size text not null default '1024x1536',
      reference_path text,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
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
    alter table creative_generations enable row level security;
    alter table creative_generations force row level security;
    alter table creative_renders enable row level security;
    alter table creative_renders force row level security;
    alter table brief_dispatches enable row level security;
    alter table brief_dispatches force row level security;
    insert into agents (agent_key, name, initials, domain, description, requires_upstream)
    values
      ('creative_build', 'Creative Build', 'CB', 'content', 'Phase 16b fixture', '{}'),
      ('brief_dispatch', 'Brief Dispatch', 'BD', 'content', 'Phase 16b fixture', '{}')
    on conflict (agent_key) do nothing;
  `);
  await db.exec(await migration('20260916140000_90_mcp_sales_proof_production.sql'));
  // Phase 16c content-performance joins metrics_daily (migration 32, not
  // loaded by this partial fixture). Stub the columns the RPC reads.
  await db.exec(`
    create table if not exists metrics_daily (
      id uuid primary key default gen_random_uuid(),
      client_id uuid not null references clients (id) on delete cascade,
      post_id uuid,
      impressions bigint,
      spend numeric
    );
    alter table metrics_daily enable row level security;
    alter table client_ideas add column if not exists content_territory text;
  `);
  await db.exec(await migration('20260916150000_91_mcp_attribution_brand_sites.sql'));
  await db.exec(await migration('20260916180000_93_assign_production_ai_render.sql'));
  await db.exec(await migration('20260924110000_126_content_create_upload_url.sql'));
  await db.exec(`
    grant select on table clients, client_ideas, campaigns, finance_periods,
      client_leads, client_billing, finance_entries to authenticated;
    grant execute on function is_admin() to authenticated;
    grant execute on function current_role_of() to authenticated;
    grant execute on function can_access_client(uuid) to authenticated;
  `);
}, 90_000);

afterAll(async () => { await db?.close(); });

beforeEach(async () => {
  await db.exec(`reset role;
    truncate mcp_brief_requests, mcp_bot_clients, mcp_internal.mcp_bot_token_audit,
      mcp_internal.mcp_bot_tokens, mcp_internal.mcp_content_requests,
      mcp_internal.mcp_pipeline_requests, mcp_internal.mcp_sales_agent_requests,
      mcp_internal.mcp_conversion_requests, mcp_internal.mcp_campaign_requests,
      mcp_internal.mcp_proof_requests, scheduled_posts,
      client_media_assets, client_ideas, client_briefs, client_proof_assets,
      creative_generations, creative_renders, brief_dispatches, job_assignments,
      client_sales_agent_deployments, client_pages,
      agent_job_events, agent_jobs,
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
      'mcp_pipeline_requests', 'mcp_conversion_requests', 'mcp_campaign_requests',
      'asset_upload_grants',
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
    // 17 (Phase 11) + 5 (Phase 11b) + 3 (Phase 16b attach/enable/build) + 3 (Phase 16c brand/sites) = 28.
    expect(exact[0]?.n).toBe(28);
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


describe('Phase 12 release: shared workflow compatibility', () => {
  afterEach(async()=>{
    const source=await migration('20260911210000_78_mcp_admin_calendar.sql');
    const start=source.indexOf('function mcp_internal.workflow_task(');
    await db.exec('create or replace '+source.slice(start,source.indexOf('end $$;',start)+7));
  });
  const existing = ['bot_production','bot_client_delivery','bot_chief_of_staff','bot_marketing','bot_distribution','bot_sales_ops'];
  const call = async (bot:string, action:string, id:string|null=null, assignee:string|null=null, key=action, client=CLIENT_A, title='Release fixture') => {
    const r=await db.query<{result:any}>(`select mcp_workflow_task($1,$2,$3,p_task_id:=$4,p_title:=$5,p_assignee:=$6,p_request_id:='release-test',p_execution_id:=$7) result`,[bot,client,action,id,action==='create_task'?title:null,assignee,key]);
    return r.rows[0]!.result;
  };
  it('the previous shared function differs only by the explicit Admin guard',async()=>{
    const old=await migration('20260909020100_72_mcp_cos_orchestration.sql');
    const next=await migration('20260911210000_78_mcp_admin_calendar.sql');
    const extract=(s:string)=>s.slice(s.indexOf('function mcp_internal.workflow_task('),s.indexOf('end $$;',s.indexOf('function mcp_internal.workflow_task('))+7);
    const added=extract(next); const start=added.indexOf(" if p_bot_id='bot_admin' and p_action='assign_task' then");
    expect(start).toBeGreaterThan(0);
    const end=added.indexOf("   payload :=",start);
    const normalize=(sql:string)=>sql.replace(/--[^\n]*/g,'').replace(/\s+/g,' ').trim();
    expect(normalize(added.slice(0,start)+added.slice(end))).toBe(normalize(extract(old)));
  });
  for(const version of ['main','phase12']) for(const bot of existing) it(`${version} ${bot}: lifecycle, replay, assignees, errors and client boundary stay compatible`,async()=>{
    const source=await migration(version==='main'?'20260909020100_72_mcp_cos_orchestration.sql':'20260911210000_78_mcp_admin_calendar.sql');
    const start=source.indexOf('function mcp_internal.workflow_task(');
    await db.exec('create or replace '+source.slice(start,source.indexOf('end $$;',start)+7));
    await db.query('insert into mcp_bot_clients(bot_id,client_id) values($1,$2) on conflict do nothing',[bot,CLIENT_A]);
    const created=await call(bot,'create_task'); const id=created.task.id;
    expect((await call(bot,'create_task')).task).toEqual(created.task);
    expect((await call(bot,'get_task',id)).task).toEqual(created.task);
    expect((await call(bot,'list_tasks')).tasks.some((t:any)=>t.id===id)).toBe(true);
    // Legacy assignees need active identity, not a matching client grant.
    await db.exec("delete from mcp_bot_clients where bot_id='bot_finance'");
    const assigned=await call(bot,'assign_task',id,'bot_finance','assign');
    expect(assigned.task.assignee).toBe('bot_finance');
    await db.query("insert into team_members(id,category,name,initials) values($1,'smm','Release','RL') on conflict(id) do update set active=true",[IDEA_B]);
    await db.query('delete from client_assignments where member_id=$1',[IDEA_B]);
    expect((await call(bot,'assign_task',id,`member:${IDEA_B}`,'member')).task.assignee).toBe(`member:${IDEA_B}`);
    await db.query('update team_members set active=false where id=$1',[IDEA_B]);
    await expect(call(bot,'assign_task',id,`member:${IDEA_B}`,'inactive-member')).rejects.toThrow('invalid_assignee');
    await db.query('update team_members set active=true where id=$1',[IDEA_B]);
    await expect(call(bot,'assign_task',id,null,'null-assignee')).rejects.toThrow('invalid_request');
    for(const invalid of ['bot_unknown','bot-invalid',`member:${USER_A}`,'member:bad']) await expect(call(bot,'assign_task',id,invalid,invalid)).rejects.toThrow('invalid_assignee');
    await db.exec("update mcp_internal.mcp_bots set status='suspended' where bot_id='bot_finance'");
    await expect(call(bot,'assign_task',id,'bot_finance','suspended')).rejects.toThrow('invalid_assignee');
    // Legacy successful receipts are returned before revalidating an assignee.
    expect((await call(bot,'assign_task',id,'bot_finance','assign')).task).toEqual(assigned.task);
    const complete=await call(bot,'complete_task',id);
    expect(complete.task.status).toBe('complete');
    expect((await call(bot,'complete_task',id)).task).toEqual(complete.task);
    expect((await call(bot,'complete_task',id,null,'complete-again')).task).toEqual(complete.task);
    await expect(call(bot,'assign_task',id,'bot_finance','after-complete')).rejects.toThrow('task_completed');
    await expect(call(bot,'create_task',null,null,'create_task',CLIENT_A,'Changed')).rejects.toThrow('idempotency_conflict');
    await expect(call(bot,'create_task',null,null,'bad-title',CLIENT_A,'')).rejects.toThrow('invalid_request');
    await expect(call(bot,'get_task',USER_A)).rejects.toThrow('task_not_found');
    for(const action of ['create_task','assign_task','get_task','list_tasks','complete_task']) await expect(call(bot,action,id,'bot_finance','foreign',CLIENT_B)).rejects.toThrow('client_forbidden');
    await db.query('insert into mcp_bot_clients(bot_id,client_id) values($1,$2)',[bot,CLIENT_B]);
    await expect(call(bot,'get_task',id,null,'foreign-id',CLIENT_B)).rejects.toThrow('client_mismatch');
  });
});

describe('Phase 12 release: Admin assignee matrix',()=>{
  let id:string;
  const assign=(who:string)=>db.query(`select mcp_workflow_task('bot_admin',$1,'assign_task',p_task_id:=$2,p_assignee:=$3,p_request_id:='release-test',p_execution_id:='assign')`,[CLIENT_A,id,who]);
  beforeEach(async()=>{
    await db.query("insert into mcp_bot_clients(bot_id,client_id) values('bot_admin',$1)",[CLIENT_A]);
    id=(await db.query<{result:any}>(`select mcp_workflow_task('bot_admin',$1,'create_task',p_title:='Assignment fixture',p_request_id:='release-test',p_execution_id:='create') result`,[CLIENT_A])).rows[0]!.result.task.id;
    await db.query("insert into team_members(id,category,name,initials) values($1,'smm','Release','RL') on conflict(id) do update set active=true",[IDEA_B]);
    await db.query('delete from client_assignments where member_id=$1',[IDEA_B]);
  });
  for(const scenario of ['same','wrong','suspended','unknown','malformed','revoke-replay','suspend-replay']) it(`bot assignee ${scenario}`,async()=>{
    const who=scenario==='unknown'?'bot_unknown':scenario==='malformed'?'bot-invalid':'bot_client_delivery';
    if(!['unknown','malformed'].includes(scenario)) await db.query('insert into mcp_bot_clients(bot_id,client_id) values($1,$2)',[who,scenario==='wrong'?CLIENT_B:CLIENT_A]);
    if(scenario==='suspended') await db.query("update mcp_internal.mcp_bots set status='suspended' where bot_id=$1",[who]);
    if(['wrong','suspended','unknown','malformed'].includes(scenario)) {await expect(assign(who)).rejects.toThrow();return;}
    await assign(who);await assign(who);
    if(scenario==='revoke-replay') {await db.query('delete from mcp_bot_clients where bot_id=$1',[who]);await expect(assign(who)).rejects.toThrow('client_forbidden');}
    if(scenario==='suspend-replay') {await db.query("update mcp_internal.mcp_bots set status='suspended' where bot_id=$1",[who]);await expect(assign(who)).rejects.toThrow('bot_not_active');}
  });
  for(const scenario of ['same','wrong','ended','inactive','unknown','malformed','ended-replay']) it(`member assignee ${scenario}`,async()=>{
    await db.query('insert into client_assignments(member_id,client_id) values($1,$2)',[IDEA_B,scenario==='wrong'?CLIENT_B:CLIENT_A]);
    if(scenario==='ended') await db.query('update client_assignments set ended_at=now() where member_id=$1',[IDEA_B]);
    if(scenario==='inactive') await db.query('update team_members set active=false where id=$1',[IDEA_B]);
    const who=scenario==='unknown'?`member:${USER_A}`:scenario==='malformed'?'member:bad':`member:${IDEA_B}`;
    if(!['same','ended-replay'].includes(scenario)) {await expect(assign(who)).rejects.toThrow('invalid_assignee');return;}
    await assign(who);await assign(who);
    if(scenario==='ended-replay') {await db.query('update client_assignments set ended_at=now() where member_id=$1',[IDEA_B]);await expect(assign(who)).rejects.toThrow('invalid_assignee');}
  });
});

describe('Phase 11b Sales Agent Factory isolation', () => {
  const AGENT_A = '9999b001-9999-4999-8999-999999999911';
  const AGENT_B = '9999b002-9999-4999-8999-999999999912';

  const generate = (
    overrides: Partial<{ bot: string; client: string; role: string; execution: string }> = {},
  ) => db.query<{ result: any }>(
    'select mcp_generate_sales_agent_config($1,$2,$3,$4,$5) as result',
    [
      overrides.bot ?? 'bot_sales_ops', 'gen-req', overrides.execution ?? 'gen-exec',
      overrides.client ?? CLIENT_A, overrides.role ?? 'inbound_qualifier',
    ],
  );
  const create = (
    overrides: Partial<{ bot: string; client: string; role: string; name: string; purpose: string; execution: string }> = {},
  ) => db.query<{ result: any }>(
    'select mcp_create_sales_agent($1,$2,$3,$4,$5,$6,$7) as result',
    [
      overrides.bot ?? 'bot_sales_ops', 'create-req', overrides.execution ?? 'create-exec',
      overrides.client ?? CLIENT_A, overrides.role ?? 'inbound_qualifier',
      overrides.name ?? 'Front Desk', overrides.purpose ?? 'Qualify and book',
    ],
  );
  const updateKnowledge = (
    overrides: Partial<{
      bot: string; client: string; agent: string; objections: unknown; guardrails: string | null;
      greeting: string | null; execution: string;
    }> = {},
  ) => db.query<{ result: any }>(
    'select mcp_update_sales_agent_knowledge($1,$2,$3,$4,$5,$6,$7,$8) as result',
    [
      overrides.bot ?? 'bot_sales_ops', 'know-req', overrides.execution ?? 'know-exec',
      overrides.client ?? CLIENT_A, overrides.agent ?? AGENT_A,
      overrides.objections === undefined
        ? JSON.stringify([{ objection: 'Too expensive', response: 'Compare to the alternative' }])
        : overrides.objections === null ? null : JSON.stringify(overrides.objections),
      overrides.guardrails === undefined ? 'Never quote a price.' : overrides.guardrails,
      overrides.greeting === undefined ? null : overrides.greeting,
    ],
  );
  const updateQualification = (
    overrides: Partial<{ bot: string; client: string; agent: string; qualification: unknown; execution: string }> = {},
  ) => db.query<{ result: any }>(
    'select mcp_update_sales_agent_qualification_rules($1,$2,$3,$4,$5,$6) as result',
    [
      overrides.bot ?? 'bot_sales_ops', 'qual-req', overrides.execution ?? 'qual-exec',
      overrides.client ?? CLIENT_A, overrides.agent ?? AGENT_A,
      JSON.stringify(overrides.qualification ?? [
        { question: 'What is your timeline?', why: 'Timing', good_answer: 'Now', disqualifier: 'Never' },
      ]),
    ],
  );
  const sandboxTest = (
    overrides: Partial<{ bot: string; client: string; agent: string; transcript: unknown; execution: string }> = {},
  ) => db.query<{ result: any }>(
    'select mcp_test_sales_agent($1,$2,$3,$4,$5,$6) as result',
    [
      overrides.bot ?? 'bot_sales_ops', 'test-req', overrides.execution ?? 'test-exec',
      overrides.client ?? CLIENT_A, overrides.agent ?? AGENT_A,
      JSON.stringify(overrides.transcript ?? [{ role: 'lead', text: 'Hi, I need help.' }]),
    ],
  );

  beforeEach(async () => {
    await db.exec(`
      insert into client_sales_agents (id, client_id, name, purpose, status, role) values
        ('${AGENT_A}', '${CLIENT_A}', 'Closer A', 'Qualify and book', 'live', 'inbound_qualifier'),
        ('${AGENT_B}', '${CLIENT_B}', 'Closer B', 'Qualify and book', 'live', 'inbound_qualifier');
      insert into mcp_bot_clients (bot_id, client_id) values ('bot_sales_ops', '${CLIENT_A}');
    `);
  });

  it('every new RPC uses require_active_bot + require_bot_client_grant, never can_access_client, and hard-codes bot_sales_ops', async () => {
    const signatures = [
      'mcp_internal.generate_sales_agent_config(text,text,text,uuid,text)',
      'mcp_internal.create_sales_agent(text,text,text,uuid,text,text,text)',
      'mcp_internal.update_sales_agent_knowledge(text,text,text,uuid,uuid,jsonb,text,text)',
      'mcp_internal.update_sales_agent_qualification_rules(text,text,text,uuid,uuid,jsonb)',
      'mcp_internal.test_sales_agent(text,text,text,uuid,uuid,jsonb)',
    ];
    for (const sig of signatures) {
      const src = await db.query<{ def: string }>(`select pg_get_functiondef('${sig}'::regprocedure) as def`);
      expect(src.rows[0]?.def, sig).toContain('require_active_bot');
      expect(src.rows[0]?.def, sig).toContain('require_bot_client_grant');
      expect(src.rows[0]?.def, sig).toContain('bot_forbidden');
      expect(src.rows[0]?.def, sig).not.toMatch(/can_access_client\s*\(/);
    }
    for (const role of ['anon', 'authenticated']) {
      await db.exec(`set role ${role}`);
      await expect(db.query('select mcp_generate_sales_agent_config($1,$2,$3,$4,$5)',
        ['bot_sales_ops', 'r', 'e', CLIENT_A, 'inbound_qualifier'])).rejects.toThrow('permission denied');
      await expect(db.query('select mcp_create_sales_agent($1,$2,$3,$4,$5,$6,$7)',
        ['bot_sales_ops', 'r', 'e', CLIENT_A, 'inbound_qualifier', 'x', 'y'])).rejects.toThrow('permission denied');
      await db.exec('reset role');
    }
    await asService();
  });

  it('generate_config composes a draft for the granted client only and replays idempotently', async () => {
    const draft = (await generate()).rows[0]!.result;
    expect(draft.role).toBe('inbound_qualifier');
    expect(draft.draft.qualification.length).toBeGreaterThanOrEqual(1);
    expect(draft.replayed).toBe(false);
    const replay = (await generate()).rows[0]!.result;
    expect(replay.replayed).toBe(true);
    await expect(generate({ role: 'appointment_setter', execution: 'gen-exec' })).rejects.toThrow('idempotency_conflict');
    await expect(generate({ client: CLIENT_B, execution: 'gen-cross' })).rejects.toThrow('client_forbidden');
    await expect(generate({ role: 'not-a-role', execution: 'gen-badrole' })).rejects.toThrow('invalid_role');
  });

  it('create persists a new per-client agent, binds client_id, and replays idempotently', async () => {
    const created = (await create()).rows[0]!.result;
    expect(created.role).toBe('inbound_qualifier');
    expect(created.status).toBe('draft');
    expect(created.client_id).toBe(CLIENT_A);
    const row = (await db.query<{ client_id: string; role: string }>(
      `select client_id, role from client_sales_agents where id = '${created.id}'`,
    )).rows[0]!;
    expect(row.client_id).toBe(CLIENT_A);
    expect(row.role).toBe('inbound_qualifier');
    const replay = (await create()).rows[0]!.result;
    expect(replay.replayed).toBe(true);
    expect(replay.id).toBe(created.id);
    await expect(create({ name: 'Different Name', execution: 'create-exec' })).rejects.toThrow('idempotency_conflict');
    await expect(create({ client: CLIENT_B, execution: 'create-cross' })).rejects.toThrow('client_forbidden');
  });

  it('update_knowledge writes objections/guardrails/greeting on the owned agent and rejects a cross-client resource', async () => {
    const updated = (await updateKnowledge()).rows[0]!.result;
    expect(updated.guardrails).toBe('Never quote a price.');
    expect(updated.objections).toHaveLength(1);
    const replay = (await updateKnowledge()).rows[0]!.result;
    expect(replay.replayed).toBe(true);
    await expect(updateKnowledge({ agent: AGENT_B, execution: 'know-mismatch' })).rejects.toThrow('client_mismatch');
    await expect(updateKnowledge({ client: CLIENT_B, agent: AGENT_B, execution: 'know-forbidden' })).rejects.toThrow('client_forbidden');
    await expect(updateKnowledge({
      objections: null, guardrails: null, execution: 'know-empty',
    })).rejects.toThrow('invalid_request');
  });

  it('update_qualification_rules replaces the qualification list on the owned agent and rejects a cross-client resource', async () => {
    const updated = (await updateQualification()).rows[0]!.result;
    expect(updated.qualification).toHaveLength(1);
    const replay = (await updateQualification()).rows[0]!.result;
    expect(replay.replayed).toBe(true);
    await expect(updateQualification({ agent: AGENT_B, execution: 'qual-mismatch' })).rejects.toThrow('client_mismatch');
    await expect(updateQualification({ qualification: [], execution: 'qual-empty' })).rejects.toThrow('invalid_request');
  });

  it('test runs a sandbox check against the owned agent, never touches sales_agent_conversations, and rejects a cross-client resource', async () => {
    const before = (await db.query<{ n: number }>(
      'select count(*)::int as n from sales_agent_conversations',
    )).rows[0]?.n;
    const result = (await sandboxTest()).rows[0]!.result;
    expect(result.sandbox).toBe(true);
    expect(result.live_channel_send).toBe(false);
    expect(result.turns_evaluated).toBe(1);
    const after = (await db.query<{ n: number }>(
      'select count(*)::int as n from sales_agent_conversations',
    )).rows[0]?.n;
    expect(after).toBe(before);
    await expect(sandboxTest({ agent: AGENT_B, execution: 'test-mismatch' })).rejects.toThrow('client_mismatch');
  });

  it('test never writes the raw transcript into the ledger payload -- only a digest and turn count', async () => {
    await sandboxTest({
      transcript: [
        { role: 'lead', text: 'Hi, I need help with pricing.' },
        { role: 'agent', text: 'Happy to help -- what is your timeline?' },
      ],
      execution: 'test-digest',
    });
    const row = (await db.query<{ payload: any }>(
      "select payload from mcp_internal.mcp_sales_agent_requests where tool = 'sales_agents.test' and execution_id = 'test-digest'",
    )).rows[0]!;
    expect(Object.keys(row.payload).sort()).toEqual(['sales_agent_id', 'transcript_digest', 'turns']);
    expect(row.payload.turns).toBe(2);
    expect(row.payload.transcript_digest).toMatch(/^[0-9a-f]{64}$/);
    const serialized = JSON.stringify(row.payload);
    expect(serialized).not.toContain('"transcript"');
    expect(serialized).not.toContain('pricing');
    expect(serialized).not.toContain('timeline');
  });

  it('bot_forbidden: no Bot other than bot_sales_ops can call any factory write, even with an active status and a valid client grant', async () => {
    await db.exec(`insert into mcp_bot_clients (bot_id,client_id) values ('bot_production','${CLIENT_A}') on conflict do nothing;`);
    await expect(generate({ bot: 'bot_production', execution: 'prod-gen' })).rejects.toThrow('bot_forbidden');
    await expect(create({ bot: 'bot_production', execution: 'prod-create' })).rejects.toThrow('bot_forbidden');
    await expect(updateKnowledge({ bot: 'bot_production', execution: 'prod-know' })).rejects.toThrow('bot_forbidden');
    await expect(updateQualification({ bot: 'bot_production', execution: 'prod-qual' })).rejects.toThrow('bot_forbidden');
    await expect(sandboxTest({ bot: 'bot_production', execution: 'prod-test' })).rejects.toThrow('bot_forbidden');
  });

  it('suspended bot is bot_not_active even with a remaining grant', async () => {
    await db.query('select mcp_issue_bot_token($1,$2,$3,$4)', ['bot_sales_ops', HASH, 'operator', 'test']);
    await db.query('select mcp_suspend_bot($1,$2,$3)', ['bot_sales_ops', 'operator', 'lock']);
    await expect(generate()).rejects.toThrow('bot_not_active');
    await expect(create()).rejects.toThrow('bot_not_active');
  });

  it('revoked grant denies replay before lookup', async () => {
    await create();
    await db.exec(`delete from mcp_bot_clients where bot_id = 'bot_sales_ops' and client_id = '${CLIENT_A}'`);
    await expect(create({ execution: 'create-revoked' })).rejects.toThrow('client_forbidden');
    await expect(updateKnowledge({ execution: 'know-revoked' })).rejects.toThrow('client_forbidden');
  });

  it('permission rows: exactly 5 new exact-name rows for bot_sales_ops, none outside it, deploy/record_sale/proof.* still absent', async () => {
    const mine = (await db.query<{ n: number }>(
      `select count(*)::int as n from mcp_internal.mcp_bot_permissions
        where bot_id = 'bot_sales_ops'
          and permission_pattern in ('sales_agents.generate_config', 'sales_agents.create',
            'sales_agents.update_knowledge', 'sales_agents.update_qualification_rules', 'sales_agents.test')`,
    )).rows;
    expect(mine[0]?.n).toBe(5);
    const other = (await db.query<{ n: number }>(
      `select count(*)::int as n from mcp_internal.mcp_bot_permissions
        where bot_id <> 'bot_sales_ops'
          and permission_pattern in ('sales_agents.generate_config', 'sales_agents.create',
            'sales_agents.update_knowledge', 'sales_agents.update_qualification_rules', 'sales_agents.test')`,
    )).rows;
    expect(other[0]?.n).toBe(0);
    const forbidden = (await db.query<{ n: number }>(
      `select count(*)::int as n from mcp_internal.mcp_bot_permissions
        where bot_id = 'bot_sales_ops'
          and permission_pattern in ('sales_agents.deploy', 'pipeline.record_sale', 'proof.search', 'proof.get')`,
    )).rows;
    expect(forbidden[0]?.n).toBe(0);
    // Ongoing guard: a future attempt to grant bot_sales_ops the deploy stub
    // must still be rejected, even though this phase legitimizes its four
    // siblings.
    await expect(db.exec(
      `insert into mcp_internal.mcp_bot_permissions (bot_id, permission_pattern, granted_by)
       values ('bot_sales_ops', 'sales_agents.deploy', 'test')`,
    )).rejects.toThrow(/Phase 11b: bot_sales_ops must not hold/);
    await expect(db.exec(
      `insert into mcp_internal.mcp_bot_permissions (bot_id, permission_pattern, granted_by)
       values ('bot_production', 'sales_agents.create', 'test')`,
    )).rejects.toThrow(/Phase 11: pipeline/);
  });
});

describe('Phase 13 Finance Controller isolation', () => {
  const CAMP_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const CAMP_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const LEAD_A = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  const read = (
    action = 'get_client_economics',
    client = CLIENT_A,
    bot = 'bot_finance',
    start = '2026-09-01',
    end = '2026-10-01',
    campaign: string | null = null,
  ) => db.query<{ result: any }>(
    `select public.mcp_economics_read($1,$2,$3,$4,$5::date,$6::date,25) result`,
    [bot, client, action, campaign, start, end],
  );
  const attrib = (
    client = CLIENT_A,
    bot = 'bot_finance',
    campaign: string | null = null,
  ) => db.query<{ result: any }>(
    `select public.mcp_attribution_revenue($1,$2,$3,'2026-09-01'::date,'2026-10-01'::date,25) result`,
    [bot, client, campaign],
  );

  beforeEach(async () => {
    await db.exec(`
      insert into mcp_bot_clients(bot_id,client_id) values
        ('bot_finance','${CLIENT_A}'),
        ('bot_chief_of_staff','${CLIENT_A}');
      insert into campaigns (id, campaign_ref, client_id, target_role, daily_spend)
        values ('${CAMP_A}','FIN-A','${CLIENT_A}','owner',1),
               ('${CAMP_B}','FIN-B','${CLIENT_B}','owner',1);
      insert into client_marketing_spend (client_id, spent_on, amount, currency, source, campaign_id)
        values ('${CLIENT_A}','2026-09-10',1000,'ZAR','manual','${CAMP_A}'),
               ('${CLIENT_B}','2026-09-10',9999,'ZAR','manual','${CAMP_B}');
      insert into client_leads (id, client_id, name, email, stage, sale_value, cash_collected, source_campaign_id, created_at)
        values ('${LEAD_A}','${CLIENT_A}','Alpha','a@example.com','sale',2000,1500,'${CAMP_A}','2026-09-12T00:00:00Z');
    `);
  });

  it('returns cohort economics for the granted client and never leaks the other client', async () => {
    const row = (await read()).rows[0]!.result;
    expect(row.client_id).toBe(CLIENT_A);
    expect(row.projection).toBe('acquisition_cohort_economics_v1');
    expect(row.exclusive_end).toBe(true);
    expect(Number(row.economics.spend)).toBe(1000);
    expect(row.economics.leads).toBe(1);
    expect(row.economics.customers).toBe(1);
    expect(Number(row.economics.revenue)).toBe(2000);
    expect(Number(row.economics.cash_collected)).toBe(1500);
    expect(Number(row.economics.roas)).toBe(2);
    expect(Number(row.economics.cac)).toBe(1000);
    expect(JSON.stringify(row)).not.toContain(CLIENT_B);
    expect(JSON.stringify(row)).not.toContain('9999');
    expect(JSON.stringify(row)).not.toContain('a@example.com');
    const costs = (await read('get_costs')).rows[0]!.result.economics;
    expect(Number(costs.spend)).toBe(1000);
    expect(costs.revenue).toBeUndefined();
    const revenue = (await read('get_revenue')).rows[0]!.result.economics;
    expect(Number(revenue.revenue)).toBe(2000);
    expect(revenue.spend).toBeUndefined();
    const roi = (await read('get_roi')).rows[0]!.result.economics;
    expect(Number(roi.roas)).toBe(2);
    expect(Number(roi.cash_roas)).toBe(1.5);
    const campaigns = (await read('get_campaign_economics')).rows[0]!.result.campaigns;
    expect(campaigns).toHaveLength(1);
    expect(campaigns[0].campaign_id).toBe(CAMP_A);
    const one = (await read('get_campaign_economics', CLIENT_A, 'bot_finance', '2026-09-01', '2026-10-01', CAMP_A)).rows[0]!.result;
    expect(one.campaigns).toHaveLength(1);
    const attr = (await attrib()).rows[0]!.result;
    expect(attr.projection).toBe('acquisition_cohort_revenue_attribution_v1');
    expect(attr.campaigns[0].campaign_id).toBe(CAMP_A);
  });

  it('denies ungranted clients, other bots, revoked grants, suspended identity, and foreign campaigns', async () => {
    await expect(read('get_client_economics', CLIENT_B)).rejects.toThrow('client_forbidden');
    await expect(attrib(CLIENT_B)).rejects.toThrow('client_forbidden');
    await expect(read('get_costs', CLIENT_A, 'bot_production')).rejects.toThrow('bot_forbidden');
    await expect(attrib(CLIENT_A, 'bot_production')).rejects.toThrow('bot_forbidden');
    await db.exec(`delete from mcp_bot_clients where bot_id='bot_finance'`);
    await expect(read()).rejects.toThrow('client_forbidden');
    await db.exec(`insert into mcp_bot_clients(bot_id,client_id) values('bot_finance','${CLIENT_A}')`);
    await db.exec(`update mcp_internal.mcp_bots set status='suspended' where bot_id='bot_finance'`);
    await expect(read()).rejects.toThrow('bot_not_active');
    await db.exec(`update mcp_internal.mcp_bots set status='active' where bot_id='bot_finance'`);
    await expect(read('get_campaign_economics', CLIENT_A, 'bot_finance', '2026-09-01', '2026-10-01', CAMP_B)).rejects.toThrow('campaign_not_found');
    await expect(read('get_campaign_economics', CLIENT_A, 'bot_finance', '2026-09-01', '2026-10-01', 'dddddddd-dddd-4ddd-8ddd-dddddddddddd')).rejects.toThrow('campaign_not_found');
  });

  it('rejects invalid windows, client-level campaign_id, and campaign_id on get_costs', async () => {
    await expect(read('get_client_economics', CLIENT_A, 'bot_finance', '2026-10-01', '2026-09-01')).rejects.toThrow('invalid_request');
    await expect(read('get_client_economics', CLIENT_A, 'bot_finance', '2020-01-01', '2022-01-02')).rejects.toThrow('invalid_request');
    await expect(read('get_costs', CLIENT_A, 'bot_finance', '2026-09-01', '2026-10-01', CAMP_A)).rejects.toThrow('invalid_request');
  });

  it('lets CoS use attribution.get_revenue_attribution via its existing wildcard, not economics', async () => {
    const attr = (await attrib(CLIENT_A, 'bot_chief_of_staff')).rows[0]!.result;
    expect(attr.client_id).toBe(CLIENT_A);
    await expect(read('get_client_economics', CLIENT_A, 'bot_chief_of_staff')).rejects.toThrow('bot_forbidden');
  });

  it('revokes exact economics permission even if a wildcard is attempted', async () => {
    await db.exec(`delete from mcp_internal.mcp_bot_permissions where bot_id='bot_finance' and permission_pattern='economics.get_costs'`);
    await expect(read('get_costs')).rejects.toThrow('bot_forbidden');
    await expect(db.exec(
      `insert into mcp_internal.mcp_bot_permissions(bot_id,permission_pattern,granted_by)
       values ('bot_finance','economics.*','test')`,
    )).rejects.toThrow(/Phase 13: bot_finance must not hold economics\.\*/);
    await expect(db.exec(
      `insert into mcp_internal.mcp_bot_permissions(bot_id,permission_pattern,granted_by)
       values ('bot_marketing','economics.get_costs','test')`,
    )).rejects.toThrow(/Phase 13: economics/);
    await db.exec(
      `insert into mcp_internal.mcp_bot_permissions(bot_id,permission_pattern,granted_by)
       values ('bot_finance','economics.get_costs','phase-13-locked')`,
    );
  });

  it('every new RPC uses require_active_bot + require_bot_client_grant, never can_access_client, and hard-codes bot_finance on economics', async () => {
    const functions = await db.query<{ def: string; proname: string }>(
      `select p.proname, pg_get_functiondef(p.oid) def
         from pg_proc p join pg_namespace n on n.oid=p.pronamespace
        where (n.nspname='public' and p.proname in ('mcp_economics_read','mcp_attribution_revenue'))
           or (n.nspname='mcp_internal' and p.proname in ('economics_read','attribution_revenue','require_finance_permission','cohort_economics','cohort_economics_by_campaign'))`,
    );
    expect(functions.rows.length).toBe(7);
    for (const row of functions.rows) {
      expect(row.def, row.proname).not.toMatch(/can_access_client\s*\(/);
      expect(row.def, row.proname).toContain('SECURITY DEFINER');
      if (row.proname === 'cohort_economics' || row.proname === 'cohort_economics_by_campaign') continue;
      expect(row.def, row.proname).toContain('require_active_bot');
      expect(row.def, row.proname).toContain('require_bot_client_grant');
    }
    const econ = functions.rows.find((r) => r.proname === 'economics_read')!.def;
    expect(econ).toContain('bot_finance');
    expect(econ).toContain('bot_forbidden');
  });

  it('service_role may execute public wrappers; anon/authenticated and internal functions cannot', async () => {
    for (const role of ['anon', 'authenticated']) {
      await db.exec(`set role ${role}`);
      await expect(read()).rejects.toThrow(/permission denied|unauthorized/);
      await expect(attrib()).rejects.toThrow(/permission denied|unauthorized/);
      await asService();
    }
    await db.exec(`set role service_role`);
    await expect(db.query(`select mcp_internal.economics_read('bot_finance',$1,'get_costs')`, [CLIENT_A])).rejects.toThrow(/permission denied/);
    await expect(db.query(`select mcp_internal.attribution_revenue('bot_finance',$1)`, [CLIENT_A])).rejects.toThrow(/permission denied/);
    await asService();
  });

  it('bot_finance has exactly 14 exact permission rows and no economics.* wildcard', async () => {
    const rows = await db.query<{ permission_pattern: string }>(
      `select permission_pattern from mcp_internal.mcp_bot_permissions where bot_id='bot_finance' order by 1`,
    );
    expect(rows.rows).toHaveLength(14);
    expect(rows.rows.map((r) => r.permission_pattern)).not.toContain('economics.*');
    expect(rows.rows.some((r) => r.permission_pattern === 'economics.get_client_economics')).toBe(true);
    expect(rows.rows.some((r) => r.permission_pattern === 'pipeline.record_sale')).toBe(false);
  });
});

describe('Phase 14 Engineering Ops isolation', () => {
  const PAGE_A = 'aaaaaaa1-aaaa-4aaa-8aaa-aaaaaaaaaaa1';
  const PAGE_B = 'bbbbbbb1-bbbb-4bbb-8bbb-bbbbbbbbbbb1';
  const JOB_A = 'aaaaaaa2-aaaa-4aaa-8aaa-aaaaaaaaaaa2';
  const JOB_B = 'bbbbbbb2-bbbb-4bbb-8bbb-bbbbbbbbbbb2';
  const create = async (
    client = CLIENT_A,
    execution = 'eng-create',
    bot = 'bot_engineering',
    title = 'Broken publish',
  ) => {
    const q = await db.query<{ result: any }>(
      `select public.mcp_engineering_create_issue($1,$2,'request-14',$3,$4,null) result`,
      [bot, client, execution, title],
    );
    return q.rows[0]!.result;
  };
  beforeEach(async () => {
    await db.exec(`
      insert into mcp_bot_clients(bot_id,client_id) values
        ('bot_engineering','${CLIENT_A}'),
        ('bot_security_devops','${CLIENT_A}');
      insert into client_pages (id,client_id,page_type,title,status,published_url,body) values
        ('${PAGE_A}','${CLIENT_A}','landing','Harbour Home','approved','https://example.test/h','SECRET BODY'),
        ('${PAGE_B}','${CLIENT_B}','landing','Other Home','draft',null,'OTHER SECRET');
      insert into agent_jobs (id,agent_key,client_id,status,params,cost_usd,error) values
        ('${JOB_A}','landing_page','${CLIENT_A}','completed','{"token":"SECRET"}',9.99,'SECRET ERR'),
        ('${JOB_B}','landing_page','${CLIENT_B}','queued','{"token":"SECRET"}',1.00,'OTHER ERR');
      insert into agent_jobs (id,agent_key,client_id,status) values
        ('ccccccc2-cccc-4ccc-8ccc-ccccccccccc2','landing_page',null,'queued');
    `);
  });

  it('same-client issue create/get and status reads omit secrets', async () => {
    const made = await create();
    expect(made.issue.created_by_bot).toBe('bot_engineering');
    expect((await db.query('select * from mcp_internal.mcp_engineering_issues')).rows).toHaveLength(1);
    const got = await db.query<{ result: any }>(
      `select mcp_engineering_get_issue('bot_engineering',$1,$2) result`,
      [CLIENT_A, made.issue.id],
    );
    expect(got.rows[0]!.result.issue.id).toBe(made.issue.id);
    const pages = (await db.query<{ result: any }>(
      `select mcp_engineering_get_release_status('bot_engineering',$1) result`,
      [CLIENT_A],
    )).rows[0]!.result;
    expect(pages.pages).toHaveLength(1);
    expect(pages.pages[0].id).toBe(PAGE_A);
    expect(JSON.stringify(pages)).not.toMatch(/SECRET/);
    const jobs = (await db.query<{ result: any }>(
      `select mcp_engineering_get_deployment_status('bot_engineering',$1) result`,
      [CLIENT_A],
    )).rows[0]!.result;
    expect(jobs.jobs).toHaveLength(1);
    expect(jobs.jobs[0].id).toBe(JOB_A);
    expect(JSON.stringify(jobs)).not.toMatch(/SECRET|9\.99/);
  });

  it('replay returns the saved issue; changed payload conflicts', async () => {
    const first = await create();
    const again = await create();
    expect(again.issue).toEqual(first.issue);
    expect(again.replayed).toBe(true);
    await expect(create(CLIENT_A, 'eng-create', 'bot_engineering', 'Different')).rejects.toThrow(
      'idempotency_conflict',
    );
  });

  it('ungranted client, suspended bot and revoked grant deny', async () => {
    await expect(
      db.query(`select mcp_engineering_get_release_status('bot_engineering',$1)`, [CLIENT_B]),
    ).rejects.toThrow('client_forbidden');
    await db.exec(`update mcp_internal.mcp_bots set status='suspended' where bot_id='bot_engineering'`);
    await expect(
      db.query(`select mcp_engineering_get_release_status('bot_engineering',$1)`, [CLIENT_A]),
    ).rejects.toThrow('bot_not_active');
    await db.exec(`update mcp_internal.mcp_bots set status='active' where bot_id='bot_engineering'`);
    await db.exec(`delete from mcp_bot_clients where bot_id='bot_engineering'`);
    await expect(create()).rejects.toThrow('client_forbidden');
  });

  it('missing and foreign issue/page/job ids are indistinguishable', async () => {
    const first = await create();
    await db.exec(`insert into mcp_bot_clients(bot_id,client_id) values('bot_engineering','${CLIENT_B}')`);
    await expect(
      db.query(`select mcp_engineering_get_issue('bot_engineering',$1,$2)`, [CLIENT_B, first.issue.id]),
    ).rejects.toThrow('issue_not_found');
    await expect(
      db.query(`select mcp_engineering_get_issue('bot_engineering',$1,$2)`, [CLIENT_A, CLIENT_B]),
    ).rejects.toThrow('issue_not_found');
    await expect(
      db.query(`select mcp_engineering_get_release_status('bot_engineering',$1,25,null,$2)`, [CLIENT_A, PAGE_B]),
    ).rejects.toThrow('page_not_found');
    await expect(
      db.query(`select mcp_engineering_get_deployment_status('bot_engineering',$1,25,null,$2)`, [CLIENT_A, JOB_B]),
    ).rejects.toThrow('job_not_found');
  });

  it('other bots cannot create or get issues; Security can read status', async () => {
    // bot_production already has CLIENT_A from the shared fixture; extra insert would PK-conflict.
    await expect(create(CLIENT_A, 'prod-create', 'bot_production')).rejects.toThrow('bot_forbidden');
    const pages = (await db.query<{ result: any }>(
      `select mcp_engineering_get_release_status('bot_security_devops',$1) result`,
      [CLIENT_A],
    )).rows[0]!.result;
    expect(pages.pages).toHaveLength(1);
    await expect(
      db.query(`select mcp_engineering_create_issue('bot_security_devops',$1,'r','e','Nope',null)`, [CLIENT_A]),
    ).rejects.toThrow('bot_forbidden');
  });

  it('removed exact permission denies even with engineering wildcard attempt', async () => {
    await expect(
      db.exec(
        `insert into mcp_internal.mcp_bot_permissions(bot_id,permission_pattern,granted_by)
         values('bot_engineering','engineering.*','test')`,
      ),
    ).rejects.toThrow(/Phase 14: engineering\.\* wildcard is forbidden/);
    await db.exec(
      `delete from mcp_internal.mcp_bot_permissions where bot_id='bot_engineering' and permission_pattern='engineering.create_issue'`,
    );
    await expect(create()).rejects.toThrow('bot_forbidden');
    await db.exec(
      `insert into mcp_internal.mcp_bot_permissions(bot_id,permission_pattern,granted_by)
       values('bot_engineering','engineering.create_issue','phase-14:engineering-ops-allowlist')`,
    );
  });

  it('issue tools cannot be granted outside bot_engineering', async () => {
    await expect(
      db.exec(
        `insert into mcp_internal.mcp_bot_permissions(bot_id,permission_pattern,granted_by)
         values('bot_production','engineering.create_issue','test')`,
      ),
    ).rejects.toThrow(/Phase 14: issue tools must not be granted outside bot_engineering/);
  });

  it('anon and authenticated cannot execute public wrappers; tables deny including service_role', async () => {
    const first = await create();
    for (const role of ['anon', 'authenticated']) {
      await db.exec(`set role ${role}`);
      for (const sql of [
        `select mcp_engineering_get_release_status('bot_engineering','${CLIENT_A}')`,
        `select mcp_engineering_get_issue('bot_engineering','${CLIENT_A}','${first.issue.id}')`,
        `select mcp_engineering_create_issue('bot_engineering','${CLIENT_A}','req','exec','Title',null)`,
        `select mcp_engineering_get_deployment_status('bot_engineering','${CLIENT_A}')`,
      ]) {
        await expect(db.query(sql)).rejects.toThrow(/permission denied/);
      }
      await db.exec('reset role');
    }
    await db.exec(`reset role`);
    await db.exec(`set role service_role`);
    for (const table of ['mcp_engineering_issues', 'mcp_engineering_requests']) {
      await expect(db.query(`select * from mcp_internal.${table}`)).rejects.toThrow(/permission denied/);
    }
    await db.exec('reset role');
    await db.exec(`select set_config('request.jwt.claim.role','service_role',false)`);
  });

  it('RLS is forced and permission rows are the exact 12-name allowlist', async () => {
    const tables = await db.query<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>(
      `select relrowsecurity, relforcerowsecurity from pg_class where relname in ('mcp_engineering_issues','mcp_engineering_requests')`,
    );
    expect(tables.rows.every((r) => r.relrowsecurity && r.relforcerowsecurity)).toBe(true);
    const grants = await db.query<{ permission_pattern: string }>(
      `select permission_pattern from mcp_internal.mcp_bot_permissions where bot_id='bot_engineering' order by 1`,
    );
    expect(grants.rows.map((r) => r.permission_pattern)).toEqual([
      'engineering.create_issue',
      'engineering.get_deployment_status',
      'engineering.get_issue',
      'engineering.get_release_status',
      'workflow.assign_task',
      'workflow.complete_task',
      'workflow.create_approval',
      'workflow.create_task',
      'workflow.get_activity',
      'workflow.get_pending_approvals',
      'workflow.get_task',
      'workflow.list_tasks',
    ]);
  });

  it('Bot RPC sources require active bot + client grant and never can_access_client', async () => {
    const functions = await db.query<{ def: string }>(
      `select pg_get_functiondef(p.oid) def from pg_proc p join pg_namespace n on n.oid=p.pronamespace
        where (n.nspname='public' and p.proname like 'mcp_engineering_%')
           or (n.nspname='mcp_internal' and p.proname like 'engineering_%')`,
    );
    expect(functions.rows.length).toBeGreaterThan(0);
    for (const row of functions.rows) {
      expect(row.def).toContain('require_active_bot');
      expect(row.def).toContain('require_bot_client_grant');
      expect(row.def).not.toContain('can_access_client');
    }
  });
});

describe('Phase 15 Security DevOps isolation', () => {
  const PAGE_A = 'aaaaaaa1-aaaa-4aaa-8aaa-aaaaaaaaaaa1';
  const JOB_A = 'aaaaaaa2-aaaa-4aaa-8aaa-aaaaaaaaaaa2';
  const JOB_GLOBAL = 'ccccccc2-cccc-4ccc-8ccc-ccccccccccc2';
  const create = async (
    client = CLIENT_A,
    execution = 'sec-create',
    bot = 'bot_security_devops',
    title = 'Open redirect',
    severity = 'medium',
    kind = 'finding',
  ) => {
    const q = await db.query<{ result: any }>(
      `select public.mcp_security_create_finding($1,$2,'request-15',$3,$4,null,$5,$6) result`,
      [bot, client, execution, title, severity, kind],
    );
    return q.rows[0]!.result;
  };
  beforeEach(async () => {
    await db.exec(`
      insert into mcp_bot_clients(bot_id,client_id) values
        ('bot_security_devops','${CLIENT_A}'),
        ('bot_engineering','${CLIENT_A}');
      insert into client_pages (id,client_id,page_type,title,status,published_url,body) values
        ('${PAGE_A}','${CLIENT_A}','landing','Harbour Home','approved','https://example.test/h','SECRET BODY');
      insert into agent_jobs (id,agent_key,client_id,status,params,cost_usd,error) values
        ('${JOB_A}','landing_page','${CLIENT_A}','completed','{"token":"SECRET"}',9.99,'SECRET ERR');
      insert into agent_jobs (id,agent_key,client_id,status) values
        ('${JOB_GLOBAL}','landing_page',null,'queued');
    `);
  });

  it('same-client finding create/list and system status omit secrets and unscoped jobs', async () => {
    const made = await create();
    expect(made.finding.created_by_bot).toBe('bot_security_devops');
    expect((await db.query('select * from mcp_internal.mcp_security_findings')).rows).toHaveLength(1);
    const open = (await db.query<{ result: any }>(
      `select mcp_security_get_open_findings('bot_security_devops',$1) result`,
      [CLIENT_A],
    )).rows[0]!.result;
    expect(open.findings).toHaveLength(1);
    expect(open.findings[0].id).toBe(made.finding.id);
    const status = (await db.query<{ result: any }>(
      `select mcp_security_get_system_status('bot_security_devops',$1) result`,
      [CLIENT_A],
    )).rows[0]!.result;
    expect(status.projection).toBe('security_system_status_v1');
    expect(status.open_findings).toBe(1);
    expect(status.jobs_by_status.completed).toBe(1);
    expect(status.jobs_by_status.queued).toBeUndefined();
    expect(JSON.stringify(status)).not.toMatch(/SECRET|9\.99/);
    const incidents = (await db.query<{ result: any }>(
      `select mcp_security_get_incident_status('bot_security_devops',$1) result`,
      [CLIENT_A],
    )).rows[0]!.result;
    expect(incidents.incidents).toHaveLength(0);
  });

  it('replay returns the saved finding; changed payload conflicts', async () => {
    const first = await create();
    const again = await create();
    expect(again.finding).toEqual(first.finding);
    expect(again.replayed).toBe(true);
    await expect(create(CLIENT_A, 'sec-create', 'bot_security_devops', 'Different')).rejects.toThrow(
      'idempotency_conflict',
    );
  });

  it('incident kind is not an open finding and wrong-kind ids are not found', async () => {
    const incident = await create(CLIENT_A, 'sec-incident', 'bot_security_devops', 'Live', 'high', 'incident');
    const open = (await db.query<{ result: any }>(
      `select mcp_security_get_open_findings('bot_security_devops',$1) result`,
      [CLIENT_A],
    )).rows[0]!.result;
    expect(open.findings).toHaveLength(0);
    const listed = (await db.query<{ result: any }>(
      `select mcp_security_get_incident_status('bot_security_devops',$1) result`,
      [CLIENT_A],
    )).rows[0]!.result;
    expect(listed.incidents[0].id).toBe(incident.finding.id);
    await expect(
      db.query(`select mcp_security_get_open_findings('bot_security_devops',$1,25,null,$2)`, [CLIENT_A, incident.finding.id]),
    ).rejects.toThrow('finding_not_found');
    const finding = await create(CLIENT_A, 'sec-finding-2', 'bot_security_devops', 'Bug');
    await expect(
      db.query(`select mcp_security_get_incident_status('bot_security_devops',$1,25,null,$2)`, [CLIENT_A, finding.finding.id]),
    ).rejects.toThrow('incident_not_found');
  });

  it('ungranted client, suspended bot and revoked grant deny', async () => {
    await expect(
      db.query(`select mcp_security_get_system_status('bot_security_devops',$1)`, [CLIENT_B]),
    ).rejects.toThrow('client_forbidden');
    await db.exec(`update mcp_internal.mcp_bots set status='suspended' where bot_id='bot_security_devops'`);
    await expect(
      db.query(`select mcp_security_get_system_status('bot_security_devops',$1)`, [CLIENT_A]),
    ).rejects.toThrow('bot_not_active');
    await db.exec(`update mcp_internal.mcp_bots set status='active' where bot_id='bot_security_devops'`);
    await db.exec(`delete from mcp_bot_clients where bot_id='bot_security_devops'`);
    await expect(create()).rejects.toThrow('client_forbidden');
  });

  it('missing and foreign finding ids are indistinguishable', async () => {
    const first = await create();
    await db.exec(`insert into mcp_bot_clients(bot_id,client_id) values('bot_security_devops','${CLIENT_B}')`);
    await expect(
      db.query(`select mcp_security_get_open_findings('bot_security_devops',$1,25,null,$2)`, [CLIENT_B, first.finding.id]),
    ).rejects.toThrow('finding_not_found');
    await expect(
      db.query(`select mcp_security_get_open_findings('bot_security_devops',$1,25,null,$2)`, [CLIENT_A, CLIENT_B]),
    ).rejects.toThrow('finding_not_found');
  });

  it('other bots cannot create or list findings; Engineering still has no security writes', async () => {
    await expect(create(CLIENT_A, 'eng-create', 'bot_engineering')).rejects.toThrow('bot_forbidden');
    await expect(create(CLIENT_A, 'prod-create', 'bot_production')).rejects.toThrow('bot_forbidden');
    await expect(
      db.query(`select mcp_security_get_system_status('bot_engineering',$1)`, [CLIENT_A]),
    ).rejects.toThrow('bot_forbidden');
  });

  it('removed exact permission denies even with security wildcard attempt', async () => {
    await expect(
      db.exec(
        `insert into mcp_internal.mcp_bot_permissions(bot_id,permission_pattern,granted_by)
         values('bot_security_devops','security.*','test')`,
      ),
    ).rejects.toThrow(/Phase 15: security\.\* wildcard is forbidden/);
    await db.exec(
      `delete from mcp_internal.mcp_bot_permissions where bot_id='bot_security_devops' and permission_pattern='security.create_finding'`,
    );
    await expect(create()).rejects.toThrow('bot_forbidden');
    await db.exec(
      `insert into mcp_internal.mcp_bot_permissions(bot_id,permission_pattern,granted_by)
       values('bot_security_devops','security.create_finding','phase-15:security-devops-allowlist')`,
    );
  });

  it('security tools cannot be granted outside bot_security_devops; destroy/secret grants deny', async () => {
    await expect(
      db.exec(
        `insert into mcp_internal.mcp_bot_permissions(bot_id,permission_pattern,granted_by)
         values('bot_engineering','security.create_finding','test')`,
      ),
    ).rejects.toThrow(/Phase 15: security tools must not be granted outside bot_security_devops/);
    await expect(
      db.exec(
        `insert into mcp_internal.mcp_bot_permissions(bot_id,permission_pattern,granted_by)
         values('bot_security_devops','secrets.dump','test')`,
      ),
    ).rejects.toThrow(/Phase 15: bot_security_devops must not hold destroy, secrets/);
    await expect(
      db.exec(
        `insert into mcp_internal.mcp_bot_permissions(bot_id,permission_pattern,granted_by)
         values('bot_security_devops','infra.destroy','test')`,
      ),
    ).rejects.toThrow(/Phase 15: bot_security_devops must not hold destroy, secrets/);
  });

  it('anon and authenticated cannot execute public wrappers; tables deny including service_role', async () => {
    const first = await create();
    for (const role of ['anon', 'authenticated']) {
      await db.exec(`set role ${role}`);
      for (const sql of [
        `select mcp_security_get_system_status('bot_security_devops','${CLIENT_A}')`,
        `select mcp_security_get_open_findings('bot_security_devops','${CLIENT_A}')`,
        `select mcp_security_create_finding('bot_security_devops','${CLIENT_A}','req','exec','Title',null,'low','finding')`,
        `select mcp_security_get_incident_status('bot_security_devops','${CLIENT_A}')`,
      ]) {
        await expect(db.query(sql)).rejects.toThrow(/permission denied/);
      }
      await db.exec('reset role');
    }
    await db.exec(`reset role`);
    await db.exec(`set role service_role`);
    for (const table of ['mcp_security_findings', 'mcp_security_requests']) {
      await expect(db.query(`select * from mcp_internal.${table}`)).rejects.toThrow(/permission denied/);
    }
    await db.exec('reset role');
    await db.exec(`select set_config('request.jwt.claim.role','service_role',false)`);
    expect(first.finding.id).toBeTruthy();
  });

  it('RLS is forced and permission rows are the exact 14-name allowlist', async () => {
    const tables = await db.query<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>(
      `select relrowsecurity, relforcerowsecurity from pg_class where relname in ('mcp_security_findings','mcp_security_requests')`,
    );
    expect(tables.rows.every((r) => r.relrowsecurity && r.relforcerowsecurity)).toBe(true);
    const grants = await db.query<{ permission_pattern: string }>(
      `select permission_pattern from mcp_internal.mcp_bot_permissions where bot_id='bot_security_devops' order by 1`,
    );
    expect(grants.rows.map((r) => r.permission_pattern)).toEqual([
      'engineering.get_deployment_status',
      'engineering.get_release_status',
      'security.create_finding',
      'security.get_incident_status',
      'security.get_open_findings',
      'security.get_system_status',
      'workflow.assign_task',
      'workflow.complete_task',
      'workflow.create_approval',
      'workflow.create_task',
      'workflow.get_activity',
      'workflow.get_pending_approvals',
      'workflow.get_task',
      'workflow.list_tasks',
    ]);
  });

  it('Bot RPC sources require active bot + client grant and never can_access_client', async () => {
    const functions = await db.query<{ def: string }>(
      `select pg_get_functiondef(p.oid) def from pg_proc p join pg_namespace n on n.oid=p.pronamespace
        where (n.nspname='public' and p.proname like 'mcp_security_%')
           or (n.nspname='mcp_internal' and (p.proname like 'security_%' or p.proname = 'require_security_permission'))`,
    );
    expect(functions.rows.length).toBeGreaterThan(0);
    for (const row of functions.rows) {
      expect(row.def).toContain('require_active_bot');
      expect(row.def).toContain('require_bot_client_grant');
      expect(row.def).not.toContain('can_access_client');
    }
  });
});

describe('Phase 16 Conversion + Campaign Execution isolation', () => {
  const PAGE_A = 'aaaaaaa1-aaaa-4aaa-8aaa-aaaaaaaaaaa1';
  const CAMP_A = 'aaaaaaa3-aaaa-4aaa-8aaa-aaaaaaaaaaa3';
  const FINDING_A = 'aaaaaaa4-aaaa-4aaa-8aaa-aaaaaaaaaaa4';

  beforeEach(async () => {
    await db.exec(`
      insert into mcp_bot_clients(bot_id,client_id) values
        ('bot_marketing','${CLIENT_A}'),
        ('bot_chief_of_staff','${CLIENT_A}'),
        ('bot_client_delivery','${CLIENT_A}');
      insert into client_pages (id,client_id,page_type,title,status,html,body,current_revision) values
        ('${PAGE_A}','${CLIENT_A}','landing','Harbour Home','approved','<html>SECRET</html>','SECRET BODY',1);
      insert into client_page_revisions (client_id,page_id,revision_number,html,body,source,summary) values
        ('${CLIENT_A}','${PAGE_A}',1,'<html>SECRET</html>','SECRET BODY','initial_generation','Original');
      insert into client_page_findings (id,client_id,page_id,revision_number,category,severity,title,explanation,classification,status) values
        ('${FINDING_A}','${CLIENT_A}','${PAGE_A}',1,'copy','medium','Headline','Fix','FIXABLE','open');
      insert into client_campaigns (id,client_id,name,brief,status,built_at,needs_landing_page) values
        ('${CAMP_A}','${CLIENT_A}','Harbour launch','Win winter','planning',now(),true);
    `);
  });

  const conversion = (
    bot: string,
    client: string,
    action: string,
    extra: unknown[] = [],
  ) =>
    db.query<{ result: any }>(
      `select public.mcp_conversion($1,$2,$3,$4,25,null,$5,$6,$7,$8,$9,$10,$11,$12,$13) result`,
      [
        bot,
        client,
        action,
        extra[0] ?? null,
        extra[1] ?? null,
        extra[2] ?? null,
        extra[3] ?? null,
        extra[4] ?? null,
        extra[5] ?? null,
        extra[6] ?? null,
        extra[7] ?? null,
        extra[8] ?? null,
        extra[9] ?? null,
      ],
    );

  const campaign = (
    bot: string,
    client: string,
    action: string,
    extra: unknown[] = [],
  ) =>
    db.query<{ result: any }>(
      `select public.mcp_campaign_execution($1,$2,$3,$4,25,null,$5,$6,$7,$8,$9,$10,$11) result`,
      [
        bot,
        client,
        action,
        extra[0] ?? null,
        extra[1] ?? null,
        extra[2] ?? null,
        extra[3] ?? null,
        extra[4] ?? null,
        extra[5] ?? null,
        extra[6] ?? null,
        extra[7] ?? null,
      ],
    );

  it('Marketing lists pages without HTML; CoS is forbidden on conversion', async () => {
    const listed = (await conversion('bot_marketing', CLIENT_A, 'list_pages')).rows[0]!.result;
    expect(listed.pages).toHaveLength(1);
    expect(listed.pages[0].id).toBe(PAGE_A);
    expect(JSON.stringify(listed)).not.toMatch(/SECRET|<html>/);
    await expect(conversion('bot_chief_of_staff', CLIENT_A, 'list_pages')).rejects.toThrow(
      'bot_forbidden',
    );
    await expect(conversion('bot_marketing', CLIENT_B, 'list_pages')).rejects.toThrow(
      'client_forbidden',
    );
  });

  it('create_page queues landing_page and replays; changed payload conflicts', async () => {
    const args = [
      null, null, 'Winter', 'Sell the plan', null, null, null, null, 'req-16', 'exec-16',
    ];
    const first = (await conversion('bot_marketing', CLIENT_A, 'create_page', args)).rows[0]!.result;
    expect(first.job_id).toBeTruthy();
    const again = (await conversion('bot_marketing', CLIENT_A, 'create_page', args)).rows[0]!.result;
    expect(again.replayed).toBe(true);
    expect(again.page.id).toBe(first.page.id);
    await expect(
      conversion('bot_marketing', CLIENT_A, 'create_page', [
        null, null, 'Different', 'Sell the plan', null, null, null, null, 'req-16', 'exec-16',
      ]),
    ).rejects.toThrow('idempotency_conflict');
  });

  it('campaign list/get bind to client_campaigns; CoS and Marketing can read', async () => {
    const listed = (await campaign('bot_chief_of_staff', CLIENT_A, 'list')).rows[0]!.result;
    expect(listed.projection).toBe('client_campaigns_execution_v1');
    expect(listed.campaigns[0].id).toBe(CAMP_A);
    const got = (await campaign('bot_marketing', CLIENT_A, 'get', [CAMP_A])).rows[0]!.result;
    expect(got.campaign.name).toBe('Harbour launch');
    await expect(campaign('bot_chief_of_staff', CLIENT_A, 'get', [CLIENT_B])).rejects.toThrow(
      'campaign_not_found',
    );
  });

  it('CDM cannot write campaigns; conversion wildcard inserts deny', async () => {
    await expect(
      campaign('bot_client_delivery', CLIENT_A, 'create', [
        null, 'Nope', 'Forbidden', null, null, null, 'req-cdm', 'exec-cdm',
      ]),
    ).rejects.toThrow('bot_forbidden');
    await expect(
      db.exec(
        `insert into mcp_internal.mcp_bot_permissions(bot_id,permission_pattern,granted_by)
         values('bot_marketing','conversion.*','test')`,
      ),
    ).rejects.toThrow(/Phase 16: conversion\.\* wildcard is forbidden/);
    await expect(
      db.exec(
        `insert into mcp_internal.mcp_bot_permissions(bot_id,permission_pattern,granted_by)
         values('bot_engineering','conversion.list_pages','test')`,
      ),
    ).rejects.toThrow(/Phase 16: conversion tools must not be granted outside bot_marketing/);
    await expect(
      db.exec(
        `insert into mcp_internal.mcp_bot_permissions(bot_id,permission_pattern,granted_by)
         values('bot_production','conversion.list_pages','test')`,
      ),
    ).rejects.toThrow(/CoS: bot_production must not have finance, security, deploy or conversion grants/);
  });

  it('Marketing permission rows are the post-#48+#46 additive 45-name allowlist', async () => {
    const grants = await db.query<{ n: number }>(
      `select count(*)::int n from mcp_internal.mcp_bot_permissions where bot_id='bot_marketing'`,
    );
    expect(grants.rows[0]?.n).toBe(45);
    const phase9 = await db.query<{ n: number }>(
      `select count(*)::int n from mcp_internal.mcp_bot_permissions
        where bot_id='bot_marketing' and granted_by='alex-locked:phase-9'`,
    );
    expect(phase9.rows[0]?.n).toBe(23);
    const phase16 = await db.query<{ n: number }>(
      `select count(*)::int n from mcp_internal.mcp_bot_permissions
        where bot_id='bot_marketing' and granted_by='alex-locked:phase-16'`,
    );
    expect(phase16.rows[0]?.n).toBe(17);
    const wild = await db.query<{ n: number }>(
      `select count(*)::int n from mcp_internal.mcp_bot_permissions
        where bot_id='bot_marketing' and permission_pattern in ('conversion.*','campaign.*','content.*')`,
    );
    expect(wild.rows[0]?.n).toBe(0);
  });

  it('Bot RPC sources require active bot + client grant and never can_access_client', async () => {
    const functions = await db.query<{ def: string }>(
      `select pg_get_functiondef(p.oid) def from pg_proc p join pg_namespace n on n.oid=p.pronamespace
        where (n.nspname='public' and p.proname in ('mcp_conversion','mcp_campaign_execution'))
           or (n.nspname='mcp_internal' and p.proname in
             ('require_conversion_permission','require_campaign_execution_permission'))`,
    );
    expect(functions.rows.length).toBeGreaterThan(0);
    for (const row of functions.rows) {
      expect(row.def).toContain('require_active_bot');
      expect(row.def).toContain('require_bot_client_grant');
      expect(row.def).not.toContain('can_access_client');
    }
  });
});
describe('Phase 16b Sales attach/enable/build + Proof Bank + production assign/submit', () => {
  const AGENT_A = 'aaaa1601-aaaa-4aaa-8aaa-aaaaaaaaaaa1';
  const AGENT_B = 'bbbb1601-bbbb-4bbb-8bbb-bbbbbbbbbbb1';
  const PAGE_A = 'aaaa1602-aaaa-4aaa-8aaa-aaaaaaaaaaa2';
  const PAGE_B = 'bbbb1602-bbbb-4bbb-8bbb-bbbbbbbbbbb2';
  const BRIEF_A = 'aaaa1603-aaaa-4aaa-8aaa-aaaaaaaaaaa3';
  const MEMBER_A = 'aaaa1604-aaaa-4aaa-8aaa-aaaaaaaaaaa4';
  const PROOF_B = 'bbbb1605-bbbb-4bbb-8bbb-bbbbbbbbbbb5';

  const attach = (
    overrides: Partial<{ bot: string; client: string; agent: string; page: string; execution: string }> = {},
  ) => db.query<{ result: any }>(
    'select mcp_attach_sales_agent_to_page($1,$2,$3,$4,$5,$6) as result',
    [
      overrides.bot ?? 'bot_sales_ops', 'attach-req', overrides.execution ?? 'attach-exec',
      overrides.client ?? CLIENT_A, overrides.agent ?? AGENT_A, overrides.page ?? PAGE_A,
    ],
  );
  const enable = (
    overrides: Partial<{ bot: string; client: string; deployment: string; enabled: boolean; execution: string }> = {},
  ) => db.query<{ result: any }>(
    'select mcp_set_sales_agent_deployment_enabled($1,$2,$3,$4,$5,$6) as result',
    [
      overrides.bot ?? 'bot_sales_ops', 'enable-req', overrides.execution ?? 'enable-exec',
      overrides.client ?? CLIENT_A, overrides.deployment, overrides.enabled ?? true,
    ],
  );
  const build = (
    overrides: Partial<{ bot: string; client: string; agent: string; execution: string }> = {},
  ) => db.query<{ result: any }>(
    'select mcp_build_sales_agent($1,$2,$3,$4,$5) as result',
    [
      overrides.bot ?? 'bot_sales_ops', 'build-req', overrides.execution ?? 'build-exec',
      overrides.client ?? CLIENT_A, overrides.agent ?? AGENT_A,
    ],
  );

  beforeEach(async () => {
    await db.exec(`
      insert into mcp_bot_clients (bot_id, client_id) values
        ('bot_sales_ops', '${CLIENT_A}'),
        ('bot_production', '${CLIENT_A}')
      on conflict do nothing;
      insert into client_pages (id, client_id, page_type, title, status, published_url, publish_status) values
        ('${PAGE_A}', '${CLIENT_A}', 'landing', 'Harbour Home', 'approved', 'https://harbour.example.test/offer', 'published'),
        ('${PAGE_B}', '${CLIENT_B}', 'landing', 'Other Home', 'approved', 'https://other.example.test/offer', 'published');
      insert into client_sales_agents
        (id, client_id, name, purpose, status, role, built_at, approved_at) values
        ('${AGENT_A}', '${CLIENT_A}', 'Closer A', 'Qualify', 'live', 'inbound_qualifier', now(), now()),
        ('${AGENT_B}', '${CLIENT_B}', 'Closer B', 'Qualify', 'live', 'inbound_qualifier', now(), now());
      insert into client_briefs (id, client_id, title, body, status, media_type)
        values ('${BRIEF_A}', '${CLIENT_A}', 'Brief A', 'Body', 'approved', 'image');
      insert into team_members (id, category, name, initials)
        values ('${MEMBER_A}', 'editors', 'Editor A', 'EA')
        on conflict (id) do update set active = true, category = 'editors';
      insert into client_proof_assets (id, client_id, media_type, title, body, claim, usage_rights, strength)
        values
          ('${PROOF_B}', '${CLIENT_B}', 'text', 'Other proof', 'Secret body', 'other claim', 'approved', 'high');
    `);
  });

  it('every new write RPC uses require_active_bot + require_bot_client_grant, never can_access_client', async () => {
    const signatures = [
      'mcp_internal.attach_sales_agent_to_page(text,text,text,uuid,uuid,uuid)',
      'mcp_internal.set_sales_agent_deployment_enabled(text,text,text,uuid,uuid,boolean)',
      'mcp_internal.build_sales_agent(text,text,text,uuid,uuid)',
      'mcp_internal.proof_create(text,text,text,uuid,text,text,text,text,text,text,text,text,text,text)',
      'mcp_internal.proof_attach_asset(text,text,text,uuid,uuid,text,uuid)',
      'mcp_internal.assign_production(text,text,text,uuid,uuid,text,uuid[],date,numeric,text,text)',
      'mcp_internal.submit_asset(text,text,text,uuid,text,text,uuid,uuid,text)',
      'mcp_internal.create_upload_url(text,text,text,uuid,uuid,text,text,integer)',
    ];
    for (const sig of signatures) {
      const src = await db.query<{ def: string }>(`select pg_get_functiondef('${sig}'::regprocedure) as def`);
      expect(src.rows[0]?.def, sig).toContain('require_active_bot');
      expect(src.rows[0]?.def, sig).toContain('require_bot_client_grant');
      expect(src.rows[0]?.def, sig).toContain('bot_forbidden');
      expect(src.rows[0]?.def, sig).not.toMatch(/can_access_client\s*\(/);
    }
  });

  it('attach inserts enabled:false with origin from published URL and refuses an unready agent', async () => {
    const first = (await attach()).rows[0]!.result;
    expect(first.enabled).toBe(false);
    expect(first.allowed_origin).toBe('https://harbour.example.test');
    expect(first.replayed).toBe(false);
    const replay = (await attach()).rows[0]!.result;
    expect(replay.replayed).toBe(true);
    expect(replay.id).toBe(first.id);
    await expect(attach({ page: PAGE_A, execution: 'attach-again' })).rejects.toThrow('already_attached');
    await db.exec(`update client_sales_agents set approved_at = null where id = '${AGENT_A}'`);
    await expect(attach({ execution: 'attach-unapproved' })).rejects.toThrow('agent_not_ready');
  });

  it('set_deployment_enabled toggles the kill-switch and conflicts when another page deployment is live', async () => {
    const first = (await attach()).rows[0]!.result;
    const on = (await enable({ deployment: first.id })).rows[0]!.result;
    expect(on.enabled).toBe(true);
    expect(on.disabled_at).toBeNull();
    expect(on.deployed_at).toBeTruthy();
    const off = (await enable({ deployment: first.id, enabled: false, execution: 'enable-off' })).rows[0]!.result;
    expect(off.enabled).toBe(false);
    expect(off.disabled_at).toBeTruthy();
    await expect(enable({ deployment: first.id, client: CLIENT_B, execution: 'enable-cross' }))
      .rejects.toThrow('client_forbidden');
  });

  it('build enqueues a sales_agent job for the granted client only', async () => {
    const first = (await build()).rows[0]!.result;
    expect(first.job_id).toMatch(/^[0-9a-f-]{36}$/i);
    expect(first.replayed).toBe(false);
    const replay = (await build()).rows[0]!.result;
    expect(replay.replayed).toBe(true);
    expect(replay.job_id).toBe(first.job_id);
    await expect(build({ agent: AGENT_B, execution: 'build-mismatch' })).rejects.toThrow('client_mismatch');
    await expect(build({ client: CLIENT_B, agent: AGENT_B, execution: 'build-forbidden' }))
      .rejects.toThrow('client_forbidden');
  });

  it('proof search/get see uncleared rows; get_for_avatar/claim only return human-cleared unexpired proof', async () => {
    const created = (await db.query<{ result: any }>(
      `select mcp_proof_create('bot_production','req-p','exec-p','${CLIENT_A}','text','Review','A Google review.','Google',null,'We finish on time',null,null,'testimonial','high') as result`,
    )).rows[0]!.result;
    expect(created.usage_rights).toBe('not_cleared');
    const searched = (await db.query<{ result: any }>(
      `select mcp_proof_search('bot_production','${CLIENT_A}',25,null,null,null) as result`,
    )).rows[0]!.result;
    expect(searched.count).toBeGreaterThanOrEqual(1);
    expect(searched.proof.some((p: any) => p.id === created.id)).toBe(true);
    const avatar = (await db.query<{ result: any }>(
      `select mcp_proof_get_for_avatar('bot_production','${CLIENT_A}','owner',10) as result`,
    )).rows[0]!.result;
    expect(avatar.proof.every((p: any) => p.usage_rights === 'approved')).toBe(true);
    expect(avatar.proof.some((p: any) => p.id === created.id)).toBe(false);
    await db.exec(`update client_proof_assets set usage_rights = 'approved' where id = '${created.id}'`);
    const cleared = (await db.query<{ result: any }>(
      `select mcp_proof_get_for_claim('bot_production','${CLIENT_A}','finish on time',10) as result`,
    )).rows[0]!.result;
    expect(cleared.proof.some((p: any) => p.id === created.id)).toBe(true);
    await expect(db.query(
      `select mcp_proof_get('bot_production','${CLIENT_A}','${PROOF_B}')`,
    )).rejects.toThrow('client_mismatch');
  });

  it('proof.create ignores Bot clearance: usage_rights stays not_cleared and attach never writes rights', async () => {
    const created = (await db.query<{ result: any }>(
      `select mcp_proof_create('bot_production','req-c','exec-c','${CLIENT_A}','image','Photo',null,'site','clients/a.png','Claim',null,null,null,'medium') as result`,
    )).rows[0]!.result;
    expect(created.usage_rights).toBe('not_cleared');
    const attached = (await db.query<{ result: any }>(
      `select mcp_proof_attach_asset('bot_production','req-a','exec-a','${CLIENT_A}','${created.id}','clients/b.png',null) as result`,
    )).rows[0]!.result;
    expect(attached.storage_path).toBe('clients/b.png');
    expect(attached.usage_rights).toBe('not_cleared');
    await expect(db.query(
      `select mcp_proof_create('bot_sales_ops','req-s','exec-s','${CLIENT_A}','text','x','body',null,null,null,null,null,null,'medium')`,
    )).rejects.toThrow('bot_forbidden');
  });

  it('assign_production AI enqueues creative_build; human requires an editor/avatar; submit_asset files pending media', async () => {
    const assigned = (await db.query<{ result: any }>(
      `select mcp_assign_production('bot_production','req-as','exec-as','${CLIENT_A}','${BRIEF_A}','ai',null,null,null,'medium','1024x1536') as result`,
    )).rows[0]!.result;
    expect(assigned.route).toBe('ai');
    expect(assigned.job_id).toBeTruthy();
    expect(assigned.generation_id).toBeTruthy();
    expect(assigned.render_id).toBeTruthy();
    const job = (await db.query<{ params: any; input_table: string; input_id: string }>(
      `select params, input_table, input_id from agent_jobs where id = '${assigned.job_id}'`,
    )).rows[0]!;
    expect(job.params).toEqual({ render_id: assigned.render_id });
    expect(job.input_table).toBe('creative_renders');
    expect(job.input_id).toBe(assigned.render_id);
    const renders = (await db.query<{ n: number; job_id: string }>(
      `select count(*)::int as n, min(job_id::text) as job_id from creative_renders
        where generation_id = '${assigned.generation_id}'`,
    )).rows[0]!;
    expect(renders.n).toBe(1);
    expect(renders.job_id).toBe(assigned.job_id);
    const submitted = (await db.query<{ result: any }>(
      `select mcp_submit_asset('bot_production','req-sub','exec-sub','${CLIENT_A}','clients/out.png','image','${BRIEF_A}',null,'Cut') as result`,
    )).rows[0]!.result;
    expect(submitted.review_status).toBe('pending');
    expect(submitted.asset_id).toBeTruthy();
    await expect(db.query(
      `select mcp_assign_production('bot_sales_ops','req-x','exec-x','${CLIENT_A}','${BRIEF_A}','ai',null,null,null,'medium','1024x1536')`,
    )).rejects.toThrow('bot_forbidden');
    await db.exec(`update client_briefs set status = 'approved', media_type = 'video' where id = '${BRIEF_A}'`);
    await expect(db.query(
      `select mcp_assign_production('bot_production','req-vid','exec-vid','${CLIENT_A}','${BRIEF_A}','ai',null,null,null,'medium','1024x1536')`,
    )).rejects.toThrow('invalid_production_route');
    const human = (await db.query<{ result: any }>(
      `select mcp_assign_production('bot_production','req-h','exec-h','${CLIENT_A}','${BRIEF_A}','human',array['${MEMBER_A}']::uuid[],null,null,'medium','1024x1536') as result`,
    )).rows[0]!.result;
    expect(human.route).toBe('human');
    expect(human.assigned).toBe(1);
  });

  it('permission rows: sales ops is exactly 28 after mig 90+91 (25+brand/sites)', async () => {
    const n = (await db.query<{ n: number }>(
      `select count(*)::int as n from mcp_internal.mcp_bot_permissions where bot_id = 'bot_sales_ops'`,
    )).rows[0]?.n;
    expect(n).toBe(28);
    const forbidden = (await db.query<{ n: number }>(
      `select count(*)::int as n from mcp_internal.mcp_bot_permissions
        where bot_id = 'bot_sales_ops'
          and permission_pattern in ('sales_agents.deploy', 'pipeline.record_sale', 'proof.search', 'proof.get')`,
    )).rows[0]?.n;
    expect(forbidden).toBe(0);
    const proofWrites = (await db.query<{ n: number }>(
      `select count(*)::int as n from mcp_internal.mcp_bot_permissions
        where bot_id = 'bot_production'
          and permission_pattern in ('proof.create', 'proof.attach_asset')`,
    )).rows[0]?.n;
    expect(proofWrites).toBe(2);
    await expect(db.exec(
      `insert into mcp_internal.mcp_bot_permissions (bot_id, permission_pattern, granted_by)
       values ('bot_sales_ops', 'proof.create', 'test')`,
    )).rejects.toThrow(/Phase 16b: proof/);
    await expect(db.exec(
      `insert into mcp_internal.mcp_bot_permissions (bot_id, permission_pattern, granted_by)
       values ('bot_sales_ops', 'sales_agents.deploy', 'test')`,
    )).rejects.toThrow(/Phase 11b: bot_sales_ops must not hold/);
  });
});

describe('Phase 16c Attribution Brand Sites isolation', () => {
  const PAGE_A = 'aaaaaaa1-aaaa-4aaa-8aaa-aaaaaaaaaaa1';
  const PAGE_B = 'bbbbbbb1-bbbb-4bbb-8bbb-bbbbbbbbbbb1';
  const ASSET_A = 'aaaaaaa3-aaaa-4aaa-8aaa-aaaaaaaaaaa3';
  const n = (v: unknown) => Number(v);

  beforeEach(async () => {
    await db.exec(`
      truncate client_brand_profiles, client_marketing_spend, client_media_assets, client_pages, client_leads cascade;
      insert into mcp_bot_clients(bot_id,client_id) values
        ('bot_marketing','${CLIENT_A}'),
        ('bot_sales_ops','${CLIENT_A}'),
        ('bot_distribution','${CLIENT_A}'),
        ('bot_engineering','${CLIENT_A}');
      insert into client_pages (id,client_id,page_type,title,status) values
        ('${PAGE_A}','${CLIENT_A}','landing','Harbour Home','approved'),
        ('${PAGE_B}','${CLIENT_B}','landing','Other Home','draft');
    `);
  });

  it('empty funnel returns zeros and null ratios, never invented numbers', async () => {
    const row = (await db.query<{ result: any }>(
      `select mcp_attribution_conversion_funnel('bot_marketing',$1,30) result`,
      [CLIENT_A],
    )).rows[0]!.result;
    expect(row.projection).toBe('acquisition_funnel_v1');
    expect(n(row.funnel.leads)).toBe(0);
    expect(n(row.funnel.sales)).toBe(0);
    expect(n(row.funnel.spend)).toBe(0);
    expect(row.funnel.lead_to_sale_pct).toBeNull();
    expect(row.funnel.cost_per_lead).toBeNull();
    expect(row.funnel.return_on_spend).toBeNull();
  });

  it('funnel counts match inserted leads and spend; ratios stay null when spend is zero', async () => {
    await db.exec(`
      insert into client_leads (client_id, name, stage, sale_value, cash_collected)
        values ('${CLIENT_A}','Lead','lead',0,0),
               ('${CLIENT_A}','Sold','sale',100,80);
      insert into client_marketing_spend (client_id, amount, spent_on)
        values ('${CLIENT_A}', 40, current_date);
    `);
    const row = (await db.query<{ result: any }>(
      `select mcp_attribution_conversion_funnel('bot_marketing',$1,30) result`,
      [CLIENT_A],
    )).rows[0]!.result;
    expect(n(row.funnel.leads)).toBe(2);
    expect(n(row.funnel.sales)).toBe(1);
    expect(n(row.funnel.spend)).toBe(40);
    expect(n(row.funnel.lead_to_sale_pct)).toBe(50);
    expect(n(row.funnel.cost_per_lead)).toBe(20);
  });

  it('empty content performance returns items: []', async () => {
    const row = (await db.query<{ result: any }>(
      `select mcp_attribution_content_performance('bot_distribution',$1,10) result`,
      [CLIENT_A],
    )).rows[0]!.result;
    expect(row.projection).toBe('content_attribution_v1');
    expect(row.items).toEqual([]);
  });

  it('content performance lists the client asset with zero metrics when none exist', async () => {
    await db.exec(`
      insert into client_media_assets (id, client_id, media_type, title, storage_path, review_status)
        values ('${ASSET_A}','${CLIENT_A}','image','Hook','assets/hook.png','approved');
    `);
    const row = (await db.query<{ result: any }>(
      `select mcp_attribution_content_performance('bot_marketing',$1,10) result`,
      [CLIENT_A],
    )).rows[0]!.result;
    expect(row.items).toHaveLength(1);
    expect(row.items[0].asset_id).toBe(ASSET_A);
    expect(n(row.items[0].leads)).toBe(0);
    expect(n(row.items[0].cash_collected)).toBe(0);
  });

  it('missing brand profile is found=false with null profile', async () => {
    const row = (await db.query<{ result: any }>(
      `select mcp_brand_get_profile('bot_production',$1) result`,
      [CLIENT_A],
    )).rows[0]!.result;
    expect(row.found).toBe(false);
    expect(row.profile).toBeNull();
  });

  it('brand profile returns stored colours and never_do; nulls stay null', async () => {
    await db.exec(`
      insert into client_brand_profiles (client_id, colour_primary, mood, never_do)
        values ('${CLIENT_A}','#112233','calm','never a handshake');
    `);
    const row = (await db.query<{ result: any }>(
      `select mcp_brand_get_profile('bot_marketing',$1) result`,
      [CLIENT_A],
    )).rows[0]!.result;
    expect(row.found).toBe(true);
    expect(row.profile.colour_primary).toBe('#112233');
    expect(row.profile.mood).toBe('calm');
    expect(row.profile.never_do).toBe('never a handshake');
    expect(row.profile.colour_secondary).toBeNull();
    expect(row.profile.font_heading).toBeNull();
  });

  it('sites authorize allows marketing/sales_ops and binds publish to the client page', async () => {
    const provision = (await db.query<{ result: any }>(
      `select mcp_sites_authorize('bot_marketing',$1,'sites.provision',null) result`,
      [CLIENT_A],
    )).rows[0]!.result;
    expect(provision.authorized).toBe(true);
    const published = (await db.query<{ result: any }>(
      `select mcp_sites_authorize('bot_sales_ops',$1,'sites.publish_page',$2) result`,
      [CLIENT_A, PAGE_A],
    )).rows[0]!.result;
    expect(published.page_id).toBe(PAGE_A);
  });

  it('ungranted client, foreign page, engineering and other bots deny', async () => {
    await expect(
      db.query(`select mcp_attribution_conversion_funnel('bot_marketing',$1,30)`, [CLIENT_B]),
    ).rejects.toThrow('client_forbidden');
    await expect(
      db.query(`select mcp_brand_get_profile('bot_engineering',$1)`, [CLIENT_A]),
    ).rejects.toThrow('bot_forbidden');
    await db.exec(`insert into mcp_bot_clients(bot_id,client_id) values('bot_finance','${CLIENT_A}')`);
    await expect(
      db.query(`select mcp_brand_get_profile('bot_finance',$1)`, [CLIENT_A]),
    ).rejects.toThrow('bot_forbidden');
    await expect(
      db.query(`select mcp_sites_authorize('bot_engineering',$1,'sites.provision',null)`, [CLIENT_A]),
    ).rejects.toThrow('bot_forbidden');
    await expect(
      db.query(`select mcp_sites_authorize('bot_marketing',$1,'sites.publish_page',$2)`, [CLIENT_A, PAGE_B]),
    ).rejects.toThrow('page_not_found');
    await expect(
      db.query(`select mcp_sites_authorize('bot_marketing',$1,'sites.publish_page',null)`, [CLIENT_A]),
    ).rejects.toThrow('invalid_request');
  });

  it('suspended bot and revoked grant deny', async () => {
    await db.exec(`update mcp_internal.mcp_bots set status='suspended' where bot_id='bot_marketing'`);
    await expect(
      db.query(`select mcp_attribution_conversion_funnel('bot_marketing',$1,30)`, [CLIENT_A]),
    ).rejects.toThrow('bot_not_active');
    await db.exec(`update mcp_internal.mcp_bots set status='active' where bot_id='bot_marketing'`);
    await db.exec(`delete from mcp_bot_clients where bot_id='bot_marketing'`);
    await expect(
      db.query(`select mcp_brand_get_profile('bot_marketing',$1)`, [CLIENT_A]),
    ).rejects.toThrow('client_forbidden');
  });

  it('sites/brand wildcards and off-role grants are forbidden', async () => {
    await expect(
      db.exec(
        `insert into mcp_internal.mcp_bot_permissions(bot_id,permission_pattern,granted_by)
         values('bot_marketing','sites.*','test')`,
      ),
    ).rejects.toThrow(/Phase 16c: sites\.\* \/ brand\.\* wildcards are forbidden/);
    await expect(
      db.exec(
        `insert into mcp_internal.mcp_bot_permissions(bot_id,permission_pattern,granted_by)
         values('bot_admin','sites.provision','test')`,
      ),
    ).rejects.toThrow(/Phase 16c: sites tools must not be granted outside bot_marketing\/bot_sales_ops/);
    await expect(
      db.exec(
        `insert into mcp_internal.mcp_bot_permissions(bot_id,permission_pattern,granted_by)
         values('bot_engineering','sites.provision','test')`,
      ),
    ).rejects.toThrow(/Phase 14: bot_engineering must not hold deploy, secrets, infra, sites/);
    await expect(
      db.exec(
        `insert into mcp_internal.mcp_bot_permissions(bot_id,permission_pattern,granted_by)
         values('bot_finance','brand.get_profile','test')`,
      ),
    ).rejects.toThrow(/Phase 16c: brand.get_profile must not be granted outside/);
  });

  it('anon and authenticated cannot execute public wrappers', async () => {
    for (const role of ['anon', 'authenticated']) {
      await db.exec(`set role ${role}`);
      for (const sql of [
        `select mcp_attribution_conversion_funnel('bot_marketing','${CLIENT_A}',30)`,
        `select mcp_attribution_content_performance('bot_distribution','${CLIENT_A}',10)`,
        `select mcp_brand_get_profile('bot_marketing','${CLIENT_A}')`,
        `select mcp_sites_authorize('bot_marketing','${CLIENT_A}','sites.provision',null)`,
      ]) {
        await expect(db.query(sql)).rejects.toThrow(/permission denied/);
      }
      await db.exec('reset role');
    }
    await db.exec(`select set_config('request.jwt.claim.role','service_role',false)`);
  });

  it('permission rows match the Phase 16c ceilings', async () => {
    const marketing = await db.query<{ n: number }>(
      `select count(*)::int n from mcp_internal.mcp_bot_permissions where bot_id='bot_marketing'`,
    );
    expect(marketing.rows[0]!.n).toBe(45);
    const sales = await db.query<{ n: number }>(
      `select count(*)::int n from mcp_internal.mcp_bot_permissions where bot_id='bot_sales_ops'`,
    );
    expect(sales.rows[0]!.n).toBe(28);
    const brand = await db.query(
      `select 1 from mcp_internal.mcp_bot_permissions where bot_id='bot_production' and permission_pattern='brand.get_profile'`,
    );
    expect(brand.rows).toHaveLength(1);
    const engSites = await db.query(
      `select 1 from mcp_internal.mcp_bot_permissions where bot_id='bot_engineering' and permission_pattern like 'sites%'`,
    );
    expect(engSites.rows).toHaveLength(0);
  });

  it('Bot RPC sources require active bot + client grant and never can_access_client', async () => {
    const functions = await db.query<{ def: string }>(
      `select pg_get_functiondef(p.oid) def from pg_proc p join pg_namespace n on n.oid=p.pronamespace
        where (n.nspname='public' and p.proname in (
            'mcp_attribution_conversion_funnel','mcp_attribution_content_performance',
            'mcp_brand_get_profile','mcp_sites_authorize'
          ))
           or (n.nspname='mcp_internal' and p.proname in (
            'attribution_conversion_funnel','attribution_content_performance',
            'brand_get_profile','sites_authorize'
          ))`,
    );
    expect(functions.rows.length).toBeGreaterThan(0);
    for (const row of functions.rows) {
      expect(row.def).toContain('require_active_bot');
      expect(row.def).toContain('require_bot_client_grant');
      expect(row.def).not.toContain('can_access_client');
    }
  });
});

describe('content.create_upload_url', () => {
  const BRIEF = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const COS = 'bot_chief_of_staff';

  beforeEach(async () => {
    await db.exec(`
      insert into client_briefs (id, client_id, title, body, status, media_type)
        values ('${BRIEF}', '${CLIENT_A}', 'Pack', 'Body', 'draft', 'image');
      insert into mcp_bot_clients (bot_id, client_id) values ('${COS}', '${CLIENT_A}')
        on conflict do nothing;
      create schema if not exists storage;
      create table if not exists storage.objects (
        id uuid primary key default gen_random_uuid(),
        bucket_id text,
        name text,
        metadata jsonb
      );
      delete from storage.objects;
    `);
    await asService();
  });

  it('reserves a client-prefixed path for production and only an eligibility read for CoS', async () => {
    const minted = (await db.query<{ result: any }>(
      `select mcp_create_upload_url('bot_production','req-up','exec-up','${CLIENT_A}','${BRIEF}','image/png','pack-01.png',1200) as result`,
    )).rows[0]!.result;
    expect(minted.replayed).toBe(false);
    expect(minted.storage_path).toBe(`${CLIENT_A}/${minted.pending_asset_id}.png`);
    expect(minted.content_type).toBe('image/png');
    expect(minted.upload_url).toBeUndefined();
    const replay = (await db.query<{ result: any }>(
      `select mcp_create_upload_url('bot_production','req-up','exec-up','${CLIENT_A}','${BRIEF}','image/png','pack-01.png',1200) as result`,
    )).rows[0]!.result;
    expect(replay.replayed).toBe(true);
    expect(replay.pending_asset_id).toBe(minted.pending_asset_id);

    const checked = (await db.query<{ result: any }>(
      `select mcp_create_upload_url('${COS}','req-cos','exec-cos','${CLIENT_A}','${BRIEF}','image/png',null,null) as result`,
    )).rows[0]!.result;
    expect(checked).toEqual({
      client_id: CLIENT_A,
      brief_id: BRIEF,
      brief_status: 'draft',
      eligible: true,
      read_check: true,
    });
    await expect(db.query(
      `select mcp_create_upload_url('bot_marketing','req-m','exec-m','${CLIENT_A}','${BRIEF}','image/png',null,null)`,
    )).rejects.toThrow('bot_forbidden');
    await db.exec(`update client_briefs set status = 'complete' where id = '${BRIEF}'`);
    await expect(db.query(
      `select mcp_create_upload_url('bot_production','req-bad','exec-bad','${CLIENT_A}','${BRIEF}','image/png',null,null)`,
    )).rejects.toThrow('invalid_brief_status');
  });

  it('submit_asset consumes the reservation only after the object exists', async () => {
    const minted = (await db.query<{ result: any }>(
      `select mcp_create_upload_url('bot_production','req-up2','exec-up2','${CLIENT_A}','${BRIEF}','image/png','pack-02.png',800) as result`,
    )).rows[0]!.result;
    await expect(db.query(
      `select mcp_submit_uploaded_asset('bot_production','req-sub','exec-sub','${CLIENT_A}',null,'image','${BRIEF}',null,null,'${minted.pending_asset_id}')`,
    )).rejects.toThrow('bytes_missing');
    await db.exec(`
      insert into storage.objects (bucket_id, name, metadata)
      values ('client-media', '${minted.storage_path}', '{"size":800,"mimetype":"image/png"}'::jsonb);
    `);
    const submitted = (await db.query<{ result: any }>(
      `select mcp_submit_uploaded_asset('bot_production','req-sub','exec-sub','${CLIENT_A}',null,'image','${BRIEF}',null,'Cut','${minted.pending_asset_id}') as result`,
    )).rows[0]!.result;
    expect(submitted.review_status).toBe('pending');
    expect(submitted.storage_path).toBe(minted.storage_path);
    const consumed = (await db.query<{ consumed: boolean; asset: string }>(
      `select consumed_at is not null as consumed, asset_id::text as asset
         from mcp_internal.asset_upload_grants where id = '${minted.pending_asset_id}'`,
    )).rows[0]!;
    expect(consumed.consumed).toBe(true);
    expect(consumed.asset).toBe(submitted.asset_id);
    await expect(db.query(
      `select mcp_submit_uploaded_asset('bot_production','req-sub2','exec-sub2','${CLIENT_A}','${minted.storage_path}','image','${BRIEF}',null,null,null)`,
    )).rejects.toThrow('upload_consumed');
  });
});
