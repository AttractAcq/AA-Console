import { PGlite } from "@electric-sql/pglite";
import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Execute the repository's Auth trigger/provisioner SQL and migration 270 in
// Postgres. The small staff tables below reproduce the pre-270 policies so
// the tests prove a previously reachable chat path closes under real RLS.
let db: PGlite;
let adminId: string;
let linkedId: string;
let unlinkedId: string;
let retiredId: string;
let retiredMemberId: string;

const migration = (file: string) =>
  readFile(new URL(`../../supabase/migrations/${file}`, import.meta.url), "utf8");

async function createUser(email: string, role: "admin" | "employee" | "client", category?: "smm") {
  const result = await db.query<{ create_console_user: string }>(
    `select public.create_console_user($1, $2, $3::public.app_role, $4,
       $5::public.team_category)`,
    [email, "test-only-password", role, email, category ?? null],
  );
  return result.rows[0]!.create_console_user;
}

async function asUser<T extends Record<string, unknown>>(
  id: string,
  sql: string,
  params: unknown[] = [],
): Promise<T[]> {
  await db.query("select set_config('request.jwt.claim.sub', $1, false)", [id]);
  await db.exec("set role authenticated");
  try {
    return (await db.query<T>(sql, params)).rows;
  } finally {
    await db.exec("reset role");
  }
}

beforeAll(async () => {
  db = new PGlite();
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
  `);

  await db.exec(await migration("20260903104450_01_foundations_roles_clients.sql"));
  await db.exec(await migration("20260903104529_02_team_and_operations.sql"));

  // Migration 127 replaced this helper with an active-member check. Execute
  // its actual definition without pulling in unrelated schema dependencies.
  const retired = await migration("20260925110000_127_retired_team_access.sql");
  const memberHelperStart = retired.indexOf("create or replace function current_member_id()");
  const memberHelperEnd = retired.indexOf("$$;", memberHelperStart) + 3;
  if (memberHelperStart < 0 || memberHelperEnd < 3) throw new Error("Migration 127 member helper changed");
  await db.exec(retired.slice(memberHelperStart, memberHelperEnd));

  // Migration 11's function definitions are used verbatim. Its five fixed
  // seed accounts and extension install are excluded from this focused DB.
  const original = await migration("20260903105742_11_auth_users_and_role_metadata.sql");
  const from = original.indexOf("-- ---------- profiles carry the employee sub-role ----------");
  const until = original.indexOf("-- The five accounts");
  const seedHeader = original.lastIndexOf("-- ============================================================", until);
  if (from < 0 || until < 0 || seedHeader < from) throw new Error("Migration 11 function section changed");
  await db.exec(original.slice(from, seedHeader));
  await db.exec(await migration("20261029140000_263_auth_signup_role_hardening.sql"));

  adminId = await createUser("admin-270@example.com", "admin");
  linkedId = await createUser("linked-270@example.com", "employee", "smm");
  retiredId = await createUser("retired-270@example.com", "employee", "smm");
  const retiredMember = await db.query<{ id: string }>(
    `insert into public.team_members (user_id, category, name, initials, active)
     values ($1, 'smm', 'Retired', 'RE', false) returning id`, [retiredId],
  );
  retiredMemberId = retiredMember.rows[0]!.id;
  await db.query(
    `insert into public.team_members (user_id, category, name, initials, active)
     values ($1, 'smm', 'Linked', 'LI', true)`, [linkedId],
  );

  unlinkedId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  await db.query(
    `insert into auth.users (id, email, raw_user_meta_data)
     values ($1, 'unlinked-270@example.com', '{"role":"admin"}'::jsonb)`, [unlinkedId],
  );
  expect((await db.query<{ role: string }>(
    "select role::text from public.profiles where id = $1", [unlinkedId],
  )).rows[0]?.role).toBe("employee");

  await db.exec(`
    create table public.team_channels (id uuid primary key default gen_random_uuid(), name text);
    create table public.team_messages (
      id uuid primary key default gen_random_uuid(), channel_id uuid,
      author_id uuid, body text
    );
    alter table public.team_channels enable row level security;
    alter table public.team_messages enable row level security;
    create policy tc_staff_read on public.team_channels for select to authenticated
      using (public.current_role_of() in ('admin','employee'));
    create policy tmsg_staff_read on public.team_messages for select to authenticated
      using (public.current_role_of() in ('admin','employee'));
    create policy tmsg_staff_insert on public.team_messages for insert to authenticated
      with check (public.current_role_of() in ('admin','employee') and author_id = auth.uid());
    insert into public.team_channels (name) values ('Agency chat');
    insert into public.team_messages (author_id, body) values
      ('${adminId}', 'Private team message');
    grant usage on schema public, auth to authenticated;
    grant select, insert, update on all tables in schema public to authenticated;
  `);

  // A role-only rule exposes shared chat to an unlinked Auth user. Preserve
  // this negative baseline before applying the actual migration.
  expect(await asUser<{ name: string }>(unlinkedId, "select name from public.team_channels")).toHaveLength(1);

  await db.exec(await migration("20261029210000_270_default_deny_auth_and_active_staff.sql"));
}, 60_000);

afterAll(async () => {
  await db?.close();
});

describe("default-deny Auth and active staff boundary", () => {
  it("creates no console profile for a fresh, unprovisioned Auth identity", async () => {
    const freshId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    await db.query(
      `insert into auth.users (id, email, raw_user_meta_data)
       values ($1, 'fresh-270@example.com', '{"role":"admin","employee_category":"smm"}'::jsonb)`,
      [freshId],
    );
    expect((await db.query("select 1 from public.profiles where id = $1", [freshId])).rows).toHaveLength(0);
    expect(await asUser<{ is_admin: boolean; member_id: string | null }>(
      freshId, "select public.is_admin(), public.current_member_id() as member_id",
    )).toEqual([{ is_admin: false, member_id: null }]);
    expect(await asUser(freshId, "select id from public.team_channels")).toHaveLength(0);
  });

  it("hides agency-wide chat from legacy unlinked or retired employees", async () => {
    for (const id of [unlinkedId, retiredId]) {
      expect(await asUser(id, "select id from public.team_channels")).toHaveLength(0);
      expect(await asUser(id, "select id from public.team_messages")).toHaveLength(0);
      await expect(asUser(id,
        "insert into public.team_messages (author_id, body) values ($1, 'probe') returning id", [id],
      )).rejects.toThrow(/row-level security/i);
    }
  });

  it("keeps active staff and administrators able to use shared chat", async () => {
    for (const id of [linkedId, adminId]) {
      expect(await asUser(id, "select id from public.team_channels")).toHaveLength(1);
      expect(await asUser(id,
        "select id from public.team_messages where body = 'Private team message'",
      )).toHaveLength(1);
      expect(await asUser(id,
        "insert into public.team_messages (author_id, body) values ($1, 'allowed') returning id", [id],
      )).toHaveLength(1);
    }
  });

  it("blocks self category, role and active-state edits while preserving admin writes", async () => {
    expect(await asUser(linkedId,
      "update public.profiles set employee_category = 'avatars' where id = $1 returning id", [linkedId],
    )).toHaveLength(0);
    expect(await asUser(linkedId,
      "update public.profiles set role = 'admin' where id = $1 returning id", [linkedId],
    )).toHaveLength(0);
    expect(await asUser(retiredId,
      "update public.team_members set active = true where id = $1 returning id", [retiredMemberId],
    )).toHaveLength(0);
    expect(await asUser(linkedId,
      "update public.team_members set category = 'avatars' where user_id = $1 returning id", [linkedId],
    )).toHaveLength(0);
    expect(await asUser(adminId,
      "update public.team_members set active = true where id = $1 returning id", [retiredMemberId],
    )).toHaveLength(1);
  });

  it("keeps trusted provisioning functional after the Auth trigger becomes a no-op", async () => {
    const clientId = await createUser("trusted-270@example.com", "client");
    const profile = await db.query<{ role: string }>(
      "select role::text from public.profiles where id = $1", [clientId],
    );
    expect(profile.rows[0]?.role).toBe("client");
    expect((await db.query("select 1 from auth.identities where user_id = $1", [clientId])).rows).toHaveLength(1);
  });
});
