import { PGlite } from "@electric-sql/pglite";
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const migration = (file: string) =>
  readFile(new URL(`../../supabase/migrations/${file}`, import.meta.url), "utf8");

async function replayDatabase(): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(`
    create role anon; create role authenticated; create role service_role;
    create schema auth; create schema extensions;
    create table auth.users (
      instance_id uuid, id uuid primary key, aud text, role text, email text unique,
      encrypted_password text, email_confirmed_at timestamptz,
      raw_app_meta_data jsonb, raw_user_meta_data jsonb,
      created_at timestamptz, updated_at timestamptz,
      confirmation_token text, recovery_token text,
      email_change_token_new text, email_change text
    );
    create table auth.identities (
      id uuid primary key, user_id uuid references auth.users(id), identity_data jsonb,
      provider text, provider_id text, last_sign_in_at timestamptz,
      created_at timestamptz, updated_at timestamptz
    );
    create function auth.uid() returns uuid language sql stable as
      $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    create function extensions.gen_salt(text) returns text language sql as
      $$ select 'test-only-salt'::text $$;
    create function extensions.crypt(text, text) returns text language sql as
      $$ select 'test-only-hash:' || $1 || ':' || $2 $$;
    create function extensions.gen_random_bytes(integer) returns bytea language sql volatile as
      $$ select decode(replace(gen_random_uuid()::text, '-', '') ||
                       replace(gen_random_uuid()::text, '-', ''), 'hex') $$;
  `);
  await db.exec(await migration("20260903104450_01_foundations_roles_clients.sql"));
  await db.exec(await migration("20260903104529_02_team_and_operations.sql"));
  return db;
}

async function applySource11(db: PGlite): Promise<void> {
  // PGlite has no pgcrypto extension. The test-only functions above stand in
  // for its crypto primitives; every other statement is migration 11 source.
  const sql = (await migration("20260903105742_11_auth_users_and_role_metadata.sql"))
    .replace("create extension if not exists pgcrypto with schema extensions;", "");
  await db.exec(sql);
}

describe("migration 11 source replay", () => {
  it("uses unique unknown passwords with no settings, not the known fallback", async () => {
    const db = await replayDatabase();
    try {
      await applySource11(db);
      const users = (await db.query<{
        email: string; encrypted_password: string;
      }>(`select email, encrypted_password from auth.users order by email`)).rows;
      expect(users).toHaveLength(5);
      expect(new Set(users.map((user) => user.encrypted_password)).size).toBe(5);
      for (const user of users) {
        expect(user.encrypted_password).not.toContain("change-me");
        expect(user.encrypted_password).toMatch(/^test-only-hash:[0-9a-f]{64}:test-only-salt$/);
      }
      const roles = (await db.query<{ email: string; role: string }>(`
        select email, role::text from public.profiles order by email
      `)).rows;
      expect(roles.find((row) => row.email === "alex@attractacq.com")?.role).toBe("admin");
      expect(roles.find((row) => row.email === "attractacquisition@attractacq.com")?.role).toBe("client");
    } finally {
      await db.close();
    }
  });

  it("does not rewrite an existing account's Auth fields on initial or repeat replay", async () => {
    const db = await replayDatabase();
    try {
      const id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
      await db.query(`
        insert into auth.users (id, email, encrypted_password, raw_app_meta_data,
          raw_user_meta_data, email_confirmed_at, updated_at)
        values ($1, 'alex@attractacq.com', 'existing-hash',
          '{"legacy":true}', '{"private_note":"owned by Auth"}', null,
          '2026-01-01T00:00:00Z')
      `, [id]);
      const before = (await db.query<{
        encrypted_password: string; raw_app_meta_data: unknown;
        raw_user_meta_data: unknown; email_confirmed_at: string | null; updated_at: string;
      }>(`select encrypted_password, raw_app_meta_data, raw_user_meta_data,
                 email_confirmed_at, updated_at from auth.users where id = $1`, [id])).rows[0]!;

      await applySource11(db);
      await db.query("select set_config('app.seed_admin_password', $1, false)",
        ["a-different-explicit-bootstrap-secret"]);
      await applySource11(db);

      const after = (await db.query<typeof before>(`
        select encrypted_password, raw_app_meta_data, raw_user_meta_data,
               email_confirmed_at, updated_at from auth.users where id = $1
      `, [id])).rows[0]!;
      expect(after).toEqual(before);
      const profile = (await db.query<{ role: string }>(`
        select role::text from public.profiles where id = $1
      `, [id])).rows[0]!;
      expect(profile.role).toBe("admin");
    } finally {
      await db.close();
    }
  });

  it("does not trust role or employee category in signup metadata before 263", async () => {
    const db = await replayDatabase();
    try {
      await applySource11(db);
      const id = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
      await db.query(`insert into auth.users (id, email, raw_user_meta_data)
        values ($1, 'attacker@example.com', $2::jsonb)`,
        [id, JSON.stringify({ role: "admin", employee_category: "smm" })]);
      const profile = (await db.query<{ role: string; employee_category: string | null }>(`
        select role::text, employee_category::text from public.profiles where id = $1
      `, [id])).rows[0]!;
      expect(profile).toEqual({ role: "employee", employee_category: null });
    } finally {
      await db.close();
    }
  });

  it("rejects an explicitly configured weak bootstrap password", async () => {
    const db = await replayDatabase();
    try {
      await db.query("select set_config('app.seed_admin_password', 'change-me', false)");
      await expect(applySource11(db)).rejects.toThrow(/at least 16 characters/);
    } finally {
      await db.close();
    }
  });
});
