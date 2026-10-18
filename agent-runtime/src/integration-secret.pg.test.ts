import { PGlite } from "@electric-sql/pglite";
import { readFile } from "node:fs/promises";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

/**
 * Migration 156 against a real Postgres.
 *
 * The deadlock this undoes: only a successful ingest writes 'active', an
 * ingest cannot succeed without the token, and the token required 'active'.
 * So the test that matters is not "a connected integration can be read" on
 * its own — it is that the two lookups in the chain now agree, because the
 * bug was that they did not. metrics_ingest accepted ['connected','active']
 * from 24 September; integration_secret kept filtering on 'active' alone for
 * another two weeks.
 */
let db: PGlite;

const migration = (file: string) =>
  readFile(new URL(`../../supabase/migrations/${file}`, import.meta.url), "utf8");

const CLIENT = "11111111-1111-4111-8111-111111111111";

async function one<T = Record<string, unknown>>(sql: string): Promise<T> {
  return (await db.query<T>(sql)).rows[0]!;
}

const secretFor = async (provider: string) =>
  (await one<{ v: string | null }>(`select integration_secret('${CLIENT}', '${provider}') as v`)).v;

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    create schema vault;
    create table clients (id uuid primary key, name text);
    create table client_integrations (
      id uuid primary key default gen_random_uuid(),
      client_id uuid references clients(id) on delete cascade,
      provider text not null,
      status text not null,
      credential_label text,
      credential_secret_id uuid
    );
    -- Stands in for Supabase's Vault, which PGlite does not have. The
    -- function only ever reads decrypted_secrets by id.
    create table vault.decrypted_secrets (id uuid primary key, decrypted_secret text);

    insert into clients (id, name) values ('${CLIENT}', 'Harbour');
  `);

  await db.exec(await migration("20261006160000_156_integration_secret_takes_connected.sql"));
});

beforeEach(async () => {
  await db.exec(`delete from client_integrations; delete from vault.decrypted_secrets;`);
  for (const [provider, status] of [
    ["meta", "connected"],
    ["instagram", "active"],
    ["facebook", "error"],
    ["tiktok", "expiring"],
  ]) {
    const { id } = await one<{ id: string }>(
      `insert into vault.decrypted_secrets (id, decrypted_secret)
       values (gen_random_uuid(), 'token-for-${provider}') returning id`,
    );
    await db.exec(
      `insert into client_integrations (client_id, provider, status, credential_label, credential_secret_id)
       values ('${CLIENT}', '${provider}', '${status}', 'label', '${id}')`,
    );
  }
});

describe("reading a token", () => {
  it("hands over the token for a connected integration", async () => {
    // The whole bug. Before 156 this was null, and the agent told a client
    // who had just connected Meta that they had no integration.
    expect(await secretFor("meta")).toBe("token-for-meta");
  });

  it("still hands over the token for an active one", async () => {
    expect(await secretFor("instagram")).toBe("token-for-instagram");
  });

  it("refuses a token known not to work", async () => {
    // error and expiring are different from "not used yet": something has
    // already found out that this token fails.
    expect(await secretFor("facebook")).toBeNull();
    expect(await secretFor("tiktok")).toBeNull();
  });

  it("returns null for a provider this client has not connected", async () => {
    expect(await secretFor("youtube")).toBeNull();
  });

  it("returns null rather than failing when the secret is gone from the vault", async () => {
    await db.exec(`delete from vault.decrypted_secrets`);
    expect(await secretFor("meta")).toBeNull();
  });
});

describe("the two lookups in the chain agree", () => {
  it("accepts exactly the states metrics_ingest accepts", async () => {
    // The fault was a disagreement, not a wrong value: the agent's own
    // filter had said ['connected','active'] since 24 September. Asserting
    // the pair keeps them from drifting apart again.
    const readable: string[] = [];
    for (const provider of ["meta", "instagram", "facebook", "tiktok"]) {
      if ((await secretFor(provider)) !== null) readable.push(provider);
    }
    // meta is connected, instagram is active; facebook and tiktok are not.
    expect(readable.sort()).toEqual(["instagram", "meta"]);
  });

  it("is the states the scheduler enqueues from", async () => {
    const { def } = await one<{ def: string }>(
      `select pg_get_functiondef('public.integration_secret'::regproc) as def`,
    );
    expect(def).toMatch(/status in \('connected', 'active'\)/);
  });
});
