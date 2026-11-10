import { PGlite } from "@electric-sql/pglite";
import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const CLIENT = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const ASSET = "33333333-3333-4333-8333-333333333333";
const SHA = "a".repeat(64);
const FROZEN = `${CLIENT}/${SHA}/review.png`;
let db: PGlite;
let frozenObjectId: string;

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    create role anon;
    create role authenticated;
    create role service_role bypassrls;
    create schema storage;
    create table storage.buckets (id text primary key, name text, public boolean,
      file_size_limit bigint, allowed_mime_types text[]);
    create table storage.objects (id uuid primary key default gen_random_uuid(),
      bucket_id text not null, name text not null);
    create table public.clients (id uuid primary key);
    create table public.client_media_assets (id uuid primary key, client_id uuid);
    insert into public.clients values ('${CLIENT}'), ('${OTHER}');
    insert into public.client_media_assets values ('${ASSET}', '${CLIENT}');
    create function public.can_access_client(p_client_id uuid) returns boolean
      language sql stable security definer set search_path = pg_catalog, public as $$
        select p_client_id::text = current_setting('test.client_id', true)
      $$;
    create function public.reject_approval_ledger_mutation_v6() returns trigger
      language plpgsql as $$begin raise exception 'append only'; end;$$;
    create function public.lock_down_definer_functions() returns integer
      language sql as $$select 0$$;
    grant usage on schema public to authenticated, service_role;
    grant execute on function public.can_access_client(uuid) to authenticated;
  `);
  const migration = await readFile(new URL(
    "../../supabase/migrations/20261106020000_315_approval_media_byte_vault.sql",
    import.meta.url,
  ), "utf8");
  await db.exec(migration);
  frozenObjectId = (await db.query<{ id: string }>(
    "insert into storage.objects(bucket_id,name) values ('approval-review-media',$1) returning id",
    [FROZEN],
  )).rows[0]!.id;
});
afterAll(async () => { await db.close(); });

describe("Phase D frozen approval media", () => {
  it("creates a private bucket and prevents even service-role overwrite or delete", async () => {
    const bucket = (await db.query<{ public: boolean }>(
      "select public from storage.buckets where id='approval-review-media'",
    )).rows[0];
    expect(bucket?.public).toBe(false);
    await expect(db.exec(
      "update storage.buckets set public=true where id='approval-review-media'",
    )).rejects.toThrow(/bucket is immutable/i);
    await expect(db.exec(
      "delete from storage.buckets where id='approval-review-media'",
    )).rejects.toThrow(/bucket is immutable/i);
    await expect(db.query(
      "update storage.objects set name='replaced' where id=$1", [frozenObjectId],
    )).rejects.toThrow(/cannot be changed or deleted/i);
    await expect(db.query(
      "delete from storage.objects where id=$1", [frozenObjectId],
    )).rejects.toThrow(/cannot be changed or deleted/i);
    await db.exec("insert into storage.objects(bucket_id,name) values ('client-media','other')");
    await db.exec("update storage.objects set name='still-editable' where bucket_id='client-media'");
  });

  it("rejects invented hashes, cross-client paths, empty source snapshots and mutation", async () => {
    const values = [CLIENT, ASSET, `${CLIENT}/source.png`, JSON.stringify({ path: `${CLIENT}/source.png` }),
      FROZEN, frozenObjectId, SHA, 1024];
    const insert = `insert into public.media_approval_byte_snapshots_v6
      (client_id,asset_id,source_path,source_snapshot,frozen_path,frozen_object_id,byte_sha256,byte_count)
      values ($1,$2,$3,$4,$5,$6,$7,$8)`;
    await expect(db.query(insert, [...values.slice(0, 6), "not-a-hash", values[7]]))
      .rejects.toThrow();
    await expect(db.query(insert, [OTHER, ...values.slice(1)]))
      .rejects.toThrow();
    await expect(db.query(insert, [...values.slice(0, 3), "{}", ...values.slice(4)]))
      .rejects.toThrow();
    await expect(db.query(insert, [...values.slice(0, 5),
      "44444444-4444-4444-8444-444444444444", ...values.slice(6)]))
      .rejects.toThrow(/does not match/i);
    await db.query(insert, values);
    await expect(db.exec("update public.media_approval_byte_snapshots_v6 set byte_count=1"))
      .rejects.toThrow(/append only/i);
    await expect(db.exec("delete from public.media_approval_byte_snapshots_v6"))
      .rejects.toThrow(/append only/i);
  });

  it("allows only scoped reads to authenticated users and no direct insertion", async () => {
    await db.query("select set_config('test.client_id',$1,false)", [CLIENT]);
    await db.exec("set role authenticated");
    try {
      const own = await db.query("select id from public.media_approval_byte_snapshots_v6");
      expect(own.rows).toHaveLength(1);
      await db.query("select set_config('test.client_id',$1,false)", [OTHER]);
      const other = await db.query("select id from public.media_approval_byte_snapshots_v6");
      expect(other.rows).toHaveLength(0);
      await expect(db.exec(`insert into public.media_approval_byte_snapshots_v6
        (client_id,asset_id,source_path,source_snapshot,frozen_path,frozen_object_id,byte_sha256,byte_count)
        values ('${CLIENT}','${ASSET}','${CLIENT}/source.png','{"path":"source"}',
          '${CLIENT}/${SHA}/another.png',gen_random_uuid(),'${SHA}',1024)`))
        .rejects.toThrow(/permission denied/i);
    } finally {
      await db.exec("reset role");
    }
  });
});
