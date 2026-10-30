import { PGlite } from "@electric-sql/pglite";
import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const ADMIN = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OTHER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const CLIENT = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const SENDER = "auth@attractacq.com";
const ORIGIN = "https://console.attractacq.com";
const PROJECT_ORIGIN = "https://project.supabase.co";
const TEMPLATE_SUBJECT = "Your AA Console invitation";
const TEMPLATE_BODY = "Accept your invitation using the secure link.";
let db: PGlite;
let seq = 0;
let verificationId: string;

const migration = (file: string) => readFile(new URL(
  `../../../supabase/migrations/${file}`, import.meta.url), "utf8");

async function asRole<T extends Record<string, unknown>>(
  role: "authenticated" | "service_role" | "anon", id: string | null,
  aal: "aal1" | "aal2", sql: string, params: unknown[] = [],
): Promise<T[]> {
  await db.query("select set_config('request.jwt.claim.role',$1,false)", [role]);
  await db.query("select set_config('request.jwt.claim.sub',$1,false)", [id ?? ""]);
  await db.query("select set_config('request.jwt.claims',$1,false)", [JSON.stringify({ aal })]);
  await db.exec(`set role ${role}`);
  try { return (await db.query<T>(sql, params)).rows; }
  finally {
    await db.exec("reset role");
    await db.exec("select set_config('request.jwt.claim.role','',false); select set_config('request.jwt.claim.sub','',false); select set_config('request.jwt.claims','',false)");
  }
}

async function target(): Promise<{ member: string; email: string; key: string }> {
  const n = ++seq;
  const member = (await db.query<{ id: string }>(
    "insert into public.team_members(category,name,active) values ('editors','Editor ' || $1,true) returning id",
    [n],
  )).rows[0]!.id;
  const key = (await db.query<{ id: string }>("select gen_random_uuid() as id")).rows[0]!.id;
  return { member, email: `invite-${n}@example.com`, key };
}

async function request(t: { member: string; email: string; key: string }, actor = ADMIN) {
  const rows = await asRole<{ id: string }>("service_role", null, "aal1",
    `select public.request_console_invitation_v6($1,'employee',$2::uuid,null::uuid,
      $3,$4,$5,$6::uuid,$7::uuid,$8::uuid) as id`,
    [t.email,t.member,SENDER,ORIGIN,PROJECT_ORIGIN,verificationId,t.key,actor]);
  return rows[0]!.id;
}

async function facts(id: string) {
  const source = (await db.query<{ payload_hash: string; status: string; recipient_email: string }>(
    "select payload_hash,status,recipient_email from public.console_invitation_requests_v6 where id=$1", [id],
  )).rows[0]!;
  const card = (await db.query<{ id: string; preview: Record<string,unknown>; artifact_hash: string }>(
    "select id,preview,artifact_hash from public.approval_requests_v6 where source_kind='console_invitation' and source_id=$1", [id],
  )).rows[0]!;
  return { source, card };
}

async function decide(id: string, hash: string, approved = true, role: "authenticated" | "service_role" = "authenticated", aal: "aal1" | "aal2" = "aal2", actor = ADMIN) {
  return asRole(role, actor, aal,
    "select (public.decide_console_invitation_v6($1::uuid,$2,$2,$3,$4)).status as status",
    [id,hash,approved,approved ? null : "wrong recipient"]);
}

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    create role anon; create role authenticated; create role service_role bypassrls;
    create schema auth;
    create function auth.uid() returns uuid language sql stable as
      $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
    create function auth.role() returns text language sql stable as
      $$ select nullif(current_setting('request.jwt.claim.role',true),'') $$;
    create function auth.jwt() returns jsonb language sql stable as
      $$ select coalesce(nullif(current_setting('request.jwt.claims',true),'')::jsonb,'{}'::jsonb) $$;
    create type public.app_role as enum ('admin','employee','client');
    create type public.team_category as enum ('avatars','editors','smm');
    create table auth.users(id uuid primary key,email text unique,email_confirmed_at timestamptz);
    create table public.profiles(id uuid primary key references auth.users(id),
      role public.app_role not null,full_name text,email text,
      employee_category public.team_category);
    create table public.clients(id uuid primary key);
    create table public.client_users(client_id uuid references public.clients(id),
      user_id uuid references public.profiles(id), primary key(client_id,user_id));
    create table public.team_members(id uuid primary key default gen_random_uuid(),
      user_id uuid unique references public.profiles(id),category public.team_category not null,
      name text not null,active boolean not null default true);
    insert into auth.users(id,email,email_confirmed_at) values
      ('${ADMIN}','admin@example.com',now()),('${OTHER}','other@example.com',now());
    insert into public.profiles(id,role,email) values
      ('${ADMIN}','admin','admin@example.com'),('${OTHER}','employee','other@example.com');
    insert into public.clients(id) values ('${CLIENT}');
    create function public.current_role_of() returns text language sql stable
      security definer set search_path=public as $$
        select role::text from public.profiles where id=auth.uid()
      $$;
    create function public.is_admin() returns boolean language sql stable
      security definer set search_path=public as $$
        select coalesce(public.current_role_of()='admin',false)
      $$;
    create function public.active_video_approval_manager(uuid) returns uuid
      language sql stable security definer set search_path=public as $$ select null::uuid $$;
    create function public.lock_down_definer_functions() returns integer
      language sql as $$ select 0 $$;
    grant usage on schema public,auth to authenticated,service_role,anon;
    grant execute on function auth.uid(),auth.role(),auth.jwt(),
      public.current_role_of(),public.is_admin(),
      public.active_video_approval_manager(uuid)
      to authenticated,service_role;
  `);
  await db.exec(await migration("20261030110000_273_canonical_approval_ledger.sql"));
  await db.exec(await migration("20261030160000_279_approval_class_coverage.sql"));
  await db.exec(await migration("20261101031000_284_console_invitation_requests.sql"));
  await db.exec(await migration("20261101032000_285_console_invitation_decision_and_send.sql"));
  await db.exec(await migration("20261101033000_286_console_invitation_acceptance.sql"));
  verificationId = (await asRole<{ id: string }>("authenticated",ADMIN,"aal2",
    `select public.record_console_auth_sender_verification_v6(
      $1,$2,$3,$4,$5,$6,$7) as id`,
    [SENDER,PROJECT_ORIGIN,ORIGIN,TEMPLATE_SUBJECT,TEMPLATE_BODY,
      "initial-dashboard-readback", "b".repeat(64)]))[0]!.id;
}, 60_000);
afterAll(async () => { await db?.close(); });

describe("controlled Auth invitation migrations 284–286", () => {
  it("records class 34 as source verified but decision and executor blocked", async () => {
    const row = (await db.query<{ revision: number; source_state: string;
      decision_state: string; executor_state: string; overall_status: string }>(
      "select revision,source_state,decision_state,executor_state,overall_status from public.approval_class_coverage_v6 where class_id=34",
    )).rows[0]!;
    expect(row).toEqual({ revision: 2, source_state: "verified",
      decision_state: "blocked", executor_state: "blocked", overall_status: "blocked" });
  });

  it("requires AAL2 admin and retained read-back evidence for sender verification", async () => {
    const sql = `select public.record_console_auth_sender_verification_v6(
      $1,$2,$3,$4,$5,$6,$7)`;
    const args = [SENDER,PROJECT_ORIGIN,ORIGIN,TEMPLATE_SUBJECT,TEMPLATE_BODY,
      "retained-supabase-dashboard-readback-2026-10-30", "b".repeat(64)];
    await expect(asRole("authenticated",ADMIN,"aal1",sql,args))
      .rejects.toThrow(/admin with AAL2/i);
    const inserted = await asRole<{ record_console_auth_sender_verification_v6: string }>(
      "authenticated",ADMIN,"aal2",sql,args);
    const id = inserted[0]!.record_console_auth_sender_verification_v6;
    expect(id).toBeTruthy();
    await expect(db.query("update public.console_auth_sender_verifications_v6 set sender_email='x' where id=$1",[id]))
      .rejects.toThrow(/append-only/i);
  });
  it("freezes one recipient and rejects changed idempotency replays and direct writes", async () => {
    const t = await target();
    const id = await request(t);
    expect(await request(t)).toBe(id);
    const { source, card } = await facts(id);
    expect(card.preview.recipient_email).toBe(t.email);
    expect(card.preview.sender_account).toBe(SENDER);
    expect(card.artifact_hash).toBe(source.payload_hash);
    expect(card.preview.team_category).toBe("editors");
    expect(card.preview.redirect_url).toBe(`${ORIGIN}/invite/accept?request=${id}`);
    expect(card.preview.auth_project_origin).toBe(PROJECT_ORIGIN);
    expect(card.preview.sender_verification_id).toBe(verificationId);
    expect(card.preview.template_subject).toBe(TEMPLATE_SUBJECT);
    expect(card.preview.template_body).toBe(TEMPLATE_BODY);
    expect(card.preview.template_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect((await db.query<{ requested_by: string; requester_kind: string }>(
      "select requested_by,requester_kind from public.approval_requests_v6 where id=$1", [card.id],
    )).rows[0]).toEqual({ requested_by: ADMIN, requester_kind: "human" });
    await expect(request({ ...t, email: "changed@example.com" }))
      .rejects.toThrow(/idempotency key belongs/i);
    await expect(db.query("update public.console_invitation_requests_v6 set recipient_email='other@example.com' where id=$1", [id]))
      .rejects.toThrow(/immutable/i);
    await expect(asRole("authenticated", ADMIN, "aal2",
      "insert into public.console_invitation_requests_v6(id) values (gen_random_uuid())"))
      .rejects.toThrow(/permission denied/i);
    await expect(asRole("authenticated", ADMIN, "aal2",
      "select public.request_console_invitation_v6('x','employee',null,null,'x','x','x',gen_random_uuid(),gen_random_uuid(),$1::uuid)", [ADMIN]))
      .rejects.toThrow(/permission denied/i);
  });

  it("keeps employee and client invitation cards pending in their exact source scope", async () => {
    const employee = await request(await target());
    const employeeState = await asRole<{ client_id: string | null; status: string; source_state: string }>(
      "authenticated", ADMIN, "aal2",
      `select client_id,status,source_state from public.approval_inbox_v6
        where source_system='auth' and source_kind='console_invitation' and source_id=$1`,
      [employee]);
    expect(employeeState).toEqual([{ client_id: null, status: "pending", source_state: "pending" }]);

    const n = ++seq;
    const email = `client-invite-${n}@example.com`;
    const key = (await db.query<{ id: string }>("select gen_random_uuid() as id")).rows[0]!.id;
    const clientRequest = await asRole<{ id: string }>("service_role", null, "aal1",
      `select public.request_console_invitation_v6($1,'client',null::uuid,$2::uuid,
        $3,$4,$5,$6::uuid,$7::uuid,$8::uuid) as id`,
      [email,CLIENT,SENDER,ORIGIN,PROJECT_ORIGIN,verificationId,key,ADMIN]);
    const clientState = await asRole<{ client_id: string | null; status: string; source_state: string }>(
      "authenticated", ADMIN, "aal2",
      `select client_id,status,source_state from public.approval_inbox_v6
        where source_system='auth' and source_kind='console_invitation' and source_id=$1`,
      [clientRequest[0]!.id]);
    expect(clientState).toEqual([{ client_id: CLIENT, status: "pending", source_state: "pending" }]);
  });

  it("reserves each active roster member for only one recipient", async () => {
    const t = await target();
    await request(t);
    const otherKey = (await db.query<{ id: string }>(
      "select gen_random_uuid() as id")).rows[0]!.id;
    await expect(request({ ...t, email: `other-${seq}@example.com`, key: otherKey }))
      .rejects.toThrow(/unique constraint|duplicate key/i);
    const otherTarget = await target();
    await expect(request({ ...otherTarget, email: t.email }))
      .rejects.toThrow(/unique constraint|duplicate key/i);
  });

  it("refuses AAL1, service, non-admin and stale versions before the owning decision", async () => {
    const id = await request(await target());
    const { source } = await facts(id);
    await expect(decide(id,source.payload_hash,true,"authenticated","aal1"))
      .rejects.toThrow(/admin with AAL2/i);
    await expect(decide(id,source.payload_hash,true,"service_role","aal2"))
      .rejects.toThrow(/permission denied|admin with AAL2/i);
    await expect(decide(id,source.payload_hash,true,"authenticated","aal2",OTHER))
      .rejects.toThrow(/admin with AAL2/i);
    await expect(decide(id,"f".repeat(64)))
      .rejects.toThrow(/exact version changed/i);
    expect((await facts(id)).source.status).toBe("requested");
  });

  it("requires exact human approval and sends at most once", async () => {
    const t = await target(); const id = await request(t);
    const { source, card } = await facts(id);
    await expect(asRole("service_role",null,"aal1",
      "select public.claim_console_invitation_send_v6($1::uuid,$2::uuid,$3)",
      [id,ADMIN,source.payload_hash])).rejects.toThrow(/not approved/i);
    expect((await decide(id,source.payload_hash))[0]!.status).toBe("approved");
    const decision = (await db.query<{ decision: string }>(
      "select decision from public.approval_decision_events_v6 where request_id=$1",[card.id])).rows;
    expect(decision).toEqual([{ decision: "approved" }]);
    await asRole("service_role",null,"aal1",
      "select public.claim_console_invitation_send_v6($1::uuid,$2::uuid,$3)",
      [id,ADMIN,source.payload_hash]);
    await expect(asRole("service_role",null,"aal1",
      "select public.claim_console_invitation_send_v6($1::uuid,$2::uuid,$3)",
      [id,ADMIN,source.payload_hash])).rejects.toThrow(/not approved/i);
    expect((await db.query<{ count: number }>(
      "select count(*)::int as count from public.console_invitation_send_claims_v6 where request_id=$1",[id])).rows[0]!.count).toBe(1);
  });

  it("treats existing unverified Auth email as a conflict at request and send", async () => {
    const t = await target();
    await db.query("insert into auth.users(id,email) values (gen_random_uuid(),$1)",[t.email]);
    await expect(request(t)).rejects.toThrow(/already uses this email/i);
    const later = await target(); const id = await request(later);
    const { source } = await facts(id);
    await decide(id,source.payload_hash);
    await db.query("insert into auth.users(id,email) values (gen_random_uuid(),$1)",[later.email]);
    await expect(asRole("service_role",null,"aal1",
      "select public.claim_console_invitation_send_v6($1::uuid,$2::uuid,$3)",
      [id,ADMIN,source.payload_hash])).rejects.toThrow(/email now exists/i);
    const marked = await asRole<{ status: string }>("service_role",null,"aal1",
      "select (public.mark_console_invitation_conflict_v6($1::uuid,$2)).status as status",
      [id,source.payload_hash]);
    expect(marked[0]!.status).toBe("conflict");
  });

  it("blocks a changed or retired roster target", async () => {
    const t = await target(); const id = await request(t);
    const { source } = await facts(id);
    await db.query("update public.team_members set active=false where id=$1",[t.member]);
    await expect(decide(id,source.payload_hash)).rejects.toThrow(/Roster target changed/i);
    expect((await facts(id)).source.status).toBe("requested");
  });

  it("does not revive a prior request after retire and restore", async () => {
    const t = await target(); const id = await request(t);
    const { source } = await facts(id);
    await db.query("update public.team_members set active=false where id=$1", [t.member]);
    await db.query("update public.team_members set active=true where id=$1", [t.member]);
    expect((await db.query<{ invitation_generation_v6: number }>(
      "select invitation_generation_v6 from public.team_members where id=$1", [t.member],
    )).rows[0]!.invitation_generation_v6).toBe(2);
    await expect(decide(id,source.payload_hash)).rejects.toThrow(/Roster target changed/i);
    expect((await facts(id)).source.status).toBe("requested");
  });

  it("blocks acceptance of a sent link after retire and restore", async () => {
    const t = await target(); const id = await request(t);
    const { source } = await facts(id);
    await decide(id,source.payload_hash);
    await asRole("service_role",null,"aal1",
      "select public.claim_console_invitation_send_v6($1::uuid,$2::uuid,$3)",
      [id,ADMIN,source.payload_hash]);
    const invited = (await db.query<{ id: string }>(
      "insert into auth.users(id,email,email_confirmed_at) values (gen_random_uuid(),$1,now()) returning id",
      [t.email])).rows[0]!.id;
    await asRole("service_role",null,"aal1",
      "select public.finish_console_invitation_send_v6($1::uuid,'sent',$2::uuid,null)",
      [id,invited]);
    await db.query("update public.team_members set active=false where id=$1", [t.member]);
    await db.query("update public.team_members set active=true where id=$1", [t.member]);
    await expect(asRole("service_role",null,"aal1",
      "select public.accept_console_invitation_v6($1::uuid,$2::uuid,$3)",
      [id,invited,t.email])).rejects.toThrow(/Roster target changed/i);
    expect((await db.query("select id from public.profiles where id=$1", [invited])).rows).toHaveLength(0);
  });

  it("keeps an uncertain send reserved until AAL2 no-send evidence revokes it", async () => {
    const t = await target(); const id = await request(t);
    const { source, card } = await facts(id);
    await decide(id,source.payload_hash);
    await asRole("service_role",null,"aal1",
      "select public.claim_console_invitation_send_v6($1::uuid,$2::uuid,$3)",
      [id,ADMIN,source.payload_hash]);
    const sql = "select (public.resolve_console_invitation_uncertain_v6($1::uuid,$2,$3,$4,$5)).status as status";
    const args = [id,source.payload_hash,"provider-audit/no-send", "c".repeat(64), "Provider audit shows no send"];
    await expect(asRole("authenticated",ADMIN,"aal2",
      "select public.cancel_console_invitation_v6($1::uuid,'normal cancellation')", [id]))
      .rejects.toThrow(/cannot be cancelled/i);
    await expect(asRole("authenticated",ADMIN,"aal1",sql,args)).rejects.toThrow(/AAL2/i);
    await expect(asRole("authenticated",ADMIN,"aal2",sql,args)).rejects.toThrow(/Wait for the provider outcome/i);
    // Simulate a worker crash followed by elapsed time; the append-only claim
    // guard is temporarily bypassed by the test owner solely to age the row.
    await db.exec("alter table public.console_invitation_send_claims_v6 disable trigger guard_console_invitation_claim_v6");
    await db.query("update public.console_invitation_send_claims_v6 set claimed_at=now()-interval '16 minutes' where request_id=$1", [id]);
    await db.exec("alter table public.console_invitation_send_claims_v6 enable trigger guard_console_invitation_claim_v6");
    await db.query("insert into auth.users(id,email) values (gen_random_uuid(),$1)", [t.email]);
    await expect(asRole("authenticated",ADMIN,"aal2",sql,args)).rejects.toThrow(/Auth user exists/i);
    await db.query("delete from auth.users where email=$1", [t.email]);
    expect((await asRole<{ status: string }>("authenticated",ADMIN,"aal2",sql,args))[0]!.status)
      .toBe("cancelled");
    expect((await db.query<{ decision: string }>(
      "select decision from public.approval_decision_events_v6 where request_id=$1 order by decided_at", [card.id],
    )).rows.map((row) => row.decision)).toEqual(["approved","revoked"]);
    const replacement = await target();
    expect(await request({ ...replacement, member: t.member })).toBeTruthy();
  });

  it("binds only a confirmed invited Auth ID and makes acceptance idempotent", async () => {
    const t = await target(); const id = await request(t);
    const { source } = await facts(id);
    await decide(id,source.payload_hash);
    await asRole("service_role",null,"aal1",
      "select public.claim_console_invitation_send_v6($1::uuid,$2::uuid,$3)",
      [id,ADMIN,source.payload_hash]);
    const invited = (await db.query<{ id: string }>(
      "insert into auth.users(id,email) values (gen_random_uuid(),$1) returning id",[t.email])).rows[0]!.id;
    await asRole("service_role",null,"aal1",
      "select public.finish_console_invitation_send_v6($1::uuid,'sent',$2::uuid,null)",
      [id,invited]);
    await expect(asRole("service_role",null,"aal1",
      "select public.accept_console_invitation_v6($1::uuid,$2::uuid,$3)",
      [id,OTHER,t.email])).rejects.toThrow(/another user/i);
    await expect(asRole("service_role",null,"aal1",
      "select public.accept_console_invitation_v6($1::uuid,$2::uuid,$3)",
      [id,invited,t.email])).rejects.toThrow(/Confirmed Auth identity/i);
    await db.query("update auth.users set email_confirmed_at=now() where id=$1",[invited]);
    const accepted = await asRole<{ status: string }>("service_role",null,"aal1",
      "select (public.accept_console_invitation_v6($1::uuid,$2::uuid,$3)).status as status",
      [id,invited,t.email]);
    expect(accepted[0]!.status).toBe("accepted");
    expect(await asRole("service_role",null,"aal1",
      "select (public.accept_console_invitation_v6($1::uuid,$2::uuid,$3)).status as status",
      [id,invited,t.email])).toEqual(accepted);
    const profile = (await db.query<{ role: string; user_id: string }>(
      "select p.role::text,tm.user_id from public.profiles p join public.team_members tm on tm.user_id=p.id where p.id=$1",[invited])).rows[0]!;
    expect(profile).toEqual({ role: "employee", user_id: invited });
    expect(await request(t)).toBe(id);
  });

  it("blocks cancellation and expiry from granting an Auth link", async () => {
    const t = await target(); const id = await request(t);
    const { source } = await facts(id);
    await decide(id,source.payload_hash);
    await asRole("service_role",null,"aal1",
      "select public.claim_console_invitation_send_v6($1::uuid,$2::uuid,$3)",
      [id,ADMIN,source.payload_hash]);
    const invited = (await db.query<{ id: string }>(
      "insert into auth.users(id,email,email_confirmed_at) values (gen_random_uuid(),$1,now()) returning id",[t.email])).rows[0]!.id;
    await asRole("service_role",null,"aal1",
      "select public.finish_console_invitation_send_v6($1::uuid,'sent',$2::uuid,null)",
      [id,invited]);
    await asRole("authenticated",ADMIN,"aal2",
      "select public.cancel_console_invitation_v6($1::uuid,'No longer employed')",[id]);
    await expect(asRole("service_role",null,"aal1",
      "select public.accept_console_invitation_v6($1::uuid,$2::uuid,$3)",
      [id,invited,t.email])).rejects.toThrow(/expired, cancelled/i);
    expect((await db.query("select id from public.profiles where id=$1",[invited])).rows).toHaveLength(0);
    // The external Auth account/link remains. Cancellation only guarantees
    // no console privilege; provider cleanup is a separate controlled step.
    expect((await db.query("select id from auth.users where id=$1",[invited])).rows).toHaveLength(1);
  });
});
