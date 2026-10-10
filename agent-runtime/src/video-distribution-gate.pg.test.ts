import { PGlite } from "@electric-sql/pglite";
import { readFile } from "node:fs/promises";
import { expect, it } from "vitest";

it("keeps bot-triaged video out of distribution until a person finalizes it", async () => {
  const db = new PGlite();
  try {
    await db.exec(`
      create type media_type as enum ('image','video');
      create type review_status as enum ('pending','approved','rejected');
      create table client_media_assets (id uuid primary key, media_type media_type,
        review_status review_status, human_approved_at timestamptz);
      create table scheduled_posts (id uuid primary key default gen_random_uuid(),
        asset_id uuid, publication_status text default 'scheduled');
      insert into client_media_assets values
        ('11111111-1111-4111-8111-111111111111','video','approved',null),
        ('22222222-2222-4222-8222-222222222222','image','approved',null);
    `);
    await db.exec(await readFile(new URL("../../supabase/migrations/20261011000000_186_video_distribution_human_gate.sql", import.meta.url), "utf8"));
    await expect(db.query("insert into scheduled_posts(asset_id) values ($1)",
      ["11111111-1111-4111-8111-111111111111"])).rejects.toThrow(/human video approval/);
    await db.query("insert into scheduled_posts(asset_id) values ($1)",
      ["22222222-2222-4222-8222-222222222222"]);
    await db.query("update client_media_assets set human_approved_at=now() where media_type='video'");
    await db.query("insert into scheduled_posts(asset_id) values ($1)",
      ["11111111-1111-4111-8111-111111111111"]);
    await db.query("update client_media_assets set human_approved_at=null where media_type='video'");
    await expect(db.query("update scheduled_posts set publication_status='published' where asset_id=$1",
      ["11111111-1111-4111-8111-111111111111"])).rejects.toThrow(/human video approval/);
    const count = await db.query<{ n: number }>("select count(*)::int as n from scheduled_posts");
    expect(count.rows[0]?.n).toBe(2);
  } finally { await db.close(); }
});
