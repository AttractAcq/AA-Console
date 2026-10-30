import { PGlite } from "@electric-sql/pglite";
import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const ADMIN = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const EMPLOYEE = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
let db: PGlite;

async function asUser<T extends Record<string, unknown>>(
  userId: string, sql: string, params: unknown[] = [],
): Promise<T[]> {
  await db.query("select set_config('request.jwt.claim.sub', $1, false)", [userId]);
  await db.exec("set role authenticated");
  try {
    return (await db.query<T>(sql, params)).rows;
  } finally {
    await db.exec("reset role");
    await db.exec("select set_config('request.jwt.claim.sub', '', false)");
  }
}

const migration = (file: string) => readFile(
  new URL(`../../supabase/migrations/${file}`, import.meta.url), "utf8",
);

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    create role anon; create role authenticated;
    create schema auth;
    create function auth.uid() returns uuid language sql stable as
      $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    create type public.app_role as enum ('admin', 'employee', 'client');
    create type public.team_category as enum ('avatars', 'editors', 'smm');
    create type public.engagement_type as enum ('contractor', 'employee');
    create table auth.users (id uuid primary key default gen_random_uuid(), email text unique);
    create table public.profiles (id uuid primary key, role public.app_role not null);
    create table public.team_members (
      id uuid primary key default gen_random_uuid(),
      user_id uuid unique, category public.team_category not null,
      name text not null, initials text not null,
      engagement public.engagement_type not null default 'contractor'
    );
    insert into public.profiles values ('${ADMIN}', 'admin'), ('${EMPLOYEE}', 'employee');
    create function public.is_admin() returns boolean language sql stable
      security definer set search_path = '' as $$
      select coalesce((select role = 'admin' from public.profiles where id = auth.uid()), false)
      $$;
    create function public.create_console_user(
      p_email text, p_password text, p_role public.app_role,
      p_name text, p_category public.team_category default null
    ) returns uuid language plpgsql security definer set search_path = '' as $$
    declare v_id uuid;
    begin
      insert into auth.users(email) values (p_email) returning id into v_id;
      return v_id;
    end; $$;
    grant usage on schema public, auth to authenticated;
    grant usage on type public.app_role, public.team_category,
      public.engagement_type to authenticated;
    grant execute on function auth.uid(), public.is_admin() to authenticated;
  `);
  await db.exec(await migration("20260904074557_13_admin_form_rpcs.sql"));
  const oldResult = await asUser<{ admin_create_team_member: string }>(ADMIN,
    `select public.admin_create_team_member(
      'Old login','OL','smm'::public.team_category,
      'contractor'::public.engagement_type,'old@example.com','abc')`);
  expect(oldResult).toHaveLength(1);
  expect((await db.query("select id from auth.users")).rows).toHaveLength(1);
  await db.exec(await migration("20261101030000_283_retire_browser_password_creation.sql"));
}, 60_000);

afterAll(async () => { await db?.close(); });

describe("legacy browser password creation is closed by migration 283", () => {
  it("rejects both credential arguments and never provisions another Auth user", async () => {
    const call = `select public.admin_create_team_member(
      'New login','NL','smm'::public.team_category,
      'contractor'::public.engagement_type,$1,$2)`;
    await expect(asUser(ADMIN, call, ["new@example.com", "long-password"]))
      .rejects.toThrow(/approved invitation/i);
    await expect(asUser(ADMIN, call, [null, "password-only"]))
      .rejects.toThrow(/approved invitation/i);
    await expect(asUser(ADMIN, call, ["", null]))
      .rejects.toThrow(/approved invitation/i);
    expect((await db.query("select id from auth.users")).rows).toHaveLength(1);
    expect((await db.query("select id from public.team_members")).rows).toHaveLength(1);
  });

  it("preserves roster-only creation for an admin without assigning a login", async () => {
    const result = await asUser<{ admin_create_team_member: string }>(ADMIN,
      `select public.admin_create_team_member(
        'No login','NL','editors'::public.team_category,
        'contractor'::public.engagement_type)`);
    expect(result).toHaveLength(1);
    const member = (await db.query<{ user_id: string | null }>(
      "select user_id from public.team_members where id = $1",
      [result[0]!.admin_create_team_member],
    )).rows[0]!;
    expect(member.user_id).toBeNull();
    expect((await db.query("select id from auth.users")).rows).toHaveLength(1);
  });

  it("denies a non-admin even for roster-only creation", async () => {
    await expect(asUser(EMPLOYEE,
      `select public.admin_create_team_member(
        'Unauthorized','UN','smm'::public.team_category,
        'contractor'::public.engagement_type)`))
      .rejects.toThrow(/Admins only/i);
  });
});
