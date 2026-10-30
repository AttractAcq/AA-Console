import { PGlite } from "@electric-sql/pglite";
import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const ADMIN = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const MANAGER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const OTHER = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const CLIENT = "11111111-1111-4111-8111-111111111111";
const LOCATION = "22222222-2222-4222-8222-222222222222";
const REVIEW = "33333333-3333-4333-8333-333333333333";
const LEGACY = "44444444-4444-4444-8444-444444444444";
const FRESH = "55555555-5555-4555-8555-555555555555";
const GONE = "66666666-6666-4666-8666-666666666666";

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

async function addReply(id: string, body: string) {
  await db.query(`insert into public.google_review_replies
      (id,client_id,review_id,body,body_hash)
      values ($1,$2,$3,$4,encode(sha256(convert_to($4,'UTF8')),'hex'))`,
  [id, CLIENT, REVIEW, body]);
}

async function cards(replyId: string) {
  return (await db.query<{
    id: string; source_version: string; status: string;
    artifact_hash: string; preview_blocker: string | null;
    preview: { reply_body: string; location_ref: string };
    destination: string; account_ref: string;
  }>(`select id,source_version,status,artifact_hash,preview_blocker,
            preview,destination,account_ref
       from public.approval_inbox_v6
      where source_kind='google_review_reply' and source_id=$1
      order by requested_at,id`, [replyId])).rows;
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
    insert into public.profiles values
      ('${ADMIN}','admin'),('${MANAGER}','employee'),('${OTHER}','client');
    create function public.current_role_of() returns text language sql stable
      security definer set search_path=public as $$
        select role from public.profiles where id=auth.uid()
      $$;
    create function public.is_admin() returns boolean language sql stable
      security definer set search_path=public as $$
        select coalesce(public.current_role_of()='admin',false)
      $$;
    create function public.active_video_approval_manager(target uuid) returns uuid
      language sql stable as $$ select case when target='${CLIENT}'::uuid
        then '${MANAGER}'::uuid else null::uuid end $$;
    create function public.can_access_client(target uuid) returns boolean
      language sql stable security definer set search_path=public as $$
        select public.is_admin() or auth.uid()='${MANAGER}'::uuid
      $$;
    create function public.lock_down_definer_functions() returns integer
      language sql as $$ select 0 $$;
    grant usage on schema public,auth to authenticated,service_role;
    grant execute on function auth.uid(),auth.role(),auth.jwt(),
      public.current_role_of(),public.is_admin(),public.can_access_client(uuid),
      public.active_video_approval_manager(uuid) to authenticated,service_role;
    create table public.client_google_locations (
      id uuid primary key, client_id uuid not null,
      location_ref text not null, title text not null
    );
    create table public.google_reviews (
      id uuid primary key, client_id uuid not null, location_id uuid not null,
      review_ref text not null, author_name text, star_rating integer,
      comment text, review_url text, gone_at timestamptz
    );
    create table public.google_review_replies (
      id uuid primary key, client_id uuid not null, review_id uuid not null,
      body text not null, body_hash text not null,
      status text not null default 'drafted', approved_by uuid,
      approved_at timestamptz, rejection_reason text,
      created_at timestamptz not null default now()
    );
    grant select,update on public.google_review_replies to service_role;
    insert into public.client_google_locations values
      ('${LOCATION}','${CLIENT}','accounts/123/locations/456','Main Street');
    insert into public.google_reviews values
      ('${REVIEW}','${CLIENT}','${LOCATION}','review-9','Jay',5,
       'Great service','https://g.co/review-9',null);
    insert into public.google_review_replies
      (id,client_id,review_id,body,body_hash)
      values ('${LEGACY}','${CLIENT}','${REVIEW}','Thank you, Jay',
        encode(sha256(convert_to('Thank you, Jay','UTF8')),'hex'));
  `);
  const ownerMigration = await readFile(new URL(
    "../../supabase/migrations/20261024140000_240_google_business_profile.sql",
    import.meta.url,
  ), "utf8");
  const ownerStart = ownerMigration.indexOf(
    "create function public.decide_google_review_reply_v6(",
  );
  const ownerEnd = ownerMigration.indexOf(
    "revoke all on function public.decide_google_review_reply_v6", ownerStart,
  );
  if (ownerStart < 0 || ownerEnd < 0) {
    throw new Error("Could not isolate the real Google reply decision function.");
  }
  await db.exec(ownerMigration.slice(ownerStart, ownerEnd));
  await db.exec(`
    revoke all on function public.decide_google_review_reply_v6(uuid,boolean,text)
      from public,anon;
    grant execute on function public.decide_google_review_reply_v6(uuid,boolean,text)
      to authenticated;
  `);
  for (const filename of [
    "20261030110000_273_canonical_approval_ledger.sql",
    "20261030150000_278_google_review_reply_inbox.sql",
  ]) {
    await db.exec(await readFile(new URL(`../../supabase/migrations/${filename}`, import.meta.url), "utf8"));
  }
}, 60_000);

afterAll(async () => { await db?.close(); });

describe("Google review reply exact Inbox bridge migration 278", () => {
  it("backfills a full reply, review and account preview without inventing a decision", async () => {
    const card = (await cards(LEGACY))[0]!;
    expect(card).toMatchObject({
      source_version: card.artifact_hash,
      status: "pending", preview_blocker: null,
      account_ref: "accounts/123/locations/456",
      destination: "google_business:accounts/123/locations/456/reviews/review-9/reply",
    });
    expect(card.preview).toMatchObject({
      reply_body: "Thank you, Jay", location_ref: "accounts/123/locations/456",
    });
    expect((await db.query("select * from public.approval_decision_events_v6")).rows)
      .toHaveLength(0);
  });

  it("keeps the owning transition and canonical AAL2 event atomic", async () => {
    await addReply(FRESH, "Exact new reply");
    const card = (await cards(FRESH))[0]!;
    await expect(asRole("authenticated", ADMIN, "aal1",
      "select public.decide_google_review_reply_from_inbox_v6($1,$2,$3,true,null)",
      [FRESH, card.source_version, card.artifact_hash]))
      .rejects.toThrow(/AAL2/i);
    await expect(asRole("authenticated", ADMIN, "aal2",
      "select public.decide_google_review_reply_v6($1,true,null)", [FRESH]))
      .rejects.toThrow(/permission denied/i);
    await expect(asRole("service_role", ADMIN, "aal2",
      "update public.google_review_replies set status='approved',approved_by=$1,approved_at=now() where id=$2",
      [ADMIN, FRESH]))
      .rejects.toThrow(/provisioned human with AAL2/i);
    await expect(asRole("authenticated", OTHER, "aal2",
      "select public.decide_google_review_reply_from_inbox_v6($1,$2,$3,true,null)",
      [FRESH, card.source_version, card.artifact_hash]))
      .rejects.toThrow(/assigned client manager/i);
    expect((await db.query<{ status: string }>(
      "select status from public.google_review_replies where id=$1", [FRESH],
    )).rows[0]!.status).toBe("drafted");
    await asRole("authenticated", MANAGER, "aal2",
      "select public.decide_google_review_reply_from_inbox_v6($1,$2,$3,true,null)",
      [FRESH, card.source_version, card.artifact_hash]);
    expect((await cards(FRESH))[0]!.status).toBe("approved");
    expect((await db.query<{ actor_id: string; actor_aal: string }>(
      "select actor_id,actor_aal from public.approval_decision_events_v6 where request_id=$1",
      [card.id],
    )).rows[0]).toEqual({ actor_id: MANAGER, actor_aal: "aal2" });
  });

  it("blocks changed review context and disappeared reviews, and never sends a draft", async () => {
    await addReply(GONE, "Thank you for the review");
    const card = (await cards(GONE))[0]!;
    await expect(db.query(
      "update public.google_review_replies set status='posting' where id=$1", [GONE],
    )).rejects.toThrow(/cannot be sent before/i);
    await db.query("update public.google_reviews set comment='Edited review' where id=$1", [REVIEW]);
    await expect(asRole("authenticated", ADMIN, "aal2",
      "select public.decide_google_review_reply_from_inbox_v6($1,$2,$3,true,null)",
      [GONE, card.source_version, card.artifact_hash]))
      .rejects.toThrow(/stale/i);
    await db.query("update public.google_reviews set comment='Great service',gone_at=now() where id=$1",
      [REVIEW]);
    await expect(asRole("authenticated", ADMIN, "aal2",
      "select public.decide_google_review_reply_from_inbox_v6($1,$2,$3,true,null)",
      [GONE, card.source_version, card.artifact_hash]))
      .rejects.toThrow(/not decision-ready/i);
  });

  it("rejects an edit between card read and click, then accepts only the new card", async () => {
    await db.query("update public.google_reviews set gone_at=null where id=$1", [REVIEW]);
    const id = "77777777-7777-4777-8777-777777777777";
    await addReply(id, "Old reply");
    const old = (await cards(id))[0]!;
    await db.query(`update public.google_review_replies
      set body='New reply',body_hash=encode(sha256(convert_to('New reply','UTF8')),'hex')
      where id=$1`, [id]);
    const versions = await cards(id);
    expect(versions).toHaveLength(2);
    const fresh = versions.find((row) => row.source_version !== old.source_version)!;
    await expect(asRole("authenticated", ADMIN, "aal2",
      "select public.decide_google_review_reply_from_inbox_v6($1,$2,$3,true,null)",
      [id, old.source_version, old.artifact_hash]))
      .rejects.toThrow(/selected reply card is stale/i);
    expect((await db.query<{ status: string }>(
      "select status from public.google_review_replies where id=$1", [id],
    )).rows[0]!.status).toBe("drafted");
    await asRole("authenticated", ADMIN, "aal2",
      "select public.decide_google_review_reply_from_inbox_v6($1,$2,$3,true,null)",
      [id, fresh.source_version, fresh.artifact_hash]);
    expect((await cards(id)).find((row) => row.id === fresh.id)!.status).toBe("approved");
    expect((await db.query("select * from public.approval_decision_events_v6 where request_id=$1",
      [old.id])).rows).toHaveLength(0);
  });

  it("leaves a blank external review reference visibly blocked", async () => {
    const id = "88888888-8888-4888-8888-888888888888";
    await db.query("update public.google_reviews set review_ref='' where id=$1", [REVIEW]);
    await addReply(id, "A reply with no target");
    const card = (await cards(id))[0]!;
    expect(card.preview_blocker).toMatch(/no exact external destination/i);
    await expect(asRole("authenticated", ADMIN, "aal2",
      "select public.decide_google_review_reply_from_inbox_v6($1,$2,$3,true,null)",
      [id, card.source_version, card.artifact_hash]))
      .rejects.toThrow(/not decision-ready/i);
  });
});
