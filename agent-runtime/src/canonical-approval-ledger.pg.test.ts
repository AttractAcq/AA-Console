import { PGlite } from "@electric-sql/pglite";
import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

const ADMIN = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CLIENT_USER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const OTHER_USER = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const PROFILELESS = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const MANAGER = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const CLIENT = "11111111-1111-4111-8111-111111111111";
const OTHER_CLIENT = "22222222-2222-4222-8222-222222222222";
const HASH = "a".repeat(64);

let db: PGlite;
let sequence = 0;

function candidate(overrides: Record<string, unknown> = {}) {
  return {
    client_id: CLIENT,
    source_system: "console",
    source_kind: "campaign_action",
    source_id: `source-${++sequence}`,
    source_version: "v1",
    title: "Publish exact ad",
    artifact_hash: HASH,
    preview: { headline: "Exact words", body: "Exact body" },
    destination: "meta:act_123",
    account_ref: "act_123",
    budget: { daily_spend_limit: 50 },
    scope: { placement: "feed" },
    owner_role: "admin_or_active_client_manager",
    expires_at: "2030-01-01T00:00:00Z",
    preview_blocker: null,
    owning_path: `/clients/${CLIENT}/delivery/approval-inbox?tab=campaign-actions`,
    ...overrides,
  };
}

async function asRole<T extends Record<string, unknown>>(
  role: "authenticated" | "service_role" | "anon",
  id: string | null,
  aal: "aal1" | "aal2",
  sql: string,
  params: unknown[] = [],
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

async function register(payload: Record<string, unknown>) {
  const rows = (await db.query<{ id: string }>(
    "select public.register_approval_request_v6($1::jsonb) as id",
    [JSON.stringify(payload)],
  )).rows;
  return rows[0]!.id;
}

async function attach(id: string, payload: Record<string, unknown>, ref = "page-snapshot-1") {
  const rows = (await db.query<{ id: string }>(
    "select public.attach_approval_evidence_v6($1::uuid,'v1',$2,$3::jsonb) as id",
    [id, ref, JSON.stringify(payload)],
  )).rows;
  return rows[0]!.id;
}

async function view(id: string) {
  return (await db.query<{
    status: string; preview_blocker: string | null; artifact_hash: string | null;
    preview: Record<string, unknown> | null; destination: string | null;
  }>("select status,preview_blocker,artifact_hash,preview,destination from public.approval_inbox_v6 where id=$1", [id])).rows[0]!;
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
    create table public.clients (id uuid primary key);
    create table public.profiles (id uuid primary key, role text not null);
    create table public.client_users (client_id uuid not null, user_id uuid not null);
    insert into public.clients values ('${CLIENT}'),('${OTHER_CLIENT}');
    insert into public.profiles values ('${ADMIN}','admin'),('${CLIENT_USER}','client'),
      ('${OTHER_USER}','client'),('${MANAGER}','employee');
    insert into public.client_users values ('${CLIENT}','${CLIENT_USER}'),
      ('${CLIENT}','${MANAGER}'),('${OTHER_CLIENT}','${OTHER_USER}');
    create function public.current_role_of() returns text language sql stable
      security definer set search_path=public as $$
        select role from public.profiles where id=auth.uid()
      $$;
    create function public.is_admin() returns boolean language sql stable
      security definer set search_path=public as $$
        select coalesce(public.current_role_of()='admin',false)
      $$;
    create function public.can_access_client(target uuid) returns boolean language sql stable
      security definer set search_path=public as $$
        select public.is_admin() or exists(select 1 from public.client_users
          where client_id=target and user_id=auth.uid())
      $$;
    create function public.active_video_approval_manager(target uuid) returns uuid
      language sql stable security definer set search_path=public as $$
        select case when target='${CLIENT}'::uuid then '${MANAGER}'::uuid else null::uuid end
      $$;
    create function public.lock_down_definer_functions() returns integer language sql
      as $$ select 0 $$;
    grant usage on schema public,auth to authenticated,service_role,anon;
    grant execute on function auth.uid(),auth.role(),auth.jwt(),
      public.current_role_of(),public.is_admin(),public.can_access_client(uuid),
      public.active_video_approval_manager(uuid)
      to authenticated,service_role;
  `);
  const migration = await readFile(new URL(
    "../../supabase/migrations/20261030110000_273_canonical_approval_ledger.sql",
    import.meta.url,
  ), "utf8");
  await db.exec(migration);

  // A stand-in for a source-specific SECURITY DEFINER decision RPC. It has
  // no source authority check because the tests exercise only the ledger.
  await db.exec(`
    create function public.fixture_decide_approval(
      p_id uuid,p_decision text,p_hash text,p_ref text,p_reason text default null
    ) returns uuid language sql security definer set search_path=public as $$
      select public.record_approval_decision_v6(p_id,p_decision,p_hash,p_ref,p_reason)
    $$;
    grant execute on function public.fixture_decide_approval(uuid,text,text,text,text)
      to authenticated,service_role,anon;
  `);
}, 60_000);

beforeEach(async () => {
  sequence += 1;
});

afterAll(async () => { await db?.close(); });

describe("canonical approval ledger migration 273", () => {
  it("freezes a trusted source requester, including service origin without a JWT user", async () => {
    const human = candidate({ requested_by: ADMIN, requester_kind: "human" });
    const humanId = await register(human);
    const service = candidate({ requester_kind: "service", requester_ref: "campaign_action_approvals:action-1" });
    const serviceId = await register(service);
    const rows = (await db.query<{
      id: string; requested_by: string | null; requester_kind: string; requester_ref: string | null;
    }>("select id,requested_by,requester_kind,requester_ref from public.approval_inbox_v6 where id = any($1::uuid[])",
      [[humanId, serviceId]])).rows;
    expect(rows.find((row) => row.id === humanId)).toMatchObject({
      requested_by: ADMIN, requester_kind: "human", requester_ref: null,
    });
    expect(rows.find((row) => row.id === serviceId)).toMatchObject({
      requested_by: null, requester_kind: "service", requester_ref: "campaign_action_approvals:action-1",
    });
    await expect(register({ ...human, requested_by: OTHER_USER }))
      .rejects.toThrow(/different frozen evidence/i);
    await expect(register(candidate({ requester_kind: "human" })))
      .rejects.toThrow(/requester provenance/i);
    await expect(register(candidate({ requester_kind: "agent" })))
      .rejects.toThrow(/requester provenance/i);
    await expect(register(candidate({ requested_by: ADMIN, requester_kind: "service",
      requester_ref: "campaign_action_approvals:action-2" })))
      .rejects.toThrow(/requester provenance/i);
  });

  it("registers one immutable source version and rejects a changed idempotent replay", async () => {
    const payload = candidate();
    const first = await register(payload);
    expect(await register(payload)).toBe(first);
    await expect(register({ ...payload, destination: "meta:other" }))
      .rejects.toThrow(/different frozen evidence/i);
    expect((await view(first)).status).toBe("pending");
    await expect(db.query("update public.approval_requests_v6 set title='Changed' where id=$1", [first]))
      .rejects.toThrow(/append-only/i);
    await expect(db.query("delete from public.approval_requests_v6 where id=$1", [first]))
      .rejects.toThrow(/append-only/i);
  });

  it("keeps late page evidence append-only and blocks approval until it is attached", async () => {
    const id = await register(candidate({
      preview: null, preview_blocker: "Rendered page HTML has not arrived yet.",
    }));
    expect((await view(id)).preview_blocker).toMatch(/HTML has not arrived/);
    await expect(asRole("authenticated", ADMIN, "aal2",
      "select public.fixture_decide_approval($1,'approved',$2,'action-1')", [id, HASH],
    )).rejects.toThrow(/incomplete exact-version evidence/i);

    const evidence = {
      artifact_hash: HASH,
      preview: { rendered_html: "<html><body>Exact offer</body></html>" },
      destination: "meta:act_123", account_ref: "act_123",
      budget: { daily_spend_limit: 50 }, scope: { placement: "feed" },
    };
    const evidenceId = await attach(id, evidence);
    expect(await attach(id, evidence)).toBe(evidenceId);
    expect((await view(id)).preview_blocker).toBeNull();
    expect((await view(id)).preview).toEqual(evidence.preview);
    await expect(attach(id, { ...evidence, destination: "meta:other" }))
      .rejects.toThrow(/conflicts with the frozen approval request/i);

    const rows = await asRole<{ fixture_decide_approval: string }>("authenticated", ADMIN, "aal2",
      "select public.fixture_decide_approval($1,'approved',$2,'action-1')", [id, HASH]);
    expect(rows[0]!.fixture_decide_approval).toBeTruthy();
    expect((await view(id)).status).toBe("approved");
    expect(await asRole("authenticated", ADMIN, "aal2",
      "select public.fixture_decide_approval($1,'approved',$2,'action-1')", [id, HASH]))
      .toEqual(rows);
    await expect(attach(id, { ...evidence, preview: { rendered_html: "Changed" } }, "new-ref"))
      .rejects.toThrow(/conflicts with|already frozen|after a decision/i);
    await expect(db.query("update public.approval_request_evidence_v6 set evidence_ref='Changed' where request_id=$1", [id]))
      .rejects.toThrow(/append-only/i);
    await expect(db.query("delete from public.approval_decision_events_v6 where request_id=$1", [id]))
      .rejects.toThrow(/append-only/i);
  });

  it("denies direct browser/service writes and helper calls", async () => {
    const payload = candidate();
    const id = await register(payload);
    for (const role of ["authenticated", "service_role"] as const) {
      await expect(asRole(role, ADMIN, "aal2",
        "select public.register_approval_request_v6($1::jsonb)", [JSON.stringify(payload)],
      )).rejects.toThrow(/permission denied/i);
      await expect(asRole(role, ADMIN, "aal2",
        "insert into public.approval_requests_v6 (source_system,source_kind,source_id,source_version,title,payload_hash) values ('x','y','z','v1','x',$1)", [HASH],
      )).rejects.toThrow(/permission denied/i);
      await expect(asRole(role, ADMIN, "aal2",
        "select public.attach_approval_evidence_v6($1,'v1','direct','{}'::jsonb)", [id],
      )).rejects.toThrow(/permission denied/i);
      await expect(asRole(role, ADMIN, "aal2",
        "select public.record_approval_decision_v6($1,'approved',$2,'direct',null)", [id, HASH],
      )).rejects.toThrow(/permission denied/i);
    }
    await expect(asRole("anon", null, "aal2",
      "select * from public.approval_inbox_v6",
    )).rejects.toThrow(/permission denied/i);
  });

  it("requires a provisioned human AAL2 identity and exact hash, including on retries", async () => {
    const id = await register(candidate());
    for (const [role, user, aal] of [
      ["authenticated", ADMIN, "aal1"],
      ["service_role", ADMIN, "aal2"],
      ["authenticated", PROFILELESS, "aal2"],
    ] as const) {
      await expect(asRole(role, user, aal,
        "select public.fixture_decide_approval($1,'approved',$2,'source-1')", [id, HASH],
      )).rejects.toThrow(/provisioned human with AAL2/i);
    }
    await expect(asRole("authenticated", OTHER_USER, "aal2",
      "select public.fixture_decide_approval($1,'approved',$2,'source-1')", [id, HASH],
    )).rejects.toThrow(/not the decision owner for this client/i);
    await expect(asRole("authenticated", CLIENT_USER, "aal2",
      "select public.fixture_decide_approval($1,'approved',$2,'source-1')", [id, HASH],
    )).rejects.toThrow(/not the decision owner for this client/i);
    await expect(asRole("authenticated", ADMIN, "aal2",
      "select public.fixture_decide_approval($1,'approved',$2,'source-1')", [id, "b".repeat(64)],
    )).rejects.toThrow(/exact artifact hash changed/i);

    await asRole("authenticated", ADMIN, "aal2",
      "select public.fixture_decide_approval($1,'approved',$2,'source-1')", [id, HASH]);
    await expect(asRole("authenticated", ADMIN, "aal2",
      "select public.fixture_decide_approval($1,'rejected',$2,'source-2','No')", [id, HASH],
    )).rejects.toThrow(/already been decided/i);
    await expect(asRole("authenticated", ADMIN, "aal1",
      "select public.fixture_decide_approval($1,'approved',$2,'source-1')", [id, HASH],
    )).rejects.toThrow(/provisioned human with AAL2/i);
  });

  it("shows a manager only its own source and reserves agency-wide requests for admins", async () => {
    const own = await register(candidate());
    const other = await register(candidate({ client_id: OTHER_CLIENT }));
    const global = await register(candidate({ client_id: null, source_kind: "release" }));
    const allowed = await asRole<{ visible: boolean }>("authenticated", MANAGER, "aal2",
      "select public.can_review_approval_request_v6($1::uuid,'admin_or_active_client_manager') as visible", [CLIENT]);
    expect(allowed[0]!.visible).toBe(true);
    const direct = await asRole<{ id: string }>("authenticated", MANAGER, "aal2",
      "select id from public.approval_requests_v6");
    expect(direct.map((row) => row.id)).toContain(own);
    const rows = await asRole<{ id: string }>("authenticated", MANAGER, "aal2",
      "select id from public.approval_inbox_v6 order by id");
    expect(rows.map((row) => row.id)).toContain(own);
    expect(rows.map((row) => row.id)).not.toContain(other);
    expect(rows.map((row) => row.id)).not.toContain(global);
    const clientRows = await asRole<{ id: string }>("authenticated", CLIENT_USER, "aal2",
      "select id from public.approval_inbox_v6");
    expect(clientRows.map((row) => row.id)).not.toContain(own);
    const otherRows = await asRole<{ id: string }>("authenticated", OTHER_USER, "aal2",
      "select id from public.approval_inbox_v6");
    expect(otherRows.map((row) => row.id)).not.toContain(own);
    await asRole("authenticated", ADMIN, "aal2",
      "select public.fixture_decide_approval($1,'approved',$2,'own-1')", [own, HASH]);
    await asRole("authenticated", ADMIN, "aal2",
      "select public.fixture_decide_approval($1,'approved',$2,'other-1')", [other, HASH]);
    const managerHistory = await asRole<{ request_id: string }>("authenticated", MANAGER, "aal2",
      "select request_id from public.approval_decision_events_v6");
    expect(managerHistory.map((row) => row.request_id)).toContain(own);
    expect(managerHistory.map((row) => row.request_id)).not.toContain(other);
    const clientHistory = await asRole<{ request_id: string }>("authenticated", CLIENT_USER, "aal2",
      "select request_id from public.approval_decision_events_v6");
    expect(clientHistory).toEqual([]);
    await expect(asRole("authenticated", CLIENT_USER, "aal2",
      "select public.fixture_decide_approval($1,'approved',$2,'global-1')", [global, HASH],
    )).rejects.toThrow(/only an admin may decide agency-wide/i);
    await asRole("authenticated", ADMIN, "aal2",
      "select public.fixture_decide_approval($1,'approved',$2,'global-1')", [global, HASH]);
  });

  it("does not approve an expired or blocked request and records reasoned rejection/revocation", async () => {
    const expired = await register(candidate({ expires_at: "2020-01-01T00:00:00Z" }));
    expect((await view(expired)).status).toBe("expired");
    await expect(asRole("authenticated", ADMIN, "aal2",
      "select public.fixture_decide_approval($1,'approved',$2,'expired-1')", [expired, HASH],
    )).rejects.toThrow(/expired/i);
    await asRole("authenticated", ADMIN, "aal2",
      "select public.fixture_decide_approval($1,'rejected',$2,'expired-2','Expired without approval')", [expired, HASH]);
    expect((await view(expired)).status).toBe("rejected");
    const blocked = await register(candidate({ preview_blocker: "Rights missing" }));
    await expect(asRole("authenticated", ADMIN, "aal2",
      "select public.fixture_decide_approval($1,'approved',$2,'blocked-1')", [blocked, HASH],
    )).rejects.toThrow(/incomplete exact-version evidence/i);
    await expect(asRole("authenticated", ADMIN, "aal2",
      "select public.fixture_decide_approval($1,'rejected',$2,'blocked-2')", [blocked, HASH],
    )).rejects.toThrow(/reason are required/i);
    await asRole("authenticated", ADMIN, "aal2",
      "select public.fixture_decide_approval($1,'rejected',$2,'blocked-2','Rights missing')", [blocked, HASH]);
    expect((await view(blocked)).status).toBe("rejected");

    const active = await register(candidate());
    await asRole("authenticated", ADMIN, "aal2",
      "select public.fixture_decide_approval($1,'approved',$2,'active-1')", [active, HASH]);
    await asRole("authenticated", ADMIN, "aal2",
      "select public.fixture_decide_approval($1,'revoked',$2,'active-2','Withdrawn')", [active, HASH]);
    expect((await view(active)).status).toBe("revoked");
    const event = (await db.query<{ actor_id: string; actor_aal: string; reason: string }>(
      "select actor_id,actor_aal,reason from public.approval_decision_events_v6 where request_id=$1 and decision='revoked'",
      [active],
    )).rows[0]!;
    expect(event).toMatchObject({ actor_id: ADMIN, actor_aal: "aal2", reason: "Withdrawn" });
  });

  it("orders decisions by post-lock insertion even when transaction timestamps run backward", async () => {
    const id = await register(candidate());
    // A waiting transaction can start before the approval commits, then
    // acquire the request lock and insert a revocation afterward. PostgreSQL
    // now() retains that earlier transaction-start timestamp.
    await db.query(`insert into public.approval_decision_events_v6
      (request_id,decision,actor_id,actor_aal,artifact_hash,source_decision_ref,decided_at)
      values ($1,'approved',$2,'aal2',$3,'order-approval','2030-01-01T00:00:00Z')`,
    [id, ADMIN, HASH]);
    await db.query(`insert into public.approval_decision_events_v6
      (request_id,decision,actor_id,actor_aal,artifact_hash,source_decision_ref,reason,decided_at)
      values ($1,'revoked',$2,'aal2',$3,'order-revocation','Withdrawn','2029-01-01T00:00:00Z')`,
    [id, ADMIN, HASH]);
    const events = (await db.query<{ decision: string; event_order: number }>(
      "select decision,event_order from public.approval_decision_events_v6 where request_id=$1 order by event_order",
      [id],
    )).rows;
    expect(events.map((event) => event.decision)).toEqual(["approved", "revoked"]);
    expect(events[1]!.event_order).toBeGreaterThan(events[0]!.event_order);
    expect((await view(id)).status).toBe("revoked");
    await expect(asRole("authenticated", ADMIN, "aal2",
      "select public.fixture_decide_approval($1,'revoked',$2,'order-third','Again')", [id, HASH],
    )).rejects.toThrow(/only an approved request can be revoked/i);
  });
});
