import { PGlite } from "@electric-sql/pglite";
import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, expect, it } from "vitest";

const clientA = "11111111-1111-4111-8111-111111111111";
const clientB = "22222222-2222-4222-8222-222222222222";
const source = "33333333-3333-4333-8333-333333333333";
let db: PGlite;

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    create role anon; create role authenticated; create role service_role;
    create schema auth;
    create function auth.role() returns text language sql stable as
      $$ select current_setting('request.jwt.claim.role', true) $$;
    create function auth.uid() returns uuid language sql stable as $$ select null::uuid $$;
    create function is_admin() returns boolean language sql stable as
      $$ select current_setting('test.is_admin', true) = 'true' $$;
    create function can_access_client(uuid) returns boolean language sql stable as
      $$ select current_setting('test.is_admin', true) = 'true' $$;
    create table clients (id uuid primary key);
    create table client_campaigns (
      id uuid primary key default gen_random_uuid(), client_id uuid not null references clients(id),
      name text not null, brief text not null, status text not null default 'planning',
      ideate_on_plan boolean not null default true,
      meta_campaign_id text, approved_at timestamptz,
      unique (id, client_id)
    );
    create table agent_jobs (
      id uuid primary key, agent_key text, input_table text, input_id uuid, status text
    );
    create function enqueue_agent_job_internal(text, uuid, text, uuid, uuid, jsonb, text)
    returns uuid language sql as $$ select gen_random_uuid() $$;
  `);
  const migration = await readFile(new URL("../../supabase/migrations/20261015190000_203_v6_campaign_mode.sql", import.meta.url), "utf8");
  await db.exec(migration);
  await db.exec(`
    insert into clients(id) values ('${clientA}'), ('${clientB}');
    insert into client_campaigns(id,client_id,name,brief,meta_campaign_id,approved_at)
      values ('${source}','${clientA}','Original','A genuine source brief','12345',now());
    select set_config('request.jwt.claim.role','service_role',false);
  `);
});

afterAll(async () => { await db?.close(); });

it("keeps pre-v6 campaigns in an explicit legacy state", async () => {
  const result = await db.query<{ acquisition_mode: string; paid_platform: string | null }>(
    "select acquisition_mode,paid_platform from client_campaigns where id=$1", [source]);
  expect(result.rows[0]).toEqual({ acquisition_mode: "legacy", paid_platform: null });
});

it("clones only the brief into an independent paid campaign with lineage", async () => {
  const result = await db.query<{ clone_campaign_for_route: string }>(
    "select clone_campaign_for_route($1,$2,$3,$4)", [source, "paid", "meta", "Paid rebuild"]);
  const id = result.rows[0]!.clone_campaign_for_route;
  const row = await db.query<{
    client_id: string; name: string; brief: string; acquisition_mode: string;
    paid_platform: string; cloned_from_campaign_id: string; status: string;
    meta_campaign_id: string | null; approved_at: string | null;
  }>("select * from client_campaigns where id=$1", [id]);
  expect(row.rows[0]).toMatchObject({
    client_id: clientA, name: "Paid rebuild", brief: "A genuine source brief",
    acquisition_mode: "paid", paid_platform: "meta", cloned_from_campaign_id: source,
    status: "planning", meta_campaign_id: null, approved_at: null,
  });
  await expect(db.query("update client_campaigns set acquisition_mode='organic', paid_platform=null where id=$1", [id]))
    .rejects.toThrow(/immutable/);
  await expect(db.query("select request_meta_build($1)", [id]))
    .rejects.toThrow(/human approval/);
});

it("rejects an incomplete paid route and cross-client lineage", async () => {
  await expect(db.query("select clone_campaign_for_route($1,$2,$3,$4)", [source, "paid", null, "Bad route"]))
    .rejects.toThrow(/Choose organic/);
  await expect(db.query(
    "insert into client_campaigns(client_id,name,brief,acquisition_mode,cloned_from_campaign_id) values ($1,$2,$3,$4,$5)",
    [clientB, "Cross-client", "Invalid", "organic", source],
  )).rejects.toThrow(/foreign key/);
});
