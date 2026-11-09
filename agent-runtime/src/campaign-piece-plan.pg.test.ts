import { PGlite } from "@electric-sql/pglite";
import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, expect, it } from "vitest";

let db: PGlite;
const campaignId = "11111111-1111-4111-8111-111111111111";

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    create role anon; create role authenticated; create role service_role;
    create schema auth;
    create function auth.role() returns text language sql stable
      as $$ select current_setting('request.jwt.claim.role', true) $$;
    create function lock_down_definer_functions() returns void language sql as $$ select $$;
    create table client_campaigns (
      id uuid primary key, acquisition_mode text not null, content_count integer not null,
      organic_content_count integer not null, paid_content_count integer not null,
      objective text, audience text, offer_summary text, core_message text,
      channels text[], budget numeric, starts_on date, ends_on date,
      kpi_metric text, kpi_target numeric, needs_landing_page boolean,
      needs_sales_agent boolean, offer_version_id uuid,
      plan_approved_at timestamptz, plan_approved_fingerprint text,
      updated_at timestamptz default now()
    );
    insert into client_campaigns(id, acquisition_mode, content_count, organic_content_count, paid_content_count)
    values ('${campaignId}', 'both', 2, 1, 1);
    select set_config('request.jwt.claim.role', 'service_role', false);
  `);
  const migration = await readFile(new URL("../../supabase/migrations/20261106010000_314_campaign_plan_names_each_piece_type.sql", import.meta.url), "utf8");
  await db.exec(migration);
});

afterAll(async () => { await db?.close(); });

it("requires a matching route and buildable type for every approved slot", async () => {
  await expect(db.query(`update client_campaigns set plan_approved_at=now(),
    plan_approved_fingerprint=campaign_plan_fingerprint(client_campaigns)
    where id='${campaignId}'`)).rejects.toThrow(/valid type and route/);

  const bad = JSON.stringify([
    { acquisition_route: "organic", media_type: "image", content_format: "carousel" },
    { acquisition_route: "paid", media_type: "image", content_format: "reel" },
  ]);
  await expect(db.query("select set_campaign_content_pieces_v6($1,$2::jsonb)", [campaignId, bad]))
    .rejects.toThrow(/match the content count/);

  const good = JSON.stringify([
    { acquisition_route: "organic", media_type: "image", content_format: "carousel" },
    { acquisition_route: "paid", media_type: "video", content_format: "reel" },
  ]);
  await db.query("select set_campaign_content_pieces_v6($1,$2::jsonb)", [campaignId, good]);
  await db.query(`update client_campaigns set plan_approved_at=now(),
    plan_approved_fingerprint=campaign_plan_fingerprint(client_campaigns)
    where id='${campaignId}'`);
  const approved = await db.query<{ current: boolean }>(`select
    plan_approved_fingerprint = campaign_plan_fingerprint(client_campaigns) as current
    from client_campaigns where id='${campaignId}'`);
  expect(approved.rows[0]?.current).toBe(true);

  await db.query("update client_campaigns set content_pieces=$2::jsonb where id=$1", [campaignId,
    JSON.stringify([JSON.parse(good)[1], JSON.parse(good)[0]])]);
  const stale = await db.query<{ current: boolean }>(`select
    plan_approved_fingerprint = campaign_plan_fingerprint(client_campaigns) as current
    from client_campaigns where id='${campaignId}'`);
  expect(stale.rows[0]?.current).toBe(false);
});
