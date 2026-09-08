import { PGlite } from '@electric-sql/pglite';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const CLIENT = '11111111-1111-4111-8111-111111111111';
const HASH = createHash('sha256').update('x'.repeat(40)).digest('hex');
const HASH2 = createHash('sha256').update('y'.repeat(40)).digest('hex');
let db: PGlite;
const migration = async (file: string) => readFile(new URL(`../../../supabase/migrations/${file}`, import.meta.url), 'utf8');

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
  `);
  for (const file of [
    '20260908080000_63_mcp_brief_enqueue.sql',
    '20260908190000_65_mcp_bot_auth_registry.sql',
  ]) await db.exec(await migration(file));
}, 30_000);
afterAll(async () => { await db?.close(); });
beforeEach(async () => {
  await db.exec(`reset role;
    truncate mcp_internal.mcp_bot_token_audit, mcp_internal.mcp_bot_tokens, mcp_bot_clients, clients cascade;
    update mcp_internal.mcp_bots set status = 'active';
    select set_config('request.jwt.claim.role','service_role',false);
    select set_config('request.jwt.claim.sub','',false);
    insert into clients (id,name,initials) values ('${CLIENT}','First','FI');
    insert into mcp_bot_clients (bot_id, client_id) values ('bot_production', '${CLIENT}');
  `);
});

describe('mcp_internal bot auth registry', () => {
  it('matches exact tools and single-segment wildcards only', async () => {
    const q = (grant: string, tool: string) =>
      db.query<{ m: boolean }>('select mcp_internal.permission_matches($1,$2) as m', [grant, tool]);
    expect((await q('content.*', 'content.generate_brief')).rows[0]?.m).toBe(true);
    expect((await q('content.generate_brief', 'content.generate_brief')).rows[0]?.m).toBe(true);
    expect((await q('content.*', 'content.foo.bar')).rows[0]?.m).toBe(false);
    expect((await q('content.*', 'contentX.generate_brief')).rows[0]?.m).toBe(false);
    expect((await q('content.generate', 'content.generate_brief')).rows[0]?.m).toBe(false);
  });

  it('seeds all ten bots including bot_security_devops and enforces CoS prohibitions', async () => {
    const bots = await db.query<{ bot_id: string }>('select bot_id from mcp_internal.mcp_bots order by bot_id');
    expect(bots.rows.map((r) => r.bot_id)).toEqual([
      'bot_admin', 'bot_chief_of_staff', 'bot_client_delivery', 'bot_distribution',
      'bot_engineering', 'bot_finance', 'bot_marketing', 'bot_production',
      'bot_sales_ops', 'bot_security_devops',
    ]);
    const forbidden = await db.query<{ n: number }>(`
      select count(*)::int as n from mcp_internal.mcp_bot_permissions
      where (bot_id = 'bot_production' and (
          permission_pattern like 'economics%' or permission_pattern like 'security%'
          or permission_pattern like '%deploy%' or permission_pattern like 'finance%'
        ))
        or (bot_id = 'bot_finance' and permission_pattern like 'content%')
        or (bot_id = 'bot_security_devops' and (
          permission_pattern like 'economics%' or permission_pattern like 'finance%'
          or permission_pattern = 'attribution.get_revenue_attribution'
        ))
    `);
    expect(forbidden.rows[0]?.n).toBe(0);
  });

  it('issues, resolves, hard-cut rotates, and revokes by hash without returning plaintext', async () => {
    const issued = await db.query<{ result: { token_id: string; bot_id: string } }>(
      'select mcp_issue_bot_token($1,$2,$3,$4) as result',
      ['bot_production', HASH, 'operator', 'test'],
    );
    expect(issued.rows[0]?.result.bot_id).toBe('bot_production');
    const resolved = await db.query<{ result: Record<string, unknown> }>(
      'select mcp_resolve_bot_token($1) as result', [HASH],
    );
    expect(resolved.rows[0]?.result).toMatchObject({
      found: true, status: 'active', bot_id: 'bot_production',
    });
    expect(resolved.rows[0]?.result.clients).toEqual([CLIENT]);
    expect(resolved.rows[0]?.result.permissions).toEqual(expect.arrayContaining(['content.*']));
    expect(JSON.stringify(resolved.rows[0]?.result)).not.toContain(HASH);

    const rotated = await db.query<{ result: { token_id: string } }>(
      'select mcp_rotate_bot_token($1,$2,$3,$4) as result',
      [HASH, HASH2, 'operator', 'rotated'],
    );
    expect(rotated.rows[0]?.result.token_id).toBeTruthy();
    expect((await db.query<{ result: { status?: string; found: boolean } }>(
      'select mcp_resolve_bot_token($1) as result', [HASH],
    )).rows[0]?.result.status).toBe('revoked_token');
    expect((await db.query<{ result: { status?: string } }>(
      'select mcp_resolve_bot_token($1) as result', [HASH2],
    )).rows[0]?.result.status).toBe('active');

    await db.query('select mcp_revoke_bot_token($1,$2,$3)', [HASH2, 'operator', 'done']);
    expect((await db.query<{ result: { status?: string } }>(
      'select mcp_resolve_bot_token($1) as result', [HASH2],
    )).rows[0]?.result.status).toBe('revoked_token');

    const audit = await db.query<{ metadata: unknown; event: string }>(
      'select event, metadata from mcp_internal.mcp_bot_token_audit',
    );
    expect(audit.rows.map((r) => r.event).sort()).toEqual(['issue', 'revoke', 'revoke', 'rotate']);
    expect(JSON.stringify(audit.rows)).not.toContain(HASH);
    expect(JSON.stringify(audit.rows)).not.toContain(HASH2);
  });

  it('denies resolve of a suspended bot even with an unrevoked token', async () => {
    await db.query('select mcp_issue_bot_token($1,$2,$3,$4)', ['bot_production', HASH, 'operator', null]);
    await db.query('select mcp_suspend_bot($1,$2,$3)', ['bot_production', 'operator', 'lock']);
    expect((await db.query<{ result: { status?: string } }>(
      'select mcp_resolve_bot_token($1) as result', [HASH],
    )).rows[0]?.result.status).toBe('suspended');
  });

  it('unknown hashes miss; anon and authenticated cannot execute wrappers or read hashes', async () => {
    expect((await db.query<{ result: { found: boolean } }>(
      'select mcp_resolve_bot_token($1) as result', [HASH],
    )).rows[0]?.result).toEqual({ found: false });
    for (const role of ['anon', 'authenticated']) {
      await db.exec(`set role ${role}`);
      await expect(db.query('select mcp_resolve_bot_token($1)', [HASH])).rejects.toThrow('permission denied');
      await expect(db.query('select * from mcp_internal.mcp_bot_tokens')).rejects.toThrow('permission denied');
      await db.exec('reset role');
    }
  });
});
