import { PGlite } from "@electric-sql/pglite";
import { readFile } from "node:fs/promises";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

/**
 * Migration 145 against a real Postgres.
 *
 * post_copy is the first table where the same logical thing can hang off two
 * different parents, and where "which caption actually goes out" is a question
 * the publisher will ask every time it runs. Both of those are worth proving
 * rather than reading.
 *
 * The real migration file is applied, not a copy of it.
 */
let db: PGlite;

const migration = (file: string) =>
  readFile(new URL(`../../supabase/migrations/${file}`, import.meta.url), "utf8");

const CLIENT = "11111111-1111-4111-8111-111111111111";
const OTHER_CLIENT = "22222222-2222-4222-8222-222222222222";
const ASSET = "33333333-3333-4333-8333-333333333333";
const POST = "44444444-4444-4444-8444-444444444444";
const ADMIN = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const MEMBER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const OUTSIDER = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

async function one<T = Record<string, unknown>>(sql: string): Promise<T> {
  const result = await db.query<T>(sql);
  return result.rows[0]!;
}

/**
 * Run as a particular signed-in person, through RLS.
 *
 * `set role authenticated` is the whole point and must not be swallowed. The
 * first version of this helper used `set local role` outside a transaction and
 * caught the resulting error, so every query ran as the owner — who bypasses
 * RLS — and the policy tests passed without ever reaching a policy.
 */
async function asUser<T = Record<string, unknown>>(userId: string, sql: string): Promise<T[]> {
  await db.exec(`select set_config('request.jwt.claim.sub', '${userId}', false);`);
  await db.exec(`set role authenticated;`);
  try {
    const result = await db.query<T>(sql);
    return result.rows;
  } finally {
    await db.exec(`reset role;`);
  }
}

/** Proof the helper actually drops privilege, so the tests below mean something. */
async function currentRole(): Promise<string> {
  return (await one<{ role: string }>(`select current_user as role`)).role;
}

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    create role anon; create role authenticated; create role service_role;
    create schema auth;
    create table auth.users (id uuid primary key);
    create function auth.uid() returns uuid language sql stable as
      $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;

    create type media_type as enum ('image', 'text', 'video');
    create type content_format as enum ('single', 'carousel', 'story', 'reel');
    create type review_status as enum ('pending', 'approved', 'rejected');
    create type post_channel as enum ('organic', 'paid');
    create type post_platform as enum ('facebook', 'instagram', 'tiktok', 'linkedin', 'youtube');

    create table clients (id uuid primary key, name text not null default 'c');
    create table profiles (id uuid primary key, role text);
    create table client_members (client_id uuid, user_id uuid);

    -- SECURITY DEFINER, as they are in production: a policy helper that ran as
    -- the caller would need the caller to be able to read profiles, which is
    -- the opposite of what the policy is for.
    create function is_admin() returns boolean language sql stable security definer as
      $$ select exists (select 1 from profiles where id = auth.uid() and role = 'admin') $$;
    create function can_access_client(p uuid) returns boolean language sql stable security definer as
      $$ select is_admin() or exists (
           select 1 from client_members m where m.client_id = p and m.user_id = auth.uid()) $$;

    create table client_media_assets (
      id uuid primary key,
      client_id uuid not null references clients(id),
      ref_number text, title text,
      media_type media_type not null default 'image',
      content_format content_format not null default 'single',
      review_status review_status not null default 'approved',
      human_approved_at timestamptz
    );

    create table scheduled_posts (
      id uuid primary key default gen_random_uuid(),
      client_id uuid, asset_id uuid references client_media_assets(id),
      scheduled_for date not null,
      scheduled_at timestamptz,
      channel post_channel not null default 'organic',
      platform post_platform,
      publication_status text not null default 'scheduled',
      published_at timestamptz
    );

    insert into auth.users (id) values ('${ADMIN}'), ('${MEMBER}'), ('${OUTSIDER}');
    insert into profiles (id, role) values ('${ADMIN}', 'admin'), ('${MEMBER}', 'staff'), ('${OUTSIDER}', 'staff');
    insert into clients (id, name) values ('${CLIENT}', 'Harbour'), ('${OTHER_CLIENT}', 'Other');
    insert into client_members (client_id, user_id) values ('${CLIENT}', '${MEMBER}');
    insert into client_media_assets (id, client_id, title) values ('${ASSET}', '${CLIENT}', 'The Chain');
    insert into scheduled_posts (id, client_id, asset_id, scheduled_for)
      values ('${POST}', '${CLIENT}', '${ASSET}', '2026-11-02');
  `);

  await db.exec(await migration("20261005190000_145_post_copy.sql"));
  await db.exec(`
    grant usage on schema public, auth to authenticated;
    grant select on post_copy, post_copy_effective to authenticated;
    grant select on scheduled_posts, client_media_assets, clients to authenticated;`);
});

describe("where copy can hang", () => {
  beforeEach(async () => {
    await db.exec(`delete from post_copy`);
  });

  it("takes copy on a scheduled post", async () => {
    await db.exec(`insert into post_copy (scheduled_post_id, platform, caption)
                   values ('${POST}', 'instagram', 'Five steps, one chain.')`);
    const { client_id, version } = await one<{ client_id: string; version: number }>(
      `select client_id, version from post_copy`,
    );
    expect(client_id).toBe(CLIENT);
    expect(version).toBe(1);
  });

  it("takes copy on an asset, and fills the client from it", async () => {
    await db.exec(`insert into post_copy (asset_id, platform, caption) values ('${ASSET}', 'instagram', 'Draft')`);
    const { client_id } = await one<{ client_id: string }>(`select client_id from post_copy`);
    expect(client_id).toBe(CLIENT);
  });

  it("refuses copy that belongs to both, or to neither", async () => {
    await expect(
      db.exec(`insert into post_copy (scheduled_post_id, asset_id, platform) values ('${POST}', '${ASSET}', 'instagram')`),
    ).rejects.toThrow(/post_copy_one_parent/);
    // A row with no parent is stopped a step earlier: the BEFORE trigger runs
    // before the check constraint and cannot find a client for it.
    await expect(db.exec(`insert into post_copy (platform) values ('instagram')`)).rejects.toThrow(
      /has no client/,
    );
  });

  it("allows one row per platform per parent, and no more", async () => {
    await db.exec(`insert into post_copy (scheduled_post_id, platform, caption) values ('${POST}', 'instagram', 'a')`);
    await db.exec(`insert into post_copy (scheduled_post_id, platform, caption) values ('${POST}', 'linkedin', 'b')`);
    await expect(
      db.exec(`insert into post_copy (scheduled_post_id, platform, caption) values ('${POST}', 'instagram', 'c')`),
    ).rejects.toThrow(/post_copy_one_per_post_platform/);
  });

  it("does not let an asset row collide with a post row", async () => {
    await db.exec(`insert into post_copy (scheduled_post_id, platform, caption) values ('${POST}', 'instagram', 'a')`);
    await db.exec(`insert into post_copy (asset_id, platform, caption) values ('${ASSET}', 'instagram', 'b')`);
    const { n } = await one<{ n: number }>(`select count(*)::int as n from post_copy`);
    expect(n).toBe(2);
  });

  it("refuses an unknown source", async () => {
    await expect(
      db.exec(`insert into post_copy (asset_id, platform, source) values ('${ASSET}', 'instagram', 'robot')`),
    ).rejects.toThrow(/post_copy_source/);
  });

  it("goes when its post goes", async () => {
    await db.exec(`
      insert into scheduled_posts (id, client_id, asset_id, scheduled_for)
        values ('55555555-5555-4555-8555-555555555555', '${CLIENT}', '${ASSET}', '2026-11-03');
      insert into post_copy (scheduled_post_id, platform, caption)
        values ('55555555-5555-4555-8555-555555555555', 'tiktok', 'x');
      delete from scheduled_posts where id = '55555555-5555-4555-8555-555555555555';`);
    const { n } = await one<{ n: number }>(`select count(*)::int as n from post_copy`);
    expect(n).toBe(0);
  });
});

describe("version", () => {
  beforeEach(async () => {
    await db.exec(`delete from post_copy;
                   insert into post_copy (scheduled_post_id, platform, caption)
                   values ('${POST}', 'instagram', 'First words')`);
  });

  it("counts a rewrite", async () => {
    await db.exec(`update post_copy set caption = 'Second words'`);
    await db.exec(`update post_copy set hashtags = array['#chain']`);
    const { version } = await one<{ version: number }>(`select version from post_copy`);
    expect(version).toBe(3);
  });

  it("does not count a touch that changed none of the words", async () => {
    await db.exec(`update post_copy set source = 'agent'`);
    await db.exec(`update post_copy set caption = 'First words'`);
    const { version } = await one<{ version: number }>(`select version from post_copy`);
    expect(version).toBe(1);
  });
});

describe("who can see and write copy", () => {
  beforeEach(async () => {
    await db.exec(`delete from post_copy;
                   insert into post_copy (scheduled_post_id, platform, caption)
                   values ('${POST}', 'instagram', 'Harbour copy')`);
  });

  it("really does drop to the authenticated role, or none of this means anything", async () => {
    const [{ role }] = await asUser(MEMBER, `select current_user as role`);
    expect(role).toBe("authenticated");
    // and is back afterwards
    expect(await currentRole()).not.toBe("authenticated");
  });

  it("shows it to someone with access to the client", async () => {
    const rows = await asUser(MEMBER, `select caption from post_copy`);
    expect(rows).toHaveLength(1);
  });

  it("hides it from someone without", async () => {
    const rows = await asUser(OUTSIDER, `select caption from post_copy`);
    expect(rows).toHaveLength(0);
  });

  it("lets a member write through the RPC without being an admin", async () => {
    await asUser(MEMBER, `select set_post_copy('linkedin', '${POST}', null, 'Member wrote this')`);
    await db.exec(`reset role;`);
    const { caption } = await one<{ caption: string }>(
      `select caption from post_copy where platform = 'linkedin'`,
    );
    expect(caption).toBe("Member wrote this");
  });

  it("refuses the RPC to someone with no access to that client", async () => {
    await expect(
      asUser(OUTSIDER, `select set_post_copy('linkedin', '${POST}', null, 'Not allowed')`),
    ).rejects.toThrow(/Not permitted for this client/);
  });

  it("refuses a direct write from a member, so the RPC stays the only way in", async () => {
    await expect(
      asUser(MEMBER, `insert into post_copy (scheduled_post_id, platform) values ('${POST}', 'tiktok')`),
    ).rejects.toThrow();
  });
});

describe("set_post_copy", () => {
  beforeEach(async () => {
    await db.exec(`reset role;`);
    await db.exec(`delete from post_copy;`);
    await db.exec(`select set_config('request.jwt.claim.sub', '${ADMIN}', false);`);
  });

  it("writes once and then overwrites, rather than making a second row", async () => {
    await db.exec(`select set_post_copy('instagram', '${POST}', null, 'One')`);
    await db.exec(`select set_post_copy('instagram', '${POST}', null, 'Two')`);
    const { n, caption, version } = await one<{ n: number; caption: string; version: number }>(
      `select count(*) over ()::int as n, caption, version from post_copy limit 1`,
    );
    expect(n).toBe(1);
    expect(caption).toBe("Two");
    expect(version).toBe(2);
  });

  it("upserts asset-level copy too, which the post path alone would not", async () => {
    await db.exec(`select set_post_copy('instagram', null, '${ASSET}', 'Draft one')`);
    await db.exec(`select set_post_copy('instagram', null, '${ASSET}', 'Draft two')`);
    const { n, caption } = await one<{ n: number; caption: string }>(
      `select count(*) over ()::int as n, caption from post_copy limit 1`,
    );
    expect(n).toBe(1);
    expect(caption).toBe("Draft two");
  });

  it("refuses both parents or neither", async () => {
    await expect(db.exec(`select set_post_copy('instagram', '${POST}', '${ASSET}', 'x')`)).rejects.toThrow(
      /not both and not neither/,
    );
    await expect(db.exec(`select set_post_copy('instagram', null, null, 'x')`)).rejects.toThrow(
      /not both and not neither/,
    );
  });

  it("refuses a parent that does not exist", async () => {
    await expect(
      db.exec(`select set_post_copy('instagram', gen_random_uuid(), null, 'x')`),
    ).rejects.toThrow(/scheduled post does not exist/);
  });
});

describe("post_copy_effective", () => {
  beforeEach(async () => {
    await db.exec(`reset role;`);
    await db.exec(`delete from post_copy;`);
  });

  it("falls back to the asset's draft when the slot has none", async () => {
    await db.exec(`insert into post_copy (asset_id, platform, caption) values ('${ASSET}', 'instagram', 'Asset draft')`);
    const { caption, level } = await one<{ caption: string; level: string }>(
      `select caption, level from post_copy_effective where scheduled_post_id = '${POST}'`,
    );
    expect(caption).toBe("Asset draft");
    expect(level).toBe("asset");
  });

  it("prefers the copy written for the slot", async () => {
    await db.exec(`
      insert into post_copy (asset_id, platform, caption) values ('${ASSET}', 'instagram', 'Asset draft');
      insert into post_copy (scheduled_post_id, platform, caption) values ('${POST}', 'instagram', 'Slot copy');`);
    const rows = await db.query<{ caption: string; level: string }>(
      `select caption, level from post_copy_effective where scheduled_post_id = '${POST}'`,
    );
    // One row, not two: the publisher must not be handed a choice.
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]).toMatchObject({ caption: "Slot copy", level: "post" });
  });

  it("keeps the platforms apart when only one of them is overridden", async () => {
    await db.exec(`
      insert into post_copy (asset_id, platform, caption) values
        ('${ASSET}', 'instagram', 'Asset IG'), ('${ASSET}', 'linkedin', 'Asset LI');
      insert into post_copy (scheduled_post_id, platform, caption) values ('${POST}', 'instagram', 'Slot IG');`);
    const rows = await db.query<{ platform: string; caption: string; level: string }>(
      `select platform, caption, level from post_copy_effective
       where scheduled_post_id = '${POST}' order by platform`);
    expect(rows.rows).toEqual([
      { platform: "instagram", caption: "Slot IG", level: "post" },
      { platform: "linkedin", caption: "Asset LI", level: "asset" },
    ]);
  });

  it("says nothing at all when there is no copy anywhere", async () => {
    const rows = await db.query(`select * from post_copy_effective where scheduled_post_id = '${POST}'`);
    expect(rows.rows).toHaveLength(0);
  });
});
