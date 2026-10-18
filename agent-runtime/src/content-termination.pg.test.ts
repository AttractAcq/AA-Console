import { PGlite } from "@electric-sql/pglite";
import { readFile } from "node:fs/promises";
import { beforeEach, afterAll, describe, expect, it } from "vitest";

/**
 * Migration 223 against a real Postgres.
 *
 * Archiving is reversible and loses nothing, so the tests about it are short.
 * Deleting is not, so most of this is about what it removes, what it counts,
 * and the two cases where it refuses: an asset a proof placement names, and
 * an asset that is the source of a proof production request. Both may
 * describe something live on a client's website or profile, and cascading
 * through them would destroy the only record that it is there.
 */
let db: PGlite;

const CLIENT = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const IDEA = "33333333-3333-4333-8333-333333333333";
const BRIEF = "44444444-4444-4444-8444-444444444444";
const ASSET = "55555555-5555-4555-8555-555555555555";

const migration = () =>
  readFile(
    new URL("../../supabase/migrations/20261019140000_223_archive_and_terminate_content.sql", import.meta.url),
    "utf8",
  );

const rows = async <T = Record<string, unknown>>(sql: string) => (await db.query<T>(sql)).rows;
const one = async <T = Record<string, unknown>>(sql: string) => (await rows<T>(sql))[0]!;

beforeEach(async () => {
  db = new PGlite();
  await db.exec(`
    create role authenticated; create role anon; create role service_role;
    create schema auth; create schema storage;
    create function auth.uid() returns uuid language sql as $$ select '${CLIENT}'::uuid $$;
    create function can_access_client(p uuid) returns boolean language sql as
      $$ select p = '${CLIENT}'::uuid $$;
    create function lock_down_definer_functions() returns integer language sql as $$ select 0 $$;

    create table clients (id uuid primary key);
    create table client_ideas (id uuid primary key, client_id uuid, archived_at timestamptz);
    create table client_briefs (id uuid primary key, client_id uuid, archived_at timestamptz);
    create table client_media_assets (id uuid primary key, client_id uuid, brief_id uuid,
      storage_path text, render_path text);
    create table client_media_frames (id uuid primary key default gen_random_uuid(),
      asset_id uuid references client_media_assets(id) on delete cascade,
      position int, storage_path text);
    create table post_copy (id uuid primary key default gen_random_uuid(), asset_id uuid);
    create table scheduled_posts (id uuid primary key default gen_random_uuid(), asset_id uuid);
    create table client_asset_reviews (id uuid primary key default gen_random_uuid(), asset_id uuid);
    -- Supabase's own, as the migration expects to find it.
    create table storage.objects (id uuid primary key default gen_random_uuid(),
      bucket_id text, name text);

    insert into clients values ('${CLIENT}'), ('${OTHER}');
    insert into client_ideas values ('${IDEA}', '${CLIENT}', null);
    insert into client_briefs values ('${BRIEF}', '${CLIENT}', null);
    insert into client_media_assets values ('${ASSET}', '${CLIENT}', '${BRIEF}',
      'client/a.png', 'client/a-render.png');
    insert into client_media_frames (asset_id, position, storage_path) values
      ('${ASSET}', 1, 'client/f1.png'), ('${ASSET}', 2, 'client/f2.png');
    insert into post_copy (asset_id) values ('${ASSET}'), ('${ASSET}');
    insert into scheduled_posts (asset_id) values ('${ASSET}');
    insert into client_asset_reviews (asset_id) values ('${ASSET}');
    insert into storage.objects (bucket_id, name) values
      ('client-media', 'client/a.png'), ('client-media', 'client/a-render.png'),
      ('client-media', 'client/f1.png'), ('client-media', 'client/f2.png'),
      ('client-media', 'client/someone-else.png');`);
  await db.exec(await migration());
}, 60000);

afterAll(async () => {
  await db?.close();
});

describe("archiving", () => {
  it("stamps and clears each kind of record", async () => {
    for (const [record, table, id] of [
      ["idea", "client_ideas", IDEA],
      ["brief", "client_briefs", BRIEF],
      ["asset", "client_media_assets", ASSET],
    ] as const) {
      await db.query("select set_content_archived_v6($1,$2)", [record, id]);
      expect(
        await one<{ archived_at: Date | null }>(`select archived_at from ${table} where id = '${id}'`),
      ).not.toMatchObject({ archived_at: null });
      // Reversible, which is what makes it safe to do on a hunch.
      await db.query("select set_content_archived_v6($1,$2,false)", [record, id]);
      expect(
        await one<{ archived_at: Date | null }>(`select archived_at from ${table} where id = '${id}'`),
      ).toMatchObject({ archived_at: null });
    }
  });

  it("takes only the three records it names, and only this client's", async () => {
    await expect(db.query("select set_content_archived_v6('campaign',$1)", [IDEA])).rejects.toThrow(
      "Unknown record type",
    );
    await db.exec(`insert into client_ideas values ('${OTHER}', '${OTHER}', null)`);
    await expect(db.query("select set_content_archived_v6('idea',$1)", [OTHER])).rejects.toThrow(
      "Not permitted",
    );
  });
});

describe("terminating an asset", () => {
  it("removes everything it owns and says what that was", async () => {
    const removed = await one<{
      deleted_frames: number; deleted_copy: number; deleted_posts: number; deleted_files: number;
    }>(`select * from delete_content_asset_v6('${ASSET}')`);
    expect(removed).toMatchObject({
      deleted_frames: 2,
      deleted_copy: 2,
      deleted_posts: 1,
      // Its own file, its render, and both frames. Not the fifth object.
      deleted_files: 4,
    });

    expect(await rows(`select 1 from client_media_assets where id = '${ASSET}'`)).toHaveLength(0);
    for (const table of ["client_media_frames", "post_copy", "scheduled_posts", "client_asset_reviews"]) {
      expect(await rows(`select 1 from ${table} where asset_id = '${ASSET}'`)).toHaveLength(0);
    }
    // Another asset's file is untouched: the delete is scoped by name, not by
    // bucket.
    expect(await rows("select 1 from storage.objects")).toHaveLength(1);
  });

  it("refuses an asset a proof placement names", async () => {
    await db.exec(`create table proof_placements (id uuid primary key default gen_random_uuid(),
      asset_id uuid references client_media_assets(id) on delete restrict)`);
    await db.exec(`insert into proof_placements (asset_id) values ('${ASSET}')`);
    await expect(db.query(`select * from delete_content_asset_v6('${ASSET}')`)).rejects.toThrow(
      "live somewhere public",
    );
    // And nothing was half-removed on the way to finding that out.
    expect(await rows(`select 1 from client_media_frames where asset_id = '${ASSET}'`)).toHaveLength(2);
    expect(await rows(`select 1 from client_media_assets where id = '${ASSET}'`)).toHaveLength(1);
  });

  it("refuses an asset a proof production request was derived from", async () => {
    await db.exec(`create table proof_production_requests (id uuid primary key default gen_random_uuid(),
      source_asset_id uuid references client_media_assets(id) on delete restrict)`);
    await db.exec(`insert into proof_production_requests (source_asset_id) values ('${ASSET}')`);
    await expect(db.query(`select * from delete_content_asset_v6('${ASSET}')`)).rejects.toThrow(
      "source of",
    );
  });

  it("works where the storage schema is not reachable, rather than failing halfway", async () => {
    await db.exec("drop table storage.objects");
    const removed = await one<{ deleted_files: number; deleted_frames: number }>(
      `select * from delete_content_asset_v6('${ASSET}')`,
    );
    expect(removed).toMatchObject({ deleted_files: 0, deleted_frames: 2 });
    expect(await rows(`select 1 from client_media_assets where id = '${ASSET}'`)).toHaveLength(0);
  });

  it("is refused for another client's asset", async () => {
    await db.exec(`insert into client_media_assets values ('${OTHER}','${OTHER}',null,'x',null)`);
    await expect(db.query(`select * from delete_content_asset_v6('${OTHER}')`)).rejects.toThrow(
      "Not permitted",
    );
  });
});

describe("terminating a brief", () => {
  it("takes every asset made from it, through the same door", async () => {
    const removed = await one<{ deleted_frames: number; deleted_files: number }>(
      `select * from delete_content_brief_v6('${BRIEF}')`,
    );
    expect(removed).toMatchObject({ deleted_frames: 2, deleted_files: 4 });
    expect(await rows(`select 1 from client_briefs where id = '${BRIEF}'`)).toHaveLength(0);
    expect(await rows("select 1 from client_media_assets")).toHaveLength(0);
  });

  it("refuses the whole delete when one of its assets is held", async () => {
    await db.exec(`create table proof_placements (id uuid primary key default gen_random_uuid(),
      asset_id uuid references client_media_assets(id) on delete restrict)`);
    await db.exec(`insert into proof_placements (asset_id) values ('${ASSET}')`);
    await expect(db.query(`select * from delete_content_brief_v6('${BRIEF}')`)).rejects.toThrow(
      "live somewhere public",
    );
    // A brief with one asset still attached would be worse than refusing.
    expect(await rows(`select 1 from client_briefs where id = '${BRIEF}'`)).toHaveLength(1);
  });
});
