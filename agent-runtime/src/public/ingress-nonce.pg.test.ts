import { PGlite } from "@electric-sql/pglite";
import { readFile } from "node:fs/promises";
import { beforeAll, describe, expect, it } from "vitest";

let db: PGlite;
const claim = async (hash: string, issuedAt = new Date().toISOString()): Promise<boolean> => {
  const result = await db.query<{ claimed: boolean }>(
    "select public.claim_public_ingress_nonce_v1($1,$2::timestamptz) as claimed",
    [hash, issuedAt]);
  return result.rows[0]?.claimed === true;
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
    "../../../supabase/migrations/20261101000000_280_public_route_quota.sql", import.meta.url), "utf8"));
});

describe("atomic ingress nonce claim", () => {
  it("admits exactly one of simultaneous replica claims", async () => {
    const hash = "a".repeat(64);
    const issuedAt = new Date().toISOString();
    const results = await Promise.all(Array.from({ length: 16 }, () => claim(hash, issuedAt)));
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(results.filter((value) => !value)).toHaveLength(15);
    const rows = await db.query<{ count: string }>(
      "select count(*)::text as count from public.public_ingress_nonces_v1 where nonce_hash=$1", [hash]);
    expect(rows.rows[0]?.count).toBe("1");
  });

  it("rejects stale, future and malformed claims without inserting a row", async () => {
    expect(await claim("b".repeat(64), new Date(Date.now() - 60_000).toISOString())).toBe(false);
    expect(await claim("c".repeat(64), new Date(Date.now() + 60_000).toISOString())).toBe(false);
    await expect(claim("raw-nonce")).rejects.toThrow(/Invalid public ingress nonce/);
    const count = await db.query<{ count: string }>(
      "select count(*)::text as count from public.public_ingress_nonces_v1");
    expect(count.rows[0]?.count).toBe("1");
  });

  it("keeps the claim function and table unavailable to browser roles", async () => {
    const access = await db.query<{ anon: boolean; authenticated: boolean; service: boolean; table_insert: boolean }>(`
      select has_function_privilege('anon','public.claim_public_ingress_nonce_v1(text,timestamptz)','EXECUTE') as anon,
             has_function_privilege('authenticated','public.claim_public_ingress_nonce_v1(text,timestamptz)','EXECUTE') as authenticated,
             has_function_privilege('service_role','public.claim_public_ingress_nonce_v1(text,timestamptz)','EXECUTE') as service,
             has_table_privilege('authenticated','public.public_ingress_nonces_v1','INSERT') as table_insert`);
    expect(access.rows[0]).toEqual({ anon: false, authenticated: false, service: true, table_insert: false });
    await db.exec("select set_config('test.role','authenticated',false)");
    await expect(claim("d".repeat(64))).rejects.toThrow(/service_role only/);
    await db.exec("select set_config('test.role','service_role',false)");
  });
});
