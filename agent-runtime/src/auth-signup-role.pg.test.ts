import { PGlite } from "@electric-sql/pglite";
import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Run the original foundation and provisioning functions against Postgres,
// then apply 263. The extension functions below are test-only password stubs;
// role assignment and trigger behavior use the repository's actual SQL.
let db: PGlite;
let adminId: string;

const legacy = "20260903105742_11_auth_users_and_role_metadata.sql";
const hardening = "20261029140000_263_auth_signup_role_hardening.sql";
const migration = (file: string) =>
  readFile(new URL(`../../supabase/migrations/${file}`, import.meta.url), "utf8");

const ATTACKER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

async function roleFor(id: string): Promise<{ role: string; employee_category: string | null; full_name: string | null }> {
  const result = await db.query<{ role: string; employee_category: string | null; full_name: string | null }>(
    `select role::text, employee_category::text, full_name from public.profiles where id = $1`, [id],
  );
  return result.rows[0]!;
}

async function isAdmin(id: string): Promise<boolean> {
  await db.query("select set_config('request.jwt.claim.sub', $1, false)", [id]);
  const result = await db.query<{ is_admin: boolean }>("select public.is_admin()");
  return result.rows[0]!.is_admin;
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

  // Execute migration 11's actual function definitions without its extension
  // install or five environment-specific seed accounts.
  const original = await migration(legacy);
  const from = original.indexOf("-- ---------- profiles carry the employee sub-role ----------");
  const until = original.indexOf("-- The five accounts");
  if (from < 0 || until < 0) throw new Error("Migration 11 function section changed");
  const seedHeader = original.lastIndexOf("-- ============================================================", until);
  await db.exec(original.slice(from, seedHeader));

  const seeded = await db.query<{ create_console_user: string }>(
    "select public.create_console_user($1, $2, 'admin'::public.app_role, $3)",
    ["alex-test@attractacq.com", "test-password", "Alex Test"],
  );
  adminId = seeded.rows[0]!.create_console_user;
  expect(await roleFor(adminId)).toMatchObject({ role: "admin" });

  await db.exec(await migration(hardening));
}, 60_000);

afterAll(async () => {
  await db?.close();
});

describe("signup role hardening", () => {
  it("ignores forged admin role and team category in editable signup metadata", async () => {
    await db.query(
      `insert into auth.users (id, email, raw_user_meta_data)
       values ($1, $2, $3::jsonb)`,
      [ATTACKER, "attacker@example.com", JSON.stringify({ full_name: "Attacker", role: "admin", employee_category: "smm" })],
    );
    expect(await roleFor(ATTACKER)).toEqual({ role: "employee", employee_category: null, full_name: "Attacker" });
    expect(await isAdmin(ATTACKER)).toBe(false);
  });

  it("keeps an existing legitimate administrator privileged when 263 is applied", async () => {
    expect(await roleFor(adminId)).toMatchObject({ role: "admin", full_name: "Alex Test" });
    expect(await isAdmin(adminId)).toBe(true);
  });

  it("lets the restricted provisioning helper explicitly assign a seed role after the trigger", async () => {
    const result = await db.query<{ create_console_user: string }>(
      "select public.create_console_user($1, $2, 'client'::public.app_role, $3)",
      ["trusted-client@attractacq.com", "test-password", "Trusted Client"],
    );
    const clientId = result.rows[0]!.create_console_user;
    expect(await roleFor(clientId)).toMatchObject({ role: "client", employee_category: null });
    expect(await isAdmin(clientId)).toBe(false);

    const authBefore = (await db.query<{
      encrypted_password: string; raw_app_meta_data: unknown; raw_user_meta_data: unknown;
    }>(`select encrypted_password, raw_app_meta_data, raw_user_meta_data
          from auth.users where id = $1`, [clientId])).rows[0]!;

    // A repeat seed may update the trusted profile, but must leave the Auth
    // password hash and both metadata fields untouched.
    await db.query(
      "select public.create_console_user($1, $2, 'client'::public.app_role, $3)",
      ["trusted-client@attractacq.com", "different-password", "Trusted Client Updated"],
    );
    expect(await roleFor(clientId)).toMatchObject({ role: "client", full_name: "Trusted Client Updated" });
    const authAfter = (await db.query<{
      encrypted_password: string; raw_app_meta_data: unknown; raw_user_meta_data: unknown;
    }>(`select encrypted_password, raw_app_meta_data, raw_user_meta_data
          from auth.users where id = $1`, [clientId])).rows[0]!;
    expect(authAfter).toEqual(authBefore);
  });

  it("preserves client and team links when trusted provisioning repeats", async () => {
    const clientAccount = (await db.query<{ create_console_user: string }>(
      "select public.create_console_user($1, $2, 'client'::public.app_role, $3)",
      ["linked-client@attractacq.com", "first-password", "Linked Client"],
    )).rows[0]!.create_console_user;
    const employeeAccount = (await db.query<{ create_console_user: string }>(
      "select public.create_console_user($1, $2, 'employee'::public.app_role, $3, 'smm'::public.team_category)",
      ["linked-employee@attractacq.com", "first-password", "Linked Employee"],
    )).rows[0]!.create_console_user;
    const client = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    await db.query("insert into public.clients (id, name, initials) values ($1, 'Linked Client', 'LC')", [client]);
    await db.query("insert into public.client_users (client_id, user_id) values ($1, $2)", [client, clientAccount]);
    const member = (await db.query<{ id: string }>(
      `insert into public.team_members (user_id, category, name, initials, engagement)
       values ($1, 'smm', 'Linked Employee', 'LE', 'employee') returning id`, [employeeAccount],
    )).rows[0]!.id;
    await db.query("insert into public.client_assignments (member_id, client_id) values ($1, $2)", [member, client]);

    await db.query("select public.create_console_user($1, $2, 'client'::public.app_role, $3)",
      ["linked-client@attractacq.com", "unused-second-password", "Linked Client Updated"]);
    await db.query("select public.create_console_user($1, $2, 'employee'::public.app_role, $3, 'smm'::public.team_category)",
      ["linked-employee@attractacq.com", "unused-second-password", "Linked Employee Updated"]);

    expect(await roleFor(clientAccount)).toMatchObject({ role: "client", full_name: "Linked Client Updated" });
    expect(await roleFor(employeeAccount)).toMatchObject({
      role: "employee", employee_category: "smm", full_name: "Linked Employee Updated",
    });
    expect((await db.query("select 1 from public.client_users where client_id = $1 and user_id = $2",
      [client, clientAccount])).rows).toHaveLength(1);
    expect((await db.query("select 1 from public.team_members where id = $1 and user_id = $2 and category = 'smm'",
      [member, employeeAccount])).rows).toHaveLength(1);
    expect((await db.query("select 1 from public.client_assignments where member_id = $1 and client_id = $2",
      [member, client])).rows).toHaveLength(1);
  });

  it("keeps the trigger and provisioning helper unavailable as direct RPCs to public roles", async () => {
    const result = await db.query<{
      anon: boolean; authenticated: boolean;
      provision_anon: boolean; provision_authenticated: boolean;
    }>(`
      select has_function_privilege('anon', 'public.handle_new_user()', 'execute') as anon,
             has_function_privilege('authenticated', 'public.handle_new_user()', 'execute') as authenticated,
             has_function_privilege('anon',
               'public.create_console_user(text,text,public.app_role,text,public.team_category)',
               'execute') as provision_anon,
             has_function_privilege('authenticated',
               'public.create_console_user(text,text,public.app_role,text,public.team_category)',
               'execute') as provision_authenticated
    `);
    expect(result.rows[0]).toEqual({
      anon: false, authenticated: false, provision_anon: false, provision_authenticated: false,
    });
  });
});
