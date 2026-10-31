import { PGlite } from "@electric-sql/pglite";
import { readFile } from "node:fs/promises";
import { beforeAll, describe, expect, it } from "vitest";
import { Readable } from "node:stream";
import type { IncomingMessage } from "node:http";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { RuntimeConfig } from "../config.js";
import { parseTrustedProxies } from "./client-ip.js";
import { admitPublicRequest } from "./quota.js";

const IP = "a".repeat(64);
const SUBJECT = "b".repeat(64);
let db: PGlite;
const admit = async (route: string, ip = IP, subject = SUBJECT) => {
  const result = await db.query<{ allowed: boolean }>(
    "select public.admit_public_route_v6($1,$2,$3) as allowed",
    [route, ip, subject],
  );
  return result.rows[0]?.allowed;
};

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    create role anon; create role authenticated; create role service_role bypassrls;
    create schema auth; create schema cron;
    create function auth.role() returns text language sql stable as
      $$ select current_setting('test.role', true) $$;
    create function cron.schedule(text,text,text) returns bigint language sql as
      $$ select 1::bigint $$;
    select set_config('test.role','service_role',false);
  `);
  await db.exec(await readFile(new URL(
    "../../../supabase/migrations/20261101000000_283_public_route_quota.sql", import.meta.url), "utf8"));
});

describe("shared atomic public admission", () => {
  it("shares quota between two independent runtime clients backed by one database", async () => {
    const adapter = () => ({ rpc: async (_name: string, args: Record<string, string>) => {
      const result = await db.query<{ allowed: boolean }>(
        "select public.admit_public_route_v6($1,$2,$3) as allowed",
        [args.p_route, args.p_ip_hash, args.p_subject_hash]);
      return { data: result.rows[0]?.allowed, error: null };
    } }) as unknown as SupabaseClient;
    const config = { publicIpSalt: "test-public-salt", trustedProxies: parseTrustedProxies(undefined) } as RuntimeConfig;
    const request = () => {
      const req = Readable.from([]) as IncomingMessage;
      req.headers = { "x-forwarded-for": "198.51.100.200" };
      Object.defineProperty(req, "socket", { value: { remoteAddress: "203.0.113.200" } });
      return req;
    };
    const replicaA = adapter(), replicaB = adapter();
    const results = await Promise.all(Array.from({ length: 12 }, (_, i) =>
      admitPublicRequest(request(), i % 2 ? replicaA : replicaB,
        config, "lead_submit", "one-token")));
    expect(results.filter((result) => result.allowed)).toHaveLength(10);
    expect(results.filter((result) => !result.allowed)).toHaveLength(2);
  });
  it("admits exactly one final token slot across concurrent callers", async () => {
    // These promises model two route handlers using the same PostgreSQL
    // ledger. Production PostgreSQL serializes conflicting UPSERT row locks.
    const results = await Promise.all(Array.from({ length: 12 }, () =>
      admit("lead_submit", "1".repeat(64), "2".repeat(64))));
    expect(results.filter(Boolean)).toHaveLength(10);
    expect(results.filter((ok) => !ok)).toHaveLength(2);
    const row = await db.query<{ attempts: number }>(`
      select attempts from public.public_route_quota_buckets
      where route='lead_submit' and bucket_kind='subject'
        and subject_hash=$1`, ["2".repeat(64)]);
    expect(row.rows[0]?.attempts).toBe(11);
  });

  it("limits rotating invalid subjects by the caller bucket", async () => {
    const results = await Promise.all(Array.from({ length: 33 }, (_, i) =>
      admit("lead_submit", "3".repeat(64), i.toString(16).padStart(64, "0"))));
    expect(results.filter(Boolean)).toHaveLength(30);
    const rows = await db.query<{ total: string }>(`
      select count(*)::text as total from public.public_route_quota_buckets
      where route='lead_submit' and bucket_kind='subject' and subject_hash like '000%'`);
    expect(Number(rows.rows[0]?.total)).toBe(30);
  });

  it("shares a global caller ceiling across different public routes", async () => {
    const ip = "4".repeat(64);
    const results = [];
    for (let i = 0; i < 65; i += 1) {
      const route = i % 2 === 0 ? "lead_submit" : "proof_config";
      results.push(await admit(route, ip, i.toString(16).padStart(64, "0")));
    }
    expect(results.filter(Boolean)).toHaveLength(60);
    expect(results.slice(60)).toEqual([false, false, false, false, false]);
  });

  it("denies unknown routes, malformed handles and non-service callers", async () => {
    expect(await admit("sales_config", "7".repeat(64), "8".repeat(64))).toBe(true);
    expect(await admit("booking_slots", "9".repeat(64), "0".repeat(64))).toBe(true);
    await expect(admit("unknown")).rejects.toThrow(/Unknown public quota route/);
    await expect(admit("lead_submit", "raw-ip")).rejects.toThrow(/Invalid public quota handle/);
    await db.exec("select set_config('test.role','authenticated',false)");
    await expect(admit("lead_submit")).rejects.toThrow(/service_role only/);
    await db.exec("select set_config('test.role','service_role',false)");
  });

  it("starts a fresh bucket at the next minute", async () => {
    const ip = "5".repeat(64), subject = "6".repeat(64);
    await db.query(`insert into public.public_route_quota_buckets
      (route,bucket_kind,subject_hash,window_start,attempts,expires_at)
      values ('lead_submit','subject',$1,date_trunc('minute',now())-interval '1 minute',
              11,now()+interval '1 hour')`, [subject]);
    expect(await admit("lead_submit", ip, subject)).toBe(true);
    const rows = await db.query<{ attempts: number }>(`
      select attempts from public.public_route_quota_buckets
      where route='lead_submit' and bucket_kind='subject' and subject_hash=$1
      order by window_start`, [subject]);
    expect(rows.rows.map((row) => row.attempts)).toEqual([11, 1]);
  });

  it("exposes aggregate metrics without caller or token handles", async () => {
    const metrics = await db.query<Record<string, unknown>>(
      "select * from public.public_route_quota_metrics_v6");
    expect(metrics.rows.length).toBeGreaterThan(0);
    expect(JSON.stringify(metrics.rows)).not.toContain("a".repeat(64));
    expect(metrics.rows[0]).not.toHaveProperty("subject_hash");
    const privileges = await db.query<{ anon_execute: boolean; authenticated_execute: boolean; service_execute: boolean; service_read: boolean }>(`
      select has_function_privilege('anon','public.admit_public_route_v6(text,text,text)','EXECUTE') as anon_execute,
             has_function_privilege('authenticated','public.admit_public_route_v6(text,text,text)','EXECUTE') as authenticated_execute,
             has_function_privilege('service_role','public.admit_public_route_v6(text,text,text)','EXECUTE') as service_execute,
             has_table_privilege('service_role','public.public_route_quota_buckets','SELECT') as service_read`);
    expect(privileges.rows[0]).toEqual({ anon_execute: false, authenticated_execute: false, service_execute: true, service_read: true });
  });
});
