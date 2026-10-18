// Migration 127: a retired team member loses access.
//
// The console's retire button says "They will leave the active roster and lose
// team access." Before 127 that was only half true — active was set to false
// and every access path ignored it, so a retired member kept every client they
// had ever been assigned to. 127 added `tm.active` to all four functions.
//
// The last test here is the one that matters: it reverts can_access_client to
// its pre-127 shape and asserts the leak comes back. Without that, a green run
// proves only that the tests execute. See trap 13 in docs/gap-audit.md.

import { PGlite } from "@electric-sql/pglite";
import { readFile } from "node:fs/promises";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

const ADMIN = "11111111-1111-4111-8111-111111111111";
const EMPLOYEE = "22222222-2222-4222-8222-222222222222";
const CLIENT_A = "33333333-3333-4333-8333-333333333333";
const CLIENT_B = "44444444-4444-4444-8444-444444444444";

let db: PGlite;
let memberId: string;
/** can_access_client exactly as migration 02 left it — which is what production still runs. */
let preFixDefinition: string;

const migration = (file: string) =>
  readFile(new URL(`../../supabase/migrations/${file}`, import.meta.url), "utf8");

async function asEmployee() {
  await db.exec(`reset role;
    select set_config('request.jwt.claim.role','authenticated',false);
    select set_config('request.jwt.claim.sub','${EMPLOYEE}',false);`);
}

async function reaches(client: string): Promise<boolean> {
  const result = await db.query<{ ok: boolean }>("select can_access_client($1) as ok", [client]);
  return result.rows[0]!.ok;
}

async function accessibleCount(): Promise<number> {
  const result = await db.query("select * from accessible_client_ids()");
  return result.rows.length;
}

async function setActive(active: boolean) {
  await db.exec(`reset role; update team_members set active = ${active} where id = '${memberId}';`);
  await asEmployee();
}

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    create role anon; create role authenticated; create role service_role bypassrls;
    create schema auth;
    create table auth.users (id uuid primary key, email text, raw_user_meta_data jsonb default '{}');
    create function auth.uid() returns uuid language sql stable as
      $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    create function auth.role() returns text language sql stable as
      $$ select current_setting('request.jwt.claim.role', true) $$;
    grant usage on schema public, auth to authenticated, service_role, anon;
  `);
  for (const file of [
    "20260903104450_01_foundations_roles_clients.sql",
    "20260903104529_02_team_and_operations.sql",
  ]) await db.exec(await migration(file));

  await db.exec(`
    insert into auth.users (id) values ('${ADMIN}'),('${EMPLOYEE}');
    update profiles set role = 'admin' where id = '${ADMIN}';
    update profiles set role = 'employee' where id = '${EMPLOYEE}';
    insert into clients (id, name, initials) values
      ('${CLIENT_A}','Client A','A'), ('${CLIENT_B}','Client B','B');
  `);
  const member = await db.query<{ id: string }>(`
    insert into team_members (user_id, category, name, initials, engagement)
    values ('${EMPLOYEE}', 'editors', 'Editor 1', 'E1', 'contractor') returning id`);
  memberId = member.rows[0]!.id;

  // Captured before the fix rather than written out here, so the counter-test
  // below measures against whatever the migration chain actually produced.
  // Migration 09 only grants EXECUTE on this function; 02 is the last to define
  // it, and its body matches the one running in production today.
  const baseline = await db.query<{ def: string }>(
    `select pg_get_functiondef('public.can_access_client(uuid)'::regprocedure) as def`);
  preFixDefinition = baseline.rows[0]!.def;
  expect(preFixDefinition).not.toMatch(/tm\.active/);

  await db.exec(await migration("20260925110000_127_retired_team_access.sql"));
});

beforeEach(async () => {
  await db.exec(`reset role;
    delete from client_assignments; delete from job_assignments;
    update team_members set active = true where id = '${memberId}';`);
  await asEmployee();
});

describe("migration 127: retiring a team member", () => {
  it("takes away a client reached through a standing assignment", async () => {
    await db.exec(`reset role; insert into client_assignments (member_id, client_id)
      values ('${memberId}', '${CLIENT_A}');`);
    await asEmployee();

    expect(await reaches(CLIENT_A)).toBe(true);
    await setActive(false);
    expect(await reaches(CLIENT_A)).toBe(false);
  });

  it("takes away a client reached through a job assignment", async () => {
    await db.exec(`reset role; insert into job_assignments (member_id, client_id, title)
      values ('${memberId}', '${CLIENT_B}', 'A piece of work');`);
    await asEmployee();

    expect(await reaches(CLIENT_B)).toBe(true);
    await setActive(false);
    expect(await reaches(CLIENT_B)).toBe(false);
  });

  it("empties accessible_client_ids, by both routes at once", async () => {
    await db.exec(`reset role;
      insert into client_assignments (member_id, client_id) values ('${memberId}', '${CLIENT_A}');
      insert into job_assignments (member_id, client_id, title) values ('${memberId}', '${CLIENT_B}', 'Work');`);
    await asEmployee();

    expect(await accessibleCount()).toBe(2);
    await setActive(false);
    expect(await accessibleCount()).toBe(0);
  });

  it("makes the member stop recognising themselves", async () => {
    const active = await db.query<{ m: string | null; mine: boolean }>(
      "select current_member_id() as m, is_member($1) as mine", [memberId]);
    expect(active.rows[0]!.m).toBe(memberId);
    expect(active.rows[0]!.mine).toBe(true);

    await setActive(false);

    const retired = await db.query<{ m: string | null; mine: boolean }>(
      "select current_member_id() as m, is_member($1) as mine", [memberId]);
    expect(retired.rows[0]!.m).toBeNull();
    expect(retired.rows[0]!.mine).toBe(false);
  });

  it("leaves an ended assignment out whether or not the member is retired", async () => {
    await db.exec(`reset role; insert into client_assignments (member_id, client_id, ended_at)
      values ('${memberId}', '${CLIENT_A}', now());`);
    await asEmployee();

    expect(await reaches(CLIENT_A)).toBe(false);
  });

  it("leaks again on the pre-127 definition, which is what proves this suite bites", async () => {
    await db.exec(`reset role; insert into client_assignments (member_id, client_id)
      values ('${memberId}', '${CLIENT_A}');`);

    const fixed = await db.query<{ def: string }>(`
      select pg_get_functiondef('public.can_access_client(uuid)'::regprocedure) as def`);
    expect(fixed.rows[0]!.def).toMatch(/tm\.active/);

    await db.exec(preFixDefinition);

    await setActive(false);
    expect(await reaches(CLIENT_A)).toBe(true);

    await db.exec(`reset role; ${fixed.rows[0]!.def}`);
    await asEmployee();
    expect(await reaches(CLIENT_A)).toBe(false);
  });
});
