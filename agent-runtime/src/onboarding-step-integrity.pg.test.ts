import { PGlite } from "@electric-sql/pglite";
import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

const ADMIN = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CLIENT_USER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const BOTH_CLIENTS = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const OTHER_PERSON = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const CLIENT = "11111111-1111-4111-8111-111111111111";
const OTHER_CLIENT = "22222222-2222-4222-8222-222222222222";
const FORM = "33333333-3333-4333-8333-333333333333";
const CALL = "44444444-4444-4444-8444-444444444444";

let db: PGlite;

async function asRole<T extends Record<string, unknown>>(
  role: "authenticated" | "service_role", id: string, sql: string,
  params: unknown[] = [],
): Promise<T[]> {
  await db.query("select set_config('request.jwt.claim.sub', $1, false)", [id]);
  await db.query("select set_config('request.jwt.claim.role', $1, false)", [role]);
  await db.exec(`set role ${role}`);
  try {
    return (await db.query<T>(sql, params)).rows;
  } finally {
    await db.exec("reset role");
    await db.exec("select set_config('request.jwt.claim.role', '', false); select set_config('request.jwt.claim.sub', '', false);");
  }
}

async function step(id = FORM) {
  return (await db.query<{
    id: string; client_id: string; step_key: string; title: string;
    status: string; completed_at: string | null; completed_by: string | null;
    display_order: number;
  }>("select * from public.client_onboarding_steps where id=$1", [id])).rows[0]!;
}

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    create role anon;
    create role authenticated;
    create role service_role bypassrls;
    create schema auth;
    create function auth.uid() returns uuid language sql stable as
      $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    create function auth.role() returns text language sql stable as
      $$ select nullif(current_setting('request.jwt.claim.role', true), '') $$;
    create type public.step_status as enum ('pending','in_progress','complete');
    create table public.clients (id uuid primary key);
    create table public.profiles (id uuid primary key, role text not null);
    create table public.client_users (client_id uuid not null, user_id uuid not null);
    insert into public.clients values ('${CLIENT}'),('${OTHER_CLIENT}');
    insert into public.profiles values
      ('${ADMIN}','admin'),('${CLIENT_USER}','client'),
      ('${BOTH_CLIENTS}','client'),('${OTHER_PERSON}','client');
    insert into public.client_users values
      ('${CLIENT}','${CLIENT_USER}'),
      ('${CLIENT}','${BOTH_CLIENTS}'),('${OTHER_CLIENT}','${BOTH_CLIENTS}');
    create function public.is_admin() returns boolean language sql stable
      security definer set search_path=public as $$
        select coalesce((select role='admin' from public.profiles where id=auth.uid()), false)
      $$;
    create function public.can_access_client(target uuid) returns boolean language sql stable
      security definer set search_path=public as $$
        select public.is_admin() or exists(select 1 from public.client_users
          where client_id=target and user_id=auth.uid())
      $$;
    create function public.lock_down_definer_functions() returns integer language sql
      as $$ select 0 $$;
    create table public.client_onboarding_steps (
      id uuid primary key default gen_random_uuid(),
      client_id uuid not null references public.clients(id) on delete cascade,
      step_key text not null, title text not null,
      status public.step_status not null default 'pending',
      completed_by uuid references public.profiles(id) on delete set null,
      completed_at timestamptz, display_order integer not null default 0,
      created_at timestamptz not null default now(), unique(client_id,step_key)
    );
    alter table public.client_onboarding_steps enable row level security;
    create policy cos_admin_all on public.client_onboarding_steps
      for all to authenticated using (public.is_admin()) with check (public.is_admin());
    create policy cos_scoped_read on public.client_onboarding_steps
      for select to authenticated using (public.can_access_client(client_id));
    create policy cos_client_update on public.client_onboarding_steps
      for update to authenticated
      using (exists(select 1 from public.client_users cu
        where cu.user_id=auth.uid() and cu.client_id=client_onboarding_steps.client_id))
      with check (true);
    grant usage on schema public,auth to authenticated,service_role;
    grant usage on type public.step_status to authenticated,service_role;
    grant select,update on public.client_onboarding_steps to authenticated;
    grant select,update on public.client_onboarding_steps to service_role;
    grant select on public.client_users,public.profiles to authenticated;
    grant execute on function auth.uid(),auth.role(),public.is_admin(),
      public.can_access_client(uuid) to authenticated,service_role;
    insert into public.client_onboarding_steps
      (id,client_id,step_key,title,display_order) values
      ('${FORM}','${CLIENT}','onboarding_form','Onboarding Form',1),
      ('${CALL}','${CLIENT}','onboarding_call','Onboarding Call',2);
  `);

  // The exact migration-07 policy is exploitable before 272. Restore its
  // fixture row after each proof so the post-migration tests start clean.
  await asRole("authenticated", BOTH_CLIENTS,
    "update public.client_onboarding_steps set client_id=$1 where id=$2",
    [OTHER_CLIENT, FORM]);
  expect((await step()).client_id).toBe(OTHER_CLIENT);
  await db.query("update public.client_onboarding_steps set client_id=$1 where id=$2", [CLIENT, FORM]);
  await asRole("authenticated", CLIENT_USER,
    "update public.client_onboarding_steps set title='Forged checklist',display_order=99 where id=$1",
    [FORM]);
  expect((await step()).title).toBe("Forged checklist");
  await db.query("update public.client_onboarding_steps set title='Onboarding Form',display_order=1 where id=$1", [FORM]);

  const migration = await readFile(new URL(
    "../../supabase/migrations/20261030100000_272_onboarding_step_integrity.sql",
    import.meta.url,
  ), "utf8");
  await db.exec(migration);
}, 60_000);

beforeEach(async () => {
  await db.exec(`
    update public.client_onboarding_steps set status='pending',
      completed_by=null, completed_at=null, title='Onboarding Form',display_order=1
      where id='${FORM}';
    update public.client_onboarding_steps set status='pending',
      completed_by=null, completed_at=null, title='Onboarding Call',display_order=2
      where id='${CALL}';
  `);
});

afterAll(async () => {
  await db?.close();
});

describe("client onboarding checklist integrity after migration 272", () => {
  it("rejects cross-client reparent, including a member of both clients", async () => {
    for (const user of [CLIENT_USER, BOTH_CLIENTS]) {
      await expect(asRole("authenticated", user,
        "update public.client_onboarding_steps set client_id=$1 where id=$2",
        [OTHER_CLIENT, FORM],
      )).rejects.toThrow(/onboarding step cannot change identity or client|row-level security/i);
    }
    expect((await step()).client_id).toBe(CLIENT);
  });

  it("keeps a client's only write to its own form status and stamps completion in the database", async () => {
    await asRole("authenticated", CLIENT_USER,
      "update public.client_onboarding_steps set status='complete',completed_at='1999-01-01' where id=$1",
      [FORM]);
    const completed = await step();
    expect(completed.status).toBe("complete");
    expect(completed.completed_by).toBe(CLIENT_USER);
    expect(new Date(completed.completed_at!).getUTCFullYear()).toBeGreaterThan(2020);
    await asRole("authenticated", CLIENT_USER,
      "update public.client_onboarding_steps set status='pending' where id=$1", [FORM]);
    expect(await step()).toMatchObject({ status: "pending", completed_at: null, completed_by: null });
  });

  it("denies status writes to a call step and a different client's form", async () => {
    await asRole("authenticated", CLIENT_USER,
      "update public.client_onboarding_steps set status='complete' where id=$1", [CALL]);
    await db.exec(`insert into public.client_onboarding_steps
      (client_id,step_key,title) values ('${OTHER_CLIENT}','onboarding_form','Other form')`);
    const result = await asRole("authenticated", CLIENT_USER,
      "update public.client_onboarding_steps set status='complete' where client_id=$1",
      [OTHER_CLIENT]);
    expect(result).toEqual([]);
    expect((await step(CALL)).status).toBe("pending");
  });

  it("denies protected identity, label, order, and forged completion fields", async () => {
    const changes = [
      "client_id='22222222-2222-4222-8222-222222222222'",
      "step_key='credentials_collected'", "title='Forged'", "display_order=7",
      "created_at='2000-01-01'", `completed_by='${OTHER_PERSON}'`,
      "completed_at='2000-01-01'",
    ];
    for (const change of changes) {
      await expect(asRole("authenticated", CLIENT_USER,
        `update public.client_onboarding_steps set ${change} where id='${FORM}'`,
      )).rejects.toThrow(/onboarding step cannot|only update|completion fields|row-level security/i);
    }
    expect(await step()).toMatchObject({ client_id: CLIENT, step_key: "onboarding_form",
      title: "Onboarding Form", display_order: 1, completed_by: null, completed_at: null });
  });

  it("preserves admin checklist maintenance and service status writes but never identity moves", async () => {
    await asRole("authenticated", ADMIN,
      "update public.client_onboarding_steps set title='Welcome',display_order=4,status='complete' where id=$1",
      [CALL]);
    expect(await step(CALL)).toMatchObject({ title: "Welcome", display_order: 4, status: "complete" });
    await asRole("service_role", OTHER_PERSON,
      "update public.client_onboarding_steps set status='in_progress' where id=$1", [CALL]);
    expect((await step(CALL)).status).toBe("in_progress");
    await expect(asRole("service_role", OTHER_PERSON,
      "update public.client_onboarding_steps set client_id=$1 where id=$2",
      [OTHER_CLIENT, CALL],
    )).rejects.toThrow(/onboarding step cannot change identity or client/i);
  });
});
