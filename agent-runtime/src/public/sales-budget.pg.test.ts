import { PGlite } from "@electric-sql/pglite";
import { readFile } from "node:fs/promises";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

const DEPLOYMENT = "11111111-1111-4111-8111-111111111111";
const AGENT = "22222222-2222-4222-8222-222222222222";
let db: PGlite;
type Verdict = { allowed: boolean; reason: string; reservation_id: string | null };
const reserve = async (amount: number) => (await db.query<Verdict>(
  "select * from public.reserve_sales_runtime_v6($1,$2)", [DEPLOYMENT, amount])).rows[0]!;
const settle = async (id: string, amount: number) => (await db.query<{ overrun: boolean }>(
  "select public.settle_sales_runtime_v6($1,$2,null) as overrun", [id, amount])).rows[0]!.overrun;
const budget = async () => (await db.query<{ messages: number; committed_usd: string; held_usd: string }>(
  "select messages,committed_usd::text,held_usd::text from public.sales_runtime_daily_budgets where deployment_id=$1",
  [DEPLOYMENT])).rows[0];

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    create role anon; create role authenticated; create role service_role bypassrls;
    create schema auth; create schema cron;
    create function auth.role() returns text language sql stable as
      $$ select current_setting('test.role', true) $$;
    create function cron.schedule(text,text,text) returns bigint language sql as
      $$ select 1::bigint $$;
    create table public.client_sales_agents (
      id uuid primary key, status text, approved_at timestamptz, built_at timestamptz);
    create table public.client_sales_agent_deployments (
      id uuid primary key, client_id uuid, sales_agent_id uuid references public.client_sales_agents(id),
      enabled boolean, daily_message_limit integer, daily_cost_limit_usd numeric,
      disabled_at timestamptz);
    create table public.sales_runtime_requests (
      id uuid primary key default gen_random_uuid(), deployment_id uuid,
      outcome text, cost_usd numeric, occurred_at timestamptz default now());
    create function public.sales_runtime_allow(uuid,text,integer)
      returns boolean language sql as $$ select true $$;
    revoke execute on function public.sales_runtime_allow(uuid,text,integer)
      from public, anon, authenticated;
    grant execute on function public.sales_runtime_allow(uuid,text,integer) to service_role;
    insert into public.client_sales_agents
      values ('${AGENT}','live',now(),now());
    insert into public.client_sales_agent_deployments
      values ('${DEPLOYMENT}',null,'${AGENT}',true,3,1.00,null);
    select set_config('test.role','service_role',false);
  `);
  await db.exec(await readFile(new URL(
    "../../../supabase/migrations/20261101010000_281_sales_runtime_budget_reservations.sql", import.meta.url), "utf8"));
});

beforeEach(async () => {
  await db.exec(`
    select set_config('test.role','service_role',false);
    delete from public.sales_runtime_requests;
    delete from public.sales_runtime_reservations;
    delete from public.sales_runtime_daily_budgets;
    update public.client_sales_agent_deployments
      set enabled=true,daily_message_limit=3,daily_cost_limit_usd=1.00,disabled_at=null;
  `);
});

describe("atomic paid widget reservations", () => {
  it("admits only the common daily ceiling under concurrent callers", async () => {
    const results = await Promise.all(Array.from({ length: 8 }, () => reserve(0.3)));
    expect(results.filter((row) => row.allowed)).toHaveLength(3);
    expect(results.filter((row) => !row.allowed)).toHaveLength(5);
    expect((await budget())?.messages).toBe(3);
    expect(Number((await budget())?.held_usd)).toBeCloseTo(0.9);
  });

  it("settles actual spend once and frees the unused hold", async () => {
    const first = await reserve(0.8);
    expect(first.allowed).toBe(true);
    expect(await reserve(0.3)).toMatchObject({ allowed: false, reason: "daily_ceiling" });
    expect(await settle(first.reservation_id!, 0.1)).toBe(false);
    expect(await settle(first.reservation_id!, 0.1)).toBe(false);
    await expect(settle(first.reservation_id!, 0.2)).rejects.toThrow(/Conflicting/);
    expect(Number((await budget())?.held_usd)).toBe(0);
    expect(Number((await budget())?.committed_usd)).toBeCloseTo(0.1);
    expect((await reserve(0.3)).allowed).toBe(true);
  });

  it("holds ambiguous provider spend until reconciliation", async () => {
    const first = await reserve(0.8);
    await db.query("select public.mark_sales_runtime_uncertain_v6($1)", [first.reservation_id]);
    expect((await reserve(0.3)).allowed).toBe(false);
    const status = await db.query<{ uncertain_count: number }>(`
      select uncertain_count from public.sales_runtime_budget_status_v6
       where deployment_id=$1`, [DEPLOYMENT]);
    expect(status.rows[0]?.uncertain_count).toBe(1);
    expect(await settle(first.reservation_id!, 0.2)).toBe(false);
    expect((await reserve(0.3)).allowed).toBe(true);
  });

  it("cancels a pre-model failure without consuming a message", async () => {
    const first = await reserve(0.8);
    const cancelled = await db.query<{ cancelled: boolean }>(
      "select public.cancel_sales_runtime_reservation_v6($1) as cancelled", [first.reservation_id]);
    expect(cancelled.rows[0]?.cancelled).toBe(true);
    expect((await budget())?.messages).toBe(0);
    expect(Number((await budget())?.held_usd)).toBe(0);
    expect((await reserve(0.8)).allowed).toBe(true);
  });

  it("seeds its first daily budget from legacy completed requests", async () => {
    await db.query(`insert into public.sales_runtime_requests(deployment_id,outcome,cost_usd)
      values ($1,'ok',0.8)`, [DEPLOYMENT]);
    expect((await reserve(0.3)).allowed).toBe(false);
    expect((await budget())?.messages).toBe(1);
    expect(Number((await budget())?.committed_usd)).toBeCloseTo(0.8);
  });

  it("stops a deployment if actual cost exceeds its conservative reserve", async () => {
    const first = await reserve(0.1);
    expect(await settle(first.reservation_id!, 0.2)).toBe(true);
    const state = await db.query<{ enabled: boolean }>(
      "select enabled from public.client_sales_agent_deployments where id=$1", [DEPLOYMENT]);
    expect(state.rows[0]?.enabled).toBe(false);
    expect((await reserve(0.1)).allowed).toBe(false);
  });

  it("refuses authenticated callers and malformed amounts", async () => {
    await db.exec("select set_config('test.role','authenticated',false)");
    await expect(reserve(0.1)).rejects.toThrow(/service_role only/);
    await db.exec("select set_config('test.role','service_role',false)");
    await expect(reserve(0)).rejects.toThrow(/Invalid sales runtime reserve/);
    const grants = await db.query<{ anon: boolean; service: boolean }>(`
      select has_function_privilege('anon','public.reserve_sales_runtime_v6(uuid,numeric)','EXECUTE') as anon,
             has_function_privilege('service_role','public.reserve_sales_runtime_v6(uuid,numeric)','EXECUTE') as service`);
    expect(grants.rows[0]).toEqual({ anon: false, service: true });
    const legacy = await db.query<{ service: boolean }>(`
      select has_function_privilege('service_role',
        'public.sales_runtime_allow(uuid,text,integer)','EXECUTE') as service`);
    expect(legacy.rows[0]?.service).toBe(false);
  });
});
