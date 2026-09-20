import { PGlite } from "@electric-sql/pglite";
import { readFile } from "node:fs/promises";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

/**
 * The audit invariant, against a real Postgres.
 *
 * An asset was found approved in production with no row in
 * client_asset_reviews at all — nobody knew who approved it or when. These
 * are the paths that must still work and the one that must not.
 */
const ADMIN = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
let db: PGlite;
let client: string;

const migration = async (file: string) =>
  readFile(new URL(`../../supabase/migrations/${file}`, import.meta.url), "utf8");

async function asAdmin() {
  await db.exec(`
    reset role;
    select set_config('request.jwt.claim.role','authenticated',false);
    select set_config('request.jwt.claim.sub','${ADMIN}',false);
    set role authenticated;
  `);
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
    "20260903104450_01_foundations_roles_clients.sql",
    "20260903104529_02_team_and_operations.sql",
    "20260903104615_03_agent_registry_and_job_queue.sql",
    "20260903104816_05_content_chain_proof_ideas_briefs_media.sql",
    "20260920240000_107_asset_decision_recorded.sql",
  ]) {
    await db.exec(await migration(file));
  }
  await db.exec(`
    insert into auth.users (id, email) values ('${ADMIN}', 'admin@example.com');
    -- A trigger may already have made the profile from auth.users, so this
    -- settles the role either way rather than assuming which happened.
    insert into profiles (id, full_name, role) values ('${ADMIN}', 'Admin', 'admin')
      on conflict (id) do update set role = 'admin';
    insert into clients (name, initials) values ('Test Client', 'TC');
    grant execute on function is_admin() to authenticated;
    grant execute on function can_access_client(uuid) to authenticated;
    grant execute on function review_media_asset(uuid, review_status, text) to authenticated;
    grant select, insert, update on table client_media_assets, client_asset_reviews to authenticated;
    grant select on table clients to authenticated;
    -- can_access_client reads client_users; without this every RPC call
    -- fails on permission before reaching the behaviour under test.
    grant select on table client_users to authenticated;
    -- The bot writer's column arrives in migration 74. This suite is about
    -- the trigger, not that migration, so the column is added rather than
    -- pulling in a file with its own dependencies.
    alter table client_asset_reviews add column if not exists reviewed_by_bot text;
  `);
  const rows = await db.query<{ id: string }>(`select id from clients limit 1`);
  client = rows.rows[0]!.id;
}, 60_000);

beforeEach(async () => {
  await db.exec(`reset role; delete from client_asset_reviews; delete from client_media_assets;`);
});

async function newAsset(status = "pending") {
  const rows = await db.query<{ id: string }>(
    `insert into client_media_assets (client_id, media_type, title, storage_path, review_status)
     values ('${client}', 'image', 'x', 'p/${Math.random()}.png', '${status}') returning id`,
  );
  return rows.rows[0]!.id;
}

describe("a decision must be recorded", () => {
  it("allows the RPC, which updates the status before logging the decision", async () => {
    await asAdmin();
    const id = await newAsset();
    await expect(db.exec(`select review_media_asset('${id}', 'approved', null)`)).resolves.toBeDefined();
    const rows = await db.query<{ n: number }>(
      `select count(*)::int as n from client_asset_reviews where asset_id = '${id}'`,
    );
    expect(rows.rows[0]!.n).toBe(1);
  });

  it("allows a rejection through the RPC", async () => {
    await asAdmin();
    const id = await newAsset();
    await db.exec(`select review_media_asset('${id}', 'approved', null)`);
    await expect(
      db.exec(`select review_media_asset('${id}', 'rejected', 'not good enough')`),
    ).resolves.toBeDefined();
  });

  // Production sends assets back to pending; that is the absence of a
  // decision, so there is nothing to record.
  it("allows an asset to be sent back to pending", async () => {
    await asAdmin();
    const id = await newAsset();
    await db.exec(`select review_media_asset('${id}', 'approved', null)`);
    await db.exec(`reset role`);
    await expect(
      db.exec(`update client_media_assets set review_status = 'pending' where id = '${id}'`),
    ).resolves.toBeDefined();
  });

  // The bot writer logs with reviewed_by_bot rather than reviewed_by. It
  // must still satisfy the invariant, or bot triage breaks.
  it("allows the bot writer's shape", async () => {
    await db.exec(`reset role`);
    const id = await newAsset();
    await expect(
      db.exec(`
        update client_media_assets set review_status = 'approved' where id = '${id}';
        insert into client_asset_reviews (asset_id, decision, reason, reviewed_by_bot)
        values ('${id}', 'approved', 'bot decided', 'bot_production');
      `),
    ).resolves.toBeDefined();
  });

  it("refuses an insert that arrives already approved with nothing recorded", async () => {
    await db.exec(`reset role`);
    await expect(newAsset("approved")).rejects.toThrow(/no matching decision recorded/);
  });

  it("refuses a direct update with nothing recorded", async () => {
    await db.exec(`reset role`);
    const id = await newAsset();
    await expect(
      db.exec(`update client_media_assets set review_status = 'approved' where id = '${id}'`),
    ).rejects.toThrow(/no matching decision recorded/);
  });

  // An asset approved, then rejected, must not be put back to approved by a
  // direct write on the strength of the old approval row.
  it("refuses resurrecting a superseded decision", async () => {
    await asAdmin();
    const id = await newAsset();
    await db.exec(`select review_media_asset('${id}', 'approved', null)`);
    // Separate statements, so the rejection is strictly later than the
    // approval. Same-transaction decisions share now() and tie.
    await db.exec(`update client_asset_reviews set created_at = now() - interval '1 day' where asset_id = '${id}'`);
    await db.exec(`select review_media_asset('${id}', 'rejected', 'no')`);
    await db.exec(`reset role`);
    await expect(
      db.exec(`update client_media_assets set review_status = 'approved' where id = '${id}'`),
    ).rejects.toThrow(/no matching decision recorded/);
  });

  it("names the asset and the status it was set to", async () => {
    await db.exec(`reset role`);
    const id = await newAsset();
    await expect(
      db.exec(`update client_media_assets set review_status = 'rejected' where id = '${id}'`),
    ).rejects.toThrow(new RegExp(`Asset ${id} was set to rejected`));
  });
});
