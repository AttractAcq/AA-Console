import { PGlite } from "@electric-sql/pglite";
import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Execute the repository's Auth trigger/provisioner SQL and migration 270 in
// Postgres. The focused chat setup runs migration 16's actual membership
// policies and migration 47's name helper before applying 270.
let db: PGlite;
let adminId: string;
let linkedId: string;
let nonmemberId: string;
let unlinkedId: string;
let retiredId: string;
let clientId: string;
let channelId: string;
let retiredMessageId: string;
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
  nonmemberId = await createUser("nonmember-270@example.com", "employee", "smm");
  retiredId = await createUser("retired-270@example.com", "employee", "smm");
  clientId = await createUser("client-270@example.com", "client");
  const retiredMember = await db.query<{ id: string }>(
    `insert into public.team_members (user_id, category, name, initials, active)
     values ($1, 'smm', 'Retired', 'RE', false) returning id`, [retiredId],
  );
  retiredMemberId = retiredMember.rows[0]!.id;
  await db.query(
    `insert into public.team_members (user_id, category, name, initials, active)
     values ($1, 'smm', 'Linked', 'LI', true)`, [linkedId],
  );
  await db.query(
    `insert into public.team_members (user_id, category, name, initials, active)
     values ($1, 'smm', 'Nonmember', 'NM', true)`, [nonmemberId],
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
      id uuid primary key default gen_random_uuid(),
      channel_id uuid references public.team_channels(id),
      author_id uuid references public.profiles(id), body text
    );
    alter table public.team_channels enable row level security;
    alter table public.team_messages enable row level security;
    create policy tc_admin_all on public.team_channels for all to authenticated
      using (public.is_admin()) with check (public.is_admin());
    create policy tc_staff_read on public.team_channels for select to authenticated
      using (public.current_role_of() in ('admin','employee'));
    create policy tmsg_staff_read on public.team_messages for select to authenticated
      using (public.current_role_of() in ('admin','employee'));
    create policy tmsg_staff_insert on public.team_messages for insert to authenticated
      with check (public.current_role_of() in ('admin','employee') and author_id = auth.uid());
    create policy tmsg_self_update on public.team_messages for update to authenticated
      using (author_id = auth.uid()) with check (author_id = auth.uid());
  `);

  const channelMigration = await migration("20260904084217_16_chat_channel_members.sql");
  const channelFrom = channelMigration.indexOf("create table channel_members (");
  const channelUntil = channelMigration.indexOf("-- ---------- realtime ----------", channelFrom);
  if (channelFrom < 0 || channelUntil < 0) throw new Error("Migration 16 chat policies changed");
  await db.exec(channelMigration.slice(channelFrom, channelUntil));

  const participantsMigration = await migration("20260906194104_47_chat_participants.sql");
  const participantsFrom = participantsMigration.indexOf("create or replace function chat_participants()");
  const participantsUntil = participantsMigration.indexOf("comment on function chat_participants()", participantsFrom);
  if (participantsFrom < 0 || participantsUntil < 0) throw new Error("Migration 47 chat helper changed");
  await db.exec(participantsMigration.slice(participantsFrom, participantsUntil));

  channelId = (await db.query<{ id: string }>(
    "insert into public.team_channels (name) values ('Agency chat') returning id",
  )).rows[0]!.id;
  await db.query(
    `insert into public.channel_members (channel_id, user_id)
     select $1, id from public.profiles where id = any($2::uuid[])`,
    [channelId, [adminId, linkedId, unlinkedId, retiredId, clientId]],
  );
  await db.query(
    "insert into public.team_messages (channel_id, author_id, body) values ($1, $2, 'Private team message')",
    [channelId, adminId],
  );
  retiredMessageId = (await db.query<{ id: string }>(
    `insert into public.team_messages (channel_id, author_id, body)
     values ($1, $2, 'Retired message') returning id`, [channelId, retiredId],
  )).rows[0]!.id;

  await db.exec(`
    grant usage on schema public, auth to authenticated;
    grant select, insert, update on all tables in schema public to authenticated;
  `);

  // Explicit channel membership still exposed chat to an employee with no
  // live team record. Preserve this negative baseline before 270.
  expect(await asUser<{ name: string }>(unlinkedId, "select name from public.team_channels")).toHaveLength(1);
  expect(await asUser<{ display_name: string }>(retiredId,
    "select display_name from public.chat_participants()",
  )).not.toHaveLength(0);

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
    expect(await asUser<{ is_channel_member: boolean }>(freshId,
      "select public.is_channel_member($1)", [channelId],
    )).toEqual([{ is_channel_member: false }]);
    expect(await asUser(freshId, "select id from public.team_channels")).toHaveLength(0);
  });

  it("hides channel content, membership and names from unlinked or retired employees", async () => {
    for (const id of [unlinkedId, retiredId]) {
      expect(await asUser<{ is_channel_member: boolean }>(id,
        "select public.is_channel_member($1)", [channelId],
      )).toEqual([{ is_channel_member: false }]);
      expect(await asUser(id, "select id from public.team_channels")).toHaveLength(0);
      expect(await asUser(id, "select id from public.team_messages")).toHaveLength(0);
      expect(await asUser(id, "select channel_id from public.channel_members")).toHaveLength(0);
      expect(await asUser(id, "select id from public.chat_participants()")).toHaveLength(0);
      await expect(asUser(id,
        "insert into public.team_messages (channel_id, author_id, body) values ($1, $2, 'probe') returning id",
        [channelId, id],
      )).rejects.toThrow(/row-level security/i);
    }
    expect(await asUser(retiredId,
      "update public.team_messages set body = 'edited' where id = $1 returning id", [retiredMessageId],
    )).toHaveLength(0);
  });

  it("keeps channel members among active staff, clients and admins able to use chat", async () => {
    for (const id of [linkedId, clientId, adminId]) {
      expect(await asUser<{ is_channel_member: boolean }>(id,
        "select public.is_channel_member($1)", [channelId],
      )).toEqual([{ is_channel_member: true }]);
      expect(await asUser(id, "select id from public.team_channels")).toHaveLength(1);
      expect(await asUser(id,
        "select id from public.team_messages where body = 'Private team message'",
      )).toHaveLength(1);
      expect(await asUser(id, "select channel_id from public.channel_members")).toHaveLength(5);
      expect(await asUser(id, "select id from public.chat_participants()")).toHaveLength(5);
      expect(await asUser(id,
        "insert into public.team_messages (channel_id, author_id, body) values ($1, $2, 'allowed') returning id",
        [channelId, id],
      )).toHaveLength(1);
    }
  });

  it("still requires explicit channel membership for active staff", async () => {
    expect(await asUser<{ is_channel_member: boolean }>(nonmemberId,
      "select public.is_channel_member($1)", [channelId],
    )).toEqual([{ is_channel_member: false }]);
    expect(await asUser(nonmemberId, "select id from public.team_channels")).toHaveLength(0);
    expect(await asUser(nonmemberId, "select id from public.team_messages")).toHaveLength(0);
    expect(await asUser(nonmemberId, "select channel_id from public.channel_members")).toHaveLength(0);
    expect(await asUser(nonmemberId, "select id from public.chat_participants()")).toHaveLength(0);
    await expect(asUser(nonmemberId,
      "insert into public.team_messages (channel_id, author_id, body) values ($1, $2, 'probe') returning id",
      [channelId, nonmemberId],
    )).rejects.toThrow(/row-level security/i);
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
