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
      id uuid primary key, client_id uuid not null, acquisition_mode text not null, content_count integer not null,
      organic_content_count integer not null, paid_content_count integer not null,
      objective text, audience text, offer_summary text, core_message text,
      channels text[], budget numeric, starts_on date, ends_on date,
      kpi_metric text, kpi_target numeric, needs_landing_page boolean,
      needs_sales_agent boolean, offer_version_id uuid,
      plan_approved_at timestamptz, plan_approved_fingerprint text,
      built_at timestamptz,
      updated_at timestamptz default now()
    );
    create function save_campaign_plan_only(uuid, uuid, uuid, jsonb) returns void
      language plpgsql as $$ begin
        update client_campaigns set content_count=($4->>'content_count')::integer, built_at=now() where id=$1;
      end $$;
    create function save_campaign_plan_with_ideas(uuid, uuid, uuid, jsonb, jsonb) returns integer
      language plpgsql as $$ begin
        update client_campaigns set content_count=($4->>'content_count')::integer, built_at=now() where id=$1;
        return 1;
      end $$;
    create function set_campaign_route_volumes_v6(uuid, integer, integer) returns void
      language plpgsql as $$ begin
        if $2+$3 <> (select content_count from client_campaigns where id=$1) then
          raise exception 'Route volume mismatch';
        end if;
        update client_campaigns set organic_content_count=$2, paid_content_count=$3 where id=$1;
      end $$;
    insert into client_campaigns(id, client_id, acquisition_mode, content_count, organic_content_count, paid_content_count)
    values ('${campaignId}', '${campaignId}', 'both', 2, 1, 1);
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
  await db.query("select save_campaign_plan_v6($1,$2,$3,$4::jsonb,$5::jsonb,$6,$7,$8::jsonb)", [
    campaignId, campaignId, campaignId, JSON.stringify({ content_count: 2 }), null, 1, 1, good,
  ]);
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

it("rolls back a built plan when its route and piece mix disagree", async () => {
  const second = "22222222-2222-4222-8222-222222222222";
  await db.query("insert into client_campaigns(id,client_id,acquisition_mode,content_count,organic_content_count,paid_content_count) values ($1,$1,'both',2,1,1)", [second]);
  const invalid = JSON.stringify([
    { acquisition_route: "organic", media_type: "image", content_format: "single" },
    { acquisition_route: "organic", media_type: "image", content_format: "single" },
  ]);
  await expect(db.query("select save_campaign_plan_v6($1,$2,$3,$4::jsonb,$5::jsonb,$6,$7,$8::jsonb)", [
    second, second, second, JSON.stringify({ content_count: 2 }), null, 1, 1, invalid,
  ])).rejects.toThrow(/match the content count/);
  const result = await db.query<{ built_at: string | null }>("select built_at from client_campaigns where id=$1", [second]);
  expect(result.rows[0]?.built_at).toBeNull();
});

it("commits an idea batch with its approved mix and refuses a competing planner", async () => {
  const third = "33333333-3333-4333-8333-333333333333";
  await db.query("insert into client_campaigns(id,client_id,acquisition_mode,content_count,organic_content_count,paid_content_count) values ($1,$1,'organic',1,1,0)", [third]);
  const mix = JSON.stringify([{ acquisition_route: "organic", media_type: "video", content_format: "reel" }]);
  const args = [third, third, third, JSON.stringify({ content_count: 1 }), JSON.stringify([{ title: "Idea" }]), 1, 0, mix];
  await db.query("select save_campaign_plan_v6($1,$2,$3,$4::jsonb,$5::jsonb,$6,$7,$8::jsonb)", args);
  const saved = await db.query<{ built: boolean; mix: unknown }>(
    "select built_at is not null as built, content_pieces as mix from client_campaigns where id=$1", [third]);
  expect(saved.rows[0]?.built).toBe(true);
  expect(saved.rows[0]?.mix).toEqual(JSON.parse(mix));
  await expect(db.query("select save_campaign_plan_v6($1,$2,$3,$4::jsonb,$5::jsonb,$6,$7,$8::jsonb)", args))
    .rejects.toThrow(/already has a plan/);
});
