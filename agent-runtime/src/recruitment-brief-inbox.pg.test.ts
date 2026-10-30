import { PGlite } from "@electric-sql/pglite";
import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const ADMIN = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SECOND_ADMIN = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const EMPLOYEE = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const PROFILELESS = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const PAYING = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
let db: PGlite;
let oldDraft: string;
let oldApproved: string;
let oldRejected: string;

const migration = async (file: string) => readFile(new URL(
  `../../supabase/migrations/${file}`, import.meta.url,
), "utf8");

async function asRole<T extends Record<string, unknown>>(
  role: "authenticated" | "service_role" | "anon", id: string | null,
  aal: "aal1" | "aal2", sql: string, params: unknown[] = [],
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

// The production browser cannot UPDATE this table. Exercise the trigger as a
// privileged SQL writer carrying a claimed identity, to prove that a bypass
// of the owning RPC still cannot create an unrecorded approval.
async function asPrivilegedWriter(
  role: "authenticated" | "service_role", id: string,
  aal: "aal1" | "aal2", sql: string, params: unknown[] = [],
) {
  await db.query("select set_config('request.jwt.claim.role',$1,false)", [role]);
  await db.query("select set_config('request.jwt.claim.sub',$1,false)", [id]);
  await db.query("select set_config('request.jwt.claims',$1,false)", [JSON.stringify({ aal })]);
  try {
    return await db.query(sql, params);
  } finally {
    await db.exec("select set_config('request.jwt.claim.role','',false); select set_config('request.jwt.claim.sub','',false); select set_config('request.jwt.claims','',false)");
  }
}

async function createDraft() {
  const rows = await asRole<{ id: string }>("authenticated", ADMIN, "aal1", `
    select public.create_recruitment_brief(
      'editor'::recruitment_role, 'Editor — Attract Acquisition',
      'Cut work that ships', 'Attract Acquisition is hiring an editor.',
      'Apply now', 'https://attractacq.com/careers/editor',
      'Documentary light', '£250/day', 'Make strong work'
    ) as id`);
  return rows[0]!.id;
}

async function requestFor(briefId: string) {
  return (await db.query<{
    id: string; source_version: string; artifact_hash: string;
    preview: Record<string, unknown>; owner_role: string; expires_at: string;
  }>(`select id,source_version,artifact_hash,preview,owner_role,expires_at
      from public.approval_requests_v6
     where source_kind='recruitment_brief' and source_id=$1
     order by requested_at desc,id desc limit 1`, [briefId])).rows[0]!;
}

type Card = Awaited<ReturnType<typeof requestFor>>;
async function approveCard(briefId: string, card: Card,
  role: "authenticated" | "service_role" = "authenticated",
  actor = ADMIN, aal: "aal1" | "aal2" = "aal2") {
  return asRole(role, actor, aal,
    "select public.approve_recruitment_brief_from_inbox_v6($1,$2,$3,$4)",
    [briefId, card.id, card.source_version, card.artifact_hash]);
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
      $$ select nullif(current_setting('request.jwt.claim.role', true), '') $$;
    create function auth.jwt() returns jsonb language sql stable as
      $$ select coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb,'{}'::jsonb) $$;
    grant usage on schema public, auth to authenticated, service_role, anon;
  `);
  for (const file of [
    "20260903104450_01_foundations_roles_clients.sql",
    "20260903104529_02_team_and_operations.sql",
    "20260903104615_03_agent_registry_and_job_queue.sql",
    "20260903104816_05_content_chain_proof_ideas_briefs_media.sql",
    "20260904083559_15_brief_refs_and_job_link.sql",
    "20260907170000_55_structured_briefs.sql",
  ]) await db.exec(await migration(file));
  await db.exec(`
    alter table agents add column if not exists scheduled_only boolean not null default false;
    alter table agent_jobs add column if not exists params jsonb not null default '{}'::jsonb;
  `);
  for (const file of [
    "20260905131703_39_brief_build_pipeline.sql",
    "20260905134322_41_creative_reference_image.sql",
    "20260905143029_42_creative_renders.sql",
    "20260905143101_43_render_rpcs.sql",
    "20260917000000_94_team_recruitment.sql",
  ]) await db.exec(await migration(file));
  await db.exec(`
    alter table client_briefs add column archived_at timestamptz;
    insert into auth.users (id,email) values
      ('${ADMIN}','alex@attractacq.com'),
      ('${SECOND_ADMIN}','chief@attractacq.com'),
      ('${EMPLOYEE}','editor@attractacq.com'),
      ('${PROFILELESS}','no-profile@attractacq.com');
    update profiles set role='admin' where id='${ADMIN}';
    update profiles set role='admin' where id='${SECOND_ADMIN}';
    update profiles set role='employee' where id='${EMPLOYEE}';
    delete from profiles where id='${PROFILELESS}';
    insert into clients (id,name,initials,is_internal)
      values ('${PAYING}','Harbour Dental','HD',false);
    create function public.active_video_approval_manager(uuid) returns uuid
      language sql stable as $$ select null::uuid $$;
    create function public.lock_down_definer_functions() returns integer
      language sql as $$ select 0 $$;
    grant execute on function auth.uid(),auth.role(),auth.jwt(),
      public.current_role_of(),public.is_admin(),
      public.active_video_approval_manager(uuid) to authenticated,service_role;
  `);
  oldDraft = await createDraft();
  oldApproved = await createDraft();
  oldRejected = await createDraft();
  await asRole("authenticated", ADMIN, "aal1",
    "select public.approve_recruitment_brief($1)", [oldApproved]);
  await db.query("update public.client_briefs set status='rejected' where id=$1", [oldRejected]);
  await db.exec(await migration("20261030110000_273_canonical_approval_ledger.sql"));
  await db.exec(await migration("20261030140000_276_recruitment_brief_inbox.sql"));
  await db.exec(await migration("20261030160000_279_approval_class_coverage.sql"));
  // The hosted Supabase project grants browser table privileges separately
  // from this disposable fixture; exercise the admin policy and new guard.
  await db.exec("grant select,insert on public.client_briefs to authenticated");
}, 90_000);

afterAll(async () => { await db?.close(); });

describe("recruitment brief Inbox adapter 276", () => {
  it("marks an edited or archived draft non-actionable in the live Inbox view", async () => {
    const id = await createDraft();
    const card = await requestFor(id);
    const state = async () => (await asRole<{ status: string; source_state: string }>(
      "authenticated", ADMIN, "aal2",
      "select status,source_state from public.approval_inbox_v6 where id=$1", [card.id],
    ))[0]!;
    expect(await state()).toMatchObject({ status: "pending", source_state: "pending" });
    await db.query("update public.client_briefs set hook='Edited hook' where id=$1", [id]);
    expect(await state()).toMatchObject({ status: "superseded", source_state: "superseded" });
    await db.query("update public.client_briefs set archived_at=now() where id=$1", [id]);
    expect(await state()).toMatchObject({ status: "cancelled", source_state: "cancelled" });
  });

  it("backfills only pending drafts and freezes the full brief content", async () => {
    const draft = await requestFor(oldDraft);
    expect(draft.owner_role).toBe("admin");
    expect(draft.source_version).toMatch(/^[0-9a-f]{64}:v1$/);
    expect(draft.artifact_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(draft.preview).toMatchObject({
      id: oldDraft, title: "Editor — Attract Acquisition",
      hook: "Cut work that ships", script: "Attract Acquisition is hiring an editor.",
      apply_url: "https://attractacq.com/careers/editor",
      compensation_text: "£250/day", recruitment_role: "editor",
    });
    expect(draft.expires_at).toBeTruthy();
    const approvedHistory = await db.query<{ n: number }>(
      "select count(*)::int as n from public.approval_requests_v6 where source_id=$1", [oldApproved]);
    expect(approvedHistory.rows[0]!.n).toBe(0);
  });

  it("registers new drafts and denies non-owner reads", async () => {
    const id = await createDraft();
    const card = await requestFor(id);
    expect((await db.query<{ requested_by: string; requester_kind: string }>(
      "select requested_by,requester_kind from public.approval_inbox_v6 where id=$1",
      [card.id],
    )).rows[0]).toEqual({ requested_by: ADMIN, requester_kind: "human" });
    const adminRows = await asRole<{ id: string }>("authenticated", ADMIN, "aal1",
      "select id from public.approval_inbox_v6 where id=$1", [card.id]);
    const employeeRows = await asRole<{ id: string }>("authenticated", EMPLOYEE, "aal2",
      "select id from public.approval_inbox_v6 where id=$1", [card.id]);
    expect(adminRows).toHaveLength(1);
    expect(employeeRows).toHaveLength(0);
  });

  it("requires provisioned AAL2 human admin and binds one decision to source approval", async () => {
    const id = await createDraft();
    const card = await requestFor(id);
    await expect(approveCard(id, card, "authenticated", ADMIN, "aal1")).rejects.toThrow(/AAL2/i);
    await expect(approveCard(id, card, "authenticated", EMPLOYEE)).rejects.toThrow(/admin/i);
    await expect(approveCard(id, card, "authenticated", PROFILELESS)).rejects.toThrow(/provisioned/i);
    await expect(approveCard(id, card, "service_role")).rejects.toThrow(/permission denied|provisioned/i);
    await expect(asRole("authenticated", ADMIN, "aal2",
      "select public.approve_recruitment_brief($1)", [id])).rejects.toThrow(/permission denied/i);
    await approveCard(id, card);
    const result = (await db.query<{
      status: string; decision: string; actor_id: string; actor_aal: string;
    }>(`select b.status::text as status,d.decision,d.actor_id,d.actor_aal
      from public.client_briefs b join public.approval_requests_v6 r
        on r.source_id=b.id::text
      join public.approval_decision_events_v6 d on d.request_id=r.id
      where b.id=$1`, [id])).rows[0]!;
    expect(result).toMatchObject({ status: "approved", decision: "approved",
      actor_id: ADMIN, actor_aal: "aal2" });
    expect((await requestFor(id)).id).toBe(card.id);
  });

  it("rejects stale changed words until an explicit new exact-version request", async () => {
    const id = await createDraft();
    const old = await requestFor(id);
    await db.query("update public.client_briefs set script='Changed primary text' where id=$1", [id]);
    await expect(approveCard(id, old)).rejects.toThrow(/stale|changed/i);
    const requested = await asRole<{ id: string }>("authenticated", SECOND_ADMIN, "aal1",
      "select public.request_recruitment_brief_approval_v6($1) as id", [id]);
    const fresh = await requestFor(id);
    expect(fresh.id).toBe(requested[0]!.id);
    expect(fresh.id).not.toBe(old.id);
    expect(fresh.preview.script).toBe("Changed primary text");
    const repeat = await asRole<{ id: string }>("authenticated", ADMIN, "aal1",
      "select public.request_recruitment_brief_approval_v6($1) as id", [id]);
    expect(repeat[0]!.id).toBe(fresh.id);
    // A second admin may have requested v2 while this reviewer still has v1
    // on screen. The v1 click must not silently approve the new card.
    await expect(approveCard(id, old)).rejects.toThrow(/stale|changed/i);
    await approveCard(id, fresh);
    expect((await db.query<{ n: number }>(
      "select count(*)::int as n from approval_private.recruitment_brief_decision_context_v6"
    )).rows[0]!.n).toBe(0);
  });

  it("rejects a different brief's card and hides the transition context from callers", async () => {
    const first = await createDraft();
    const second = await createDraft();
    const otherCard = await requestFor(second);
    await expect(approveCard(first, otherCard)).rejects.toThrow(/stale|incomplete/i);
    await expect(asRole("authenticated", ADMIN, "aal2",
      "select * from approval_private.recruitment_brief_decision_context_v6"))
      .rejects.toThrow(/permission denied/i);
    const firstCard = await requestFor(first);
    await approveCard(first, firstCard);
  });

  it("marks incomplete draft requests blocked instead of presenting them as approvable", async () => {
    const id = await createDraft();
    await db.query("update public.client_briefs set hook='' where id=$1", [id]);
    await asRole("authenticated", ADMIN, "aal1",
      "select public.request_recruitment_brief_approval_v6($1)", [id]);
    const rows = await db.query<{ preview_blocker: string }>(`
      select preview_blocker from public.approval_inbox_v6
       where source_kind='recruitment_brief' and source_id=$1
       order by requested_at desc,id desc limit 1`, [id]);
    expect(rows.rows[0]!.preview_blocker).toMatch(/Complete Meta-static/i);
    await expect(approveCard(id, await requestFor(id))).rejects.toThrow(/stale|incomplete/i);
  });

  it("cannot request or approve an archived draft, while approved production may archive", async () => {
    const id = await createDraft();
    const card = await requestFor(id);
    await db.query("update public.client_briefs set archived_at=now() where id=$1", [id]);
    await expect(approveCard(id, card)).rejects.toThrow(/active recruitment draft/i);
    await expect(asRole("authenticated", ADMIN, "aal1",
      "select public.request_recruitment_brief_approval_v6($1)", [id])).rejects.toThrow(/active draft/i);
    await expect(asPrivilegedWriter("authenticated", ADMIN, "aal2",
      "update public.client_briefs set status='approved' where id=$1", [id]))
      .rejects.toThrow(/archived/i);
    await db.query("update public.client_briefs set archived_at=null where id=$1", [id]);
    await approveCard(id, card);
    await db.query("update public.client_briefs set archived_at=now() where id=$1", [id]);
  });

  it("does not let direct status writes, mixed copy changes or draft builds bypass the gate", async () => {
    const id = await createDraft();
    await expect(asPrivilegedWriter("service_role", ADMIN, "aal2",
      "update public.client_briefs set status='approved' where id=$1", [id]))
      .rejects.toThrow(/selected exact-version/i);
    await expect(asPrivilegedWriter("authenticated", ADMIN, "aal1",
      "update public.client_briefs set status='approved' where id=$1", [id]))
      .rejects.toThrow(/selected exact-version/i);
    await expect(asPrivilegedWriter("authenticated", ADMIN, "aal2",
      "update public.client_briefs set status='approved' where id=$1", [id]))
      .rejects.toThrow(/selected exact-version/i);
    await expect(asPrivilegedWriter("authenticated", ADMIN, "aal2",
      "update public.client_briefs set script='Changed',status='approved' where id=$1", [id]))
      .rejects.toThrow(/immutable/i);
    await expect(asPrivilegedWriter("authenticated", ADMIN, "aal2",
      "update public.client_briefs set status='in_production' where id=$1", [id]))
      .rejects.toThrow(/advance only|before production/i);
    const status = (await db.query<{ status: string }>(
      "select status::text as status from public.client_briefs where id=$1", [id])).rows[0]!.status;
    expect(status).toBe("draft");
  });

  it("denies a direct admin AAL2 status transition even when a current card exists", async () => {
    const id = await createDraft();
    const card = await requestFor(id);
    await expect(asPrivilegedWriter("authenticated", ADMIN, "aal2",
      "update public.client_briefs set status='approved' where id=$1", [id]))
      .rejects.toThrow(/selected exact-version/i);
    const result = (await db.query<{ status: string; decisions: number }>(`
      select b.status::text as status,
        (select count(*)::int from public.approval_decision_events_v6 d where d.request_id=$2) as decisions
        from public.client_briefs b where b.id=$1`, [id, card.id])).rows[0];
    expect(result).toMatchObject({ status: "draft", decisions: 0 });
  });

  it("keeps approved content immutable while generation lifecycle fields may advance", async () => {
    const id = await createDraft();
    await approveCard(id, await requestFor(id));
    await expect(db.query("update public.client_briefs set apply_url='https://other.example' where id=$1", [id]))
      .rejects.toThrow(/immutable/i);
    await expect(db.query("update public.client_briefs set status='draft' where id=$1", [id]))
      .rejects.toThrow(/advance only|cannot return/i);
    await db.query("update public.client_briefs set status='in_production',production_method='ai' where id=$1", [id]);
    const status = (await db.query<{ status: string }>(
      "select status::text as status from public.client_briefs where id=$1", [id])).rows[0]!.status;
    expect(status).toBe("in_production");
  });

  it("denies an admin inserting an already-approved recruitment brief", async () => {
    const source = await createDraft();
    await expect(asRole("authenticated", ADMIN, "aal2", `
      insert into public.client_briefs
        (client_id,title,body,media_type,status,purpose,recruitment_role,
         apply_url,compensation_text,hook,premise,script,call_to_action,
         visual_direction,channel_intent)
      select client_id,title,body,media_type,'approved',purpose,recruitment_role,
         apply_url,compensation_text,hook,premise,script,call_to_action,
         visual_direction,channel_intent
        from public.client_briefs where id=$1`, [source]))
      .rejects.toThrow(/start as a draft/i);
  });

  it("keeps a historical rejected recruitment brief terminal under admin writes", async () => {
    await expect(asPrivilegedWriter("authenticated", ADMIN, "aal2",
      "update public.client_briefs set status='approved' where id=$1", [oldRejected]))
      .rejects.toThrow(/advance only/i);
    await expect(asPrivilegedWriter("authenticated", ADMIN, "aal2",
      "update public.client_briefs set status='in_production' where id=$1", [oldRejected]))
      .rejects.toThrow(/advance only/i);
    expect((await db.query<{ status: string }>(
      "select status::text as status from public.client_briefs where id=$1", [oldRejected],
    )).rows[0]!.status).toBe("rejected");
  });
});
