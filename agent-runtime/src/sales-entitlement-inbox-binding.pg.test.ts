import { PGlite } from "@electric-sql/pglite";
import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const ADMIN = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const EMPLOYEE = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const SECOND_EMPLOYEE = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const LEGACY_EMPLOYEE = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const CLIENT = "11111111-1111-4111-8111-111111111111";
const MEMBER = "22222222-2222-4222-8222-222222222222";
const SECOND_MEMBER = "33333333-3333-4333-8333-333333333333";
const LEGACY_MEMBER = "44444444-4444-4444-8444-444444444444";

let db: PGlite;
let legacyRequest: string;

async function asRole<T extends Record<string, unknown>>(
  role: "authenticated" | "service_role", id: string | null, aal: "aal1" | "aal2",
  sql: string, params: unknown[] = [],
): Promise<T[]> {
  await db.query("select set_config('request.jwt.claim.role',$1,false)", [role]);
  await db.query("select set_config('request.jwt.claim.sub',$1,false)", [id ?? ""]);
  await db.query("select set_config('request.jwt.claims',$1,false)", [JSON.stringify({ aal })]);
  await db.exec(`set role ${role}`);
  try {
    return (await db.query<T>(sql, params)).rows;
  } finally {
    await db.exec("reset role");
    await db.exec("select set_config('request.jwt.claim.role','',false); select set_config('request.jwt.claim.sub','',false); select set_config('request.jwt.claims','',false)");
  }
}

async function request(member: string, action: "grant" | "revoke") {
  return (await asRole<{ id: string }>("authenticated", ADMIN, "aal2",
    "select public.request_client_sales_entitlement($1,$2,$3) as id",
    [CLIENT, member, action],
  ))[0]!.id;
}

async function scopeHash(id: string) {
  return (await db.query<{ scope_hash: string }>(
    "select scope_hash from public.client_sales_entitlement_requests where id=$1", [id],
  )).rows[0]!.scope_hash;
}

async function inboxState(id: string) {
  return (await asRole<{ status: string; source_state: string }>(
    "authenticated", ADMIN, "aal2",
    "select status,source_state from public.approval_inbox_v6 where source_kind='client_sales_entitlement' and source_id=$1",
    [id],
  ))[0]!;
}

async function decide(id: string, hash: string, approved: boolean, note: string) {
  await asRole("authenticated", ADMIN, "aal2",
    "select public.decide_client_sales_entitlement($1,$2,$3,$4)",
    [id, hash, approved, note]);
}

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    create role anon;
    create role authenticated;
    create role service_role bypassrls;
    create schema auth;
    create function auth.uid() returns uuid language sql stable as
      $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
    create function auth.role() returns text language sql stable as
      $$ select nullif(current_setting('request.jwt.claim.role',true),'') $$;
    create function auth.jwt() returns jsonb language sql stable as
      $$ select coalesce(nullif(current_setting('request.jwt.claims',true),'')::jsonb,'{}'::jsonb) $$;
    create table public.clients (id uuid primary key, name text not null);
    create table public.profiles (id uuid primary key, role text not null);
    create table public.team_members (
      id uuid primary key, user_id uuid references public.profiles(id),
      active boolean not null, name text not null
    );
    insert into public.clients values ('${CLIENT}','Service Client');
    insert into public.profiles values
      ('${ADMIN}','admin'),('${EMPLOYEE}','employee'),
      ('${SECOND_EMPLOYEE}','employee'),('${LEGACY_EMPLOYEE}','employee');
    insert into public.team_members values
      ('${MEMBER}','${EMPLOYEE}',true,'Sales Owner'),
      ('${SECOND_MEMBER}','${SECOND_EMPLOYEE}',true,'Other Owner'),
      ('${LEGACY_MEMBER}','${LEGACY_EMPLOYEE}',true,'Legacy Owner');
    create function public.current_role_of() returns text language sql stable
      security definer set search_path=public as $$
        select role from public.profiles where id=auth.uid()
      $$;
    create function public.is_admin() returns boolean language sql stable
      security definer set search_path=public as $$
        select coalesce(public.current_role_of()='admin',false)
      $$;
    create function public.can_access_client(target uuid) returns boolean language sql stable
      security definer set search_path=public as $$ select public.is_admin() $$;
    create function public.active_video_approval_manager(target uuid)
      returns uuid language sql stable as $$ select null::uuid $$;
    create function public.lock_down_definer_functions()
      returns integer language sql as $$ select 0 $$;
    grant usage on schema public,auth to authenticated,service_role;
    grant execute on function auth.uid(),auth.role(),auth.jwt(),
      public.current_role_of(),public.is_admin(),public.can_access_client(uuid)
      to authenticated,service_role;
  `);
  const salesMigration = await readFile(new URL(
    "../../supabase/migrations/20261029180000_267_sales_entitlement_boundary.sql",
    import.meta.url,
  ), "utf8");
  const salesPrefix = salesMigration.split("-- Callers cannot activate a grant")[0];
  if (!salesPrefix?.includes("decide_client_sales_entitlement")) {
    throw new Error("Could not isolate the real migration-267 sales decision contract.");
  }
  await db.exec(salesPrefix);
  await db.exec("grant insert on public.client_sales_entitlement_requests to service_role");
  legacyRequest = await request(LEGACY_MEMBER, "grant");

  for (const migration of [
    "20261030110000_273_canonical_approval_ledger.sql",
    "20261030130000_275_sales_entitlement_inbox_binding.sql",
    "20261030160000_279_approval_class_coverage.sql",
  ]) {
    await db.exec(await readFile(new URL(`../../supabase/migrations/${migration}`, import.meta.url), "utf8"));
  }
}, 60_000);

afterAll(async () => { await db?.close(); });

describe("B005 sales entitlement exact Inbox binding migration 275", () => {
  it("backfills a pending source request with frozen person/client names and no fabricated decision", async () => {
    const rows = await asRole<{
      id: string; preview_blocker: string | null; preview: Record<string, unknown>;
      status: string;
    }>("authenticated", ADMIN, "aal2", `select id,preview_blocker,preview,status from public.approval_inbox_v6
       where source_kind='client_sales_entitlement' and source_id=$1`,
    [legacyRequest]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ preview_blocker: null, status: "pending" });
    expect(rows[0]!.preview).toMatchObject({
      client_name: "Service Client", member_name: "Legacy Owner",
      bound_user_id: LEGACY_EMPLOYEE, action: "grant",
    });
    expect((await asRole<{ requested_by: string; requester_kind: string }>(
      "authenticated", ADMIN, "aal2",
      "select requested_by,requester_kind from public.approval_inbox_v6 where id=$1",
      [rows[0]!.id],
    ))[0]).toEqual({ requested_by: ADMIN, requester_kind: "human" });
    expect((await db.query("select * from public.approval_decision_events_v6 where request_id=$1",
      [rows[0]!.id])).rows).toHaveLength(0);
    await expect(db.query(
      "update public.client_sales_entitlement_requests set member_id=$1 where id=$2",
      [MEMBER, legacyRequest],
    )).rejects.toThrow(/immutable/i);
  });

  it("binds only the exact AAL2 event and denies random or other-scope IDs", async () => {
    const id = await request(MEMBER, "grant");
    const hash = await scopeHash(id);
    expect((await db.query<{ inbox_enforced: boolean }>(
      "select inbox_enforced from public.client_sales_entitlement_controls",
    )).rows[0]!.inbox_enforced).toBe(false);
    await expect(asRole("authenticated", ADMIN, "aal1",
      "select public.decide_client_sales_entitlement($1,$2,true,'Low assurance')",
      [id, hash],
    )).rejects.toThrow(/aal2/i);
    await decide(id, hash, true, "Reviewed exact member and client");
    const grant = (await db.query<{
      inbox_decision_id: string; grant_request_id: string; approved_scope_hash: string;
    }>("select inbox_decision_id,grant_request_id,approved_scope_hash from public.client_sales_entitlements where member_id=$1",
    [MEMBER])).rows[0]!;
    expect(grant).toMatchObject({ grant_request_id: id, approved_scope_hash: hash });
    expect(grant.inbox_decision_id).toBeTruthy();
    const event = (await db.query<{
      actor_id: string; actor_aal: string; source_decision_ref: string;
    }>("select actor_id,actor_aal,source_decision_ref from public.approval_decision_events_v6 where id=$1",
    [grant.inbox_decision_id])).rows[0]!;
    expect(event).toEqual({
      actor_id: ADMIN, actor_aal: "aal2",
      source_decision_ref: `client_sales_entitlement_requests:${id}`,
    });
    expect((await db.query<{ allowed: boolean }>(
      "select public.is_eligible_lead_owner($1,$2) as allowed", [MEMBER, CLIENT],
    )).rows[0]!.allowed).toBe(false);
    await expect(db.query(
      "update public.client_sales_entitlements set inbox_decision_id=gen_random_uuid() where member_id=$1",
      [MEMBER],
    )).rejects.toThrow(/foreign key|does not match/i);

    const otherId = await request(SECOND_MEMBER, "grant");
    await decide(otherId, await scopeHash(otherId), true, "Reviewed other member");
    const otherDecision = (await db.query<{ inbox_decision_id: string }>(
      "select inbox_decision_id from public.client_sales_entitlements where member_id=$1",
      [SECOND_MEMBER],
    )).rows[0]!.inbox_decision_id;
    await expect(db.query(
      "update public.client_sales_entitlements set inbox_decision_id=$1 where member_id=$2",
      [otherDecision, MEMBER],
    )).rejects.toThrow(/does not match/i);
    expect((await db.query<{ inbox_decision_id: string }>(
      "select inbox_decision_id from public.client_sales_entitlements where member_id=$1",
      [MEMBER],
    )).rows[0]!.inbox_decision_id).toBe(grant.inbox_decision_id);

    // Disposable fixture only: prove the boundary if an operator eventually
    // activates it. The migration itself never flips this production switch.
    await db.query("update public.client_sales_entitlement_controls set inbox_enforced=true");
    expect((await db.query<{ allowed: boolean }>(
      "select public.is_eligible_lead_owner($1,$2) as allowed", [MEMBER, CLIENT],
    )).rows[0]!.allowed).toBe(true);

    const revokeId = await request(MEMBER, "revoke");
    await decide(revokeId, await scopeHash(revokeId), true, "Revoke this client's sales seat");
    expect((await db.query<{ allowed: boolean }>(
      "select public.is_eligible_lead_owner($1,$2) as allowed", [MEMBER, CLIENT],
    )).rows[0]!.allowed).toBe(false);
    expect((await db.query<{ decision: string }>(`select d.decision from public.approval_decision_events_v6 d
      join public.approval_requests_v6 r on r.id=d.request_id
      where r.source_id=$1`, [revokeId])).rows[0]!.decision).toBe("approved");
  });

  it("holds a pending grant after retirement or account relinking, and a revoke after grant loss", async () => {
    expect(await inboxState(legacyRequest)).toMatchObject({
      status: "pending", source_state: "pending",
    });
    await db.query("update public.team_members set active=false where id=$1", [LEGACY_MEMBER]);
    expect(await inboxState(legacyRequest)).toMatchObject({
      status: "source_held", source_state: "source_held",
    });
    await expect(decide(legacyRequest, await scopeHash(legacyRequest), true,
      "Stale retired member")).rejects.toThrow(/identity changed/i);
    await db.query("update public.team_members set active=true,user_id=$2 where id=$1",
      [LEGACY_MEMBER, SECOND_EMPLOYEE]);
    expect(await inboxState(legacyRequest)).toMatchObject({
      status: "source_held", source_state: "source_held",
    });
    await expect(decide(legacyRequest, await scopeHash(legacyRequest), true,
      "Stale relinked member")).rejects.toThrow(/identity changed/i);
    await db.query("update public.team_members set user_id=$2 where id=$1",
      [LEGACY_MEMBER, LEGACY_EMPLOYEE]);
    expect((await inboxState(legacyRequest)).status).toBe("pending");

    const revokeId = await request(SECOND_MEMBER, "revoke");
    expect((await inboxState(revokeId)).status).toBe("pending");
    await db.query(`update public.client_sales_entitlements
      set revoked_at=now(),revoked_by=$3,revoke_request_id=$4
      where client_id=$1 and member_id=$2`,
      [CLIENT, SECOND_MEMBER, ADMIN, revokeId]);
    expect(await inboxState(revokeId)).toMatchObject({
      status: "source_held", source_state: "source_held",
    });
    await expect(decide(revokeId, await scopeHash(revokeId), true,
      "Stale revoked grant")).rejects.toThrow(/sales grant changed/i);
  });

  it("denies a privileged source-approved entitlement request inserted without Inbox review", async () => {
    const hash = (await db.query<{ hash: string }>(
      "select public.sales_entitlement_scope_hash($1,$2,$3,'grant') as hash",
      [CLIENT, MEMBER, EMPLOYEE],
    )).rows[0]!.hash;
    await expect(asRole("service_role", ADMIN, "aal2", `insert into public.client_sales_entitlement_requests
      (client_id,member_id,bound_user_id,action,scope_hash,status,requested_by,decided_by,decided_at)
      values ($1,$2,$3,'grant',$5,'approved',$4,$4,now())`,
    [CLIENT, MEMBER, EMPLOYEE, ADMIN, hash])).rejects.toThrow(/start pending/i);
  });
});
