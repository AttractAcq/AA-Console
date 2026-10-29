import { PGlite } from "@electric-sql/pglite";
import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const ADMIN = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OTHER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const CLIENT = "11111111-1111-4111-8111-111111111111";
const CAMPAIGN = "22222222-2222-4222-8222-222222222222";
const MANIFEST = "33333333-3333-4333-8333-333333333333";
const LEGACY = "44444444-4444-4444-8444-444444444444";
const PAGE = "55555555-5555-4555-8555-555555555555";
const GOOGLE = "66666666-6666-4666-8666-666666666666";
const REJECT = "77777777-7777-4777-8777-777777777777";
const BAD_PAGE = "88888888-8888-4888-8888-888888888888";

let db: PGlite;

async function asRole<T extends Record<string, unknown>>(
  role: "authenticated" | "service_role", id: string, aal: "aal1" | "aal2",
  sql: string, params: unknown[] = [],
): Promise<T[]> {
  await db.query("select set_config('request.jwt.claim.role',$1,false)", [role]);
  await db.query("select set_config('request.jwt.claim.sub',$1,false)", [id]);
  await db.query("select set_config('request.jwt.claims',$1,false)", [JSON.stringify({ aal })]);
  await db.exec(`set role ${role}`);
  try {
    return (await db.query<T>(sql, params)).rows;
  } finally {
    await db.exec("reset role");
    await db.exec("select set_config('request.jwt.claim.role','',false); select set_config('request.jwt.claim.sub','',false); select set_config('request.jwt.claims','',false)");
  }
}

async function action(
  id: string, actionKey: string, hash: string, scope: Record<string, unknown>,
  destination = "meta:act_1",
) {
  await db.query(
    `insert into public.campaign_action_approvals
      (id,client_id,campaign_id,manifest_id,idempotency_key,action_key,
       destination,artifact_version_hash,scope,request_hash)
     values ($1,$2,$3,$4,$10,$5,$6,$7,$8::jsonb,$9)`,
    [id, CLIENT, CAMPAIGN, MANIFEST, actionKey, destination, hash,
      JSON.stringify(scope), id.replace(/-/g, "").slice(0, 32), id],
  );
}

async function inbox(id: string) {
  return (await db.query<{
    id: string; status: string; preview_blocker: string | null;
    preview: Record<string, unknown>; artifact_hash: string | null;
    owning_path: string | null;
  }>(`select id,status,preview_blocker,preview,artifact_hash,owning_path
       from public.approval_inbox_v6
      where source_system='aa_console' and source_kind='campaign_action'
        and source_id=$1`, [id])).rows[0]!;
}

async function sourceStatus(id: string) {
  return (await db.query<{ status: string }>(
    "select status from public.campaign_action_approvals where id=$1", [id],
  )).rows[0]!.status;
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
    insert into public.clients values ('${CLIENT}');
    insert into public.profiles values ('${ADMIN}','admin'),('${OTHER}','client');
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
        select public.is_admin() or auth.uid() = '${OTHER}'::uuid
      $$;
    create function public.active_video_approval_manager(target uuid)
      returns uuid language sql stable as $$ select null::uuid $$;
    create function public.lock_down_definer_functions() returns integer language sql
      as $$ select 0 $$;
    grant usage on schema public,auth to authenticated,service_role;
    grant execute on function auth.uid(),auth.role(),auth.jwt(),
      public.current_role_of(),public.is_admin(),public.can_access_client(uuid)
      to authenticated,service_role;
    create table public.campaign_action_approvals (
      id uuid primary key, client_id uuid not null, campaign_id uuid not null,
      manifest_id uuid not null, idempotency_key text not null,
      action_key text not null, destination text not null,
      artifact_version_hash text not null, scope jsonb not null,
      request_hash text not null, status text not null default 'pending',
      requested_at timestamptz not null default now(),
      decided_at timestamptz, decided_by uuid, rejection_reason text
    );
    create table public.campaign_page_approval_snapshots (
      approval_id uuid primary key references public.campaign_action_approvals(id),
      client_id uuid not null, page_id uuid not null, revision_id uuid not null,
      site_repository_id uuid not null, site_path text not null,
      rendered_html text not null, rendered_sha256 text not null
    );
    grant select,update on public.campaign_action_approvals to authenticated,service_role;
    grant insert on public.campaign_page_approval_snapshots to service_role;
    insert into public.campaign_action_approvals
      (id,client_id,campaign_id,manifest_id,idempotency_key,action_key,
       destination,artifact_version_hash,scope,request_hash)
    values ('${LEGACY}','${CLIENT}','${CAMPAIGN}','${MANIFEST}','legacy',
            'campaign_launch','meta:act_1',repeat('a',64),
            '{"manifest_id":"old"}'::jsonb,repeat('b',32));
  `);
  for (const migration of [
    "20261030110000_273_canonical_approval_ledger.sql",
    "20261030120000_274_campaign_action_inbox_bridge.sql",
  ]) {
    await db.exec(await readFile(new URL(`../../supabase/migrations/${migration}`, import.meta.url), "utf8"));
  }
}, 60_000);

afterAll(async () => { await db?.close(); });

describe("campaign action to canonical Inbox bridge migration 274", () => {
  it("backfills old pending rows visibly blocked, without inventing a human decision", async () => {
    const card = await inbox(LEGACY);
    expect(card.status).toBe("pending");
    expect(card.preview_blocker).toMatch(/exact reviewable action payload/i);
    expect((await db.query(
      "select * from public.approval_decision_events_v6 where request_id=$1", [card.id],
    )).rows).toHaveLength(0);
  });

  it("registers exact page HTML after the source request and rolls back invalid evidence", async () => {
    const html = "<html><body>Exact offer</body></html>";
    const hash = (await db.query<{ hash: string }>(
      "select encode(sha256(convert_to($1,'UTF8')),'hex') as hash", [html],
    )).rows[0]!.hash;
    await action(PAGE, "page_deploy", hash, {
      page_id: "99999999-9999-4999-8999-999999999999",
      revision_id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
      site_repository_id: "aaaaaaaa-bbbb-4ccc-8ddd-ffffffffffff",
      site_path: "offer/index.html", owner: "acq", repository: "site",
      rendered_sha256: hash,
    }, "https://example.com/offer/");
    expect((await inbox(PAGE)).preview_blocker).toBeTruthy();
    await db.query(`insert into public.campaign_page_approval_snapshots
      (approval_id,client_id,page_id,revision_id,site_repository_id,
       site_path,rendered_html,rendered_sha256)
      values ($1,$2,'99999999-9999-4999-8999-999999999999',
        'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
        'aaaaaaaa-bbbb-4ccc-8ddd-ffffffffffff',
        'offer/index.html',$3,$4)`, [PAGE, CLIENT, html, hash]);
    const card = await inbox(PAGE);
    expect(card.preview_blocker).toBeNull();
    expect(card.preview.rendered_html).toBe(html);
    expect(card.owning_path).toBe(`/clients/${CLIENT}/delivery/approval-inbox?tab=campaign-actions`);
    await expect(asRole("authenticated", ADMIN, "aal1",
      "update public.campaign_action_approvals set status='approved',decided_at=now(),decided_by=$1 where id=$2",
      [ADMIN, PAGE],
    )).rejects.toThrow(/AAL2/i);
    expect(await sourceStatus(PAGE)).toBe("pending");
    await asRole("authenticated", ADMIN, "aal2",
      "update public.campaign_action_approvals set status='approved',decided_at=now(),decided_by=$1 where id=$2",
      [ADMIN, PAGE]);
    expect((await inbox(PAGE)).status).toBe("approved");
    expect((await db.query<{ actor_aal: string }>(
      "select actor_aal from public.approval_decision_events_v6 where request_id=$1",
      [card.id],
    )).rows[0]?.actor_aal).toBe("aal2");

    await action(BAD_PAGE, "page_deploy", hash, { page_id: PAGE }, "https://example.com/bad/");
    await expect(db.query(`insert into public.campaign_page_approval_snapshots
      (approval_id,client_id,page_id,revision_id,site_repository_id,
       site_path,rendered_html,rendered_sha256)
      values ($1,$2,$3,$3,$3,'bad/index.html','changed',$4)`,
    [BAD_PAGE, CLIENT, PAGE, hash])).rejects.toThrow(/does not match/i);
    expect((await inbox(BAD_PAGE)).preview_blocker).toBeTruthy();
  });

  it("permits a verified Google spec, but blocks other generic action previews and service decisions", async () => {
    const spec = { google_ads_customer_id: "1234567890",
      headlines: ["An exact headline"], descriptions: ["An exact description"],
      final_url: "https://example.com" };
    const hash = (await db.query<{ hash: string }>(
      "select encode(sha256(convert_to($1::jsonb::text,'UTF8')),'hex') as hash",
      [JSON.stringify(spec)],
    )).rows[0]!.hash;
    await action(GOOGLE, "google_ad_build", hash, { approved_spec: spec },
      "google_ads:customers/1234567890");
    expect((await inbox(GOOGLE)).preview_blocker).toBeNull();
    await expect(asRole("service_role", ADMIN, "aal2",
      "update public.campaign_action_approvals set status='approved',decided_at=now(),decided_by=$1 where id=$2",
      [ADMIN, GOOGLE],
    )).rejects.toThrow(/provisioned human with AAL2/i);
    await expect(asRole("authenticated", OTHER, "aal2",
      "update public.campaign_action_approvals set status='approved',decided_at=now(),decided_by=$1 where id=$2",
      [OTHER, GOOGLE],
    )).rejects.toThrow(/assigned manager|decision owner|not permitted/i);
    expect(await sourceStatus(GOOGLE)).toBe("pending");
    await asRole("authenticated", ADMIN, "aal2",
      "update public.campaign_action_approvals set status='approved',decided_at=now(),decided_by=$1 where id=$2",
      [ADMIN, GOOGLE]);
    expect((await inbox(GOOGLE)).status).toBe("approved");

    await action(REJECT, "meta_ad_build", "c".repeat(64),
      { ad_account: "act_1", approved_creative: 1 });
    const blocked = await inbox(REJECT);
    expect(blocked.preview_blocker).toBeTruthy();
    await expect(asRole("authenticated", ADMIN, "aal2",
      "update public.campaign_action_approvals set status='approved',decided_at=now(),decided_by=$1 where id=$2",
      [ADMIN, REJECT],
    )).rejects.toThrow(/incomplete exact-version evidence/i);
    await asRole("authenticated", ADMIN, "aal2",
      "update public.campaign_action_approvals set status='rejected',rejection_reason='Missing creative bytes',decided_at=now(),decided_by=$1 where id=$2",
      [ADMIN, REJECT]);
    expect((await inbox(REJECT)).status).toBe("rejected");
  });
});
