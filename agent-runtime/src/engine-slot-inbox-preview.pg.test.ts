import { PGlite } from "@electric-sql/pglite";
import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const ADMIN = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const REVIEWER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const STRANGER = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const CLIENT = "11111111-1111-4111-8111-111111111111";
const OTHER_CLIENT = "22222222-2222-4222-8222-222222222222";
const ASSET = "33333333-3333-4333-8333-333333333333";
const LEGACY_SLOT = "44444444-4444-4444-8444-444444444444";
const LEGACY_ENTRY = "55555555-5555-4555-8555-555555555555";
const MISSING_ENTRY_SLOT = "66666666-6666-4666-8666-666666666666";
const FRESH_SLOT = "77777777-7777-4777-8777-777777777777";
const FRESH_ENTRY = "88888888-8888-4888-8888-888888888888";
const SECOND_ENTRY = "99999999-9999-4999-8999-999999999999";

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

async function cards(slot: string) {
  return (await db.query<{
    id: string; source_version: string; preview_blocker: string;
    preview: { post_copy: { caption: string }[]; database_snapshot_sha256: string };
    artifact_hash: string | null; status: string;
  }>(`select id,source_version,preview_blocker,preview,artifact_hash,status
        from public.approval_inbox_v6
       where source_kind='engine_slot' and source_id=$1
       order by requested_at,id`, [slot])).rows;
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
    insert into public.profiles values
      ('${ADMIN}','admin'),('${REVIEWER}','client'),('${STRANGER}','client');
    insert into public.client_users values
      ('${CLIENT}','${REVIEWER}'),('${OTHER_CLIENT}','${STRANGER}');
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
      language sql stable as $$ select null::uuid $$;
    create function public.lock_down_definer_functions() returns integer
      language sql as $$ select 0 $$;
    grant usage on schema public,auth to authenticated,service_role;
    grant execute on function auth.uid(),auth.role(),auth.jwt(),
      public.current_role_of(),public.is_admin(),public.can_access_client(uuid)
      to authenticated,service_role;
    create table public.client_media_assets (
      id uuid primary key, client_id uuid not null, title text,
      media_type text not null, content_format text not null,
      storage_path text not null, render_path text,
      review_status text not null, updated_at timestamptz not null default now()
    );
    create table public.content_slots (
      id uuid primary key, client_id uuid not null,
      platform text not null, scheduled_at timestamptz not null,
      format text not null, stage text not null,
      attempts integer not null default 0, brief_id uuid, idea_id uuid,
      asset_id uuid
    );
    create table public.slot_events (
      id uuid primary key, slot_id uuid not null,
      to_stage text not null, created_at timestamptz not null default now()
    );
    create table public.post_copy (
      id uuid primary key, asset_id uuid, platform text not null,
      version integer not null, caption text, hashtags text[] not null default '{}',
      alt_text text, link_url text, first_comment text, cta text
    );
    insert into public.client_media_assets values
      ('${ASSET}','${CLIENT}','Actual asset','image','single',
       '${CLIENT}/media/asset.png',null,'pending',now());
    insert into public.post_copy
      (id,asset_id,platform,version,caption,hashtags)
      values ('aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee','${ASSET}',
        'instagram',1,'Frozen exact caption',array['#local']);
    insert into public.content_slots
      (id,client_id,platform,scheduled_at,format,stage,asset_id) values
      ('${LEGACY_SLOT}','${CLIENT}','instagram','2030-01-01','single',
        'awaiting_approval','${ASSET}'),
      ('${MISSING_ENTRY_SLOT}','${CLIENT}','instagram','2030-01-02','single',
        'awaiting_approval','${ASSET}'),
      ('${FRESH_SLOT}','${CLIENT}','instagram','2030-01-03','single',
        'qa','${ASSET}');
    insert into public.slot_events(id,slot_id,to_stage)
      values ('${LEGACY_ENTRY}','${LEGACY_SLOT}','awaiting_approval');
  `);
  for (const filename of [
    "20261030110000_273_canonical_approval_ledger.sql",
    "20261030141000_277_engine_slot_preview_inbox.sql",
  ]) {
    await db.exec(await readFile(new URL(`../../supabase/migrations/${filename}`, import.meta.url), "utf8"));
  }
  await db.exec(`
    create function public.fixture_decide_slot(p_id uuid)
      returns uuid language sql security definer set search_path=public as $$
        select public.record_approval_decision_v6(p_id,'approved',null,
          'slot-fixture:' || p_id::text,null)
      $$;
    grant execute on function public.fixture_decide_slot(uuid)
      to authenticated,service_role;
  `);
}, 60_000);

afterAll(async () => { await db?.close(); });

describe("Engine slot blocked Inbox preview migration 277", () => {
  it("backfills the real approval-entry epoch and exposes missing legacy history", async () => {
    const real = await cards(LEGACY_SLOT);
    expect(real).toHaveLength(1);
    expect(real[0]!.source_version).toBe(LEGACY_ENTRY);
    expect(real[0]!.preview.post_copy[0]!.caption).toBe("Frozen exact caption");
    expect(real[0]!.preview.database_snapshot_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(real[0]!.artifact_hash).toBeNull();
    expect(real[0]!.preview_blocker).toMatch(/media byte SHA-256/i);
    expect(await cards(MISSING_ENTRY_SLOT)).toMatchObject([
      { source_version: "legacy-missing-entry-event",
        status: "pending", artifact_hash: null },
    ]);
    expect((await db.query("select * from public.approval_decision_events_v6")).rows)
      .toHaveLength(0);
  });

  it("registers each new entry as a separate blocked source version and freezes copy", async () => {
    await db.query("update public.content_slots set stage='awaiting_approval' where id=$1", [FRESH_SLOT]);
    await db.query("insert into public.slot_events(id,slot_id,to_stage) values($1,$2,'awaiting_approval')",
      [FRESH_ENTRY, FRESH_SLOT]);
    const first = (await cards(FRESH_SLOT))[0]!;
    expect(first.source_version).toBe(FRESH_ENTRY);
    expect(first.preview.post_copy[0]!.caption).toBe("Frozen exact caption");
    await db.query("update public.post_copy set caption='New version',version=2 where asset_id=$1", [ASSET]);
    await db.query("update public.content_slots set stage='rejected' where id=$1", [FRESH_SLOT]);
    await db.query("update public.content_slots set stage='awaiting_approval' where id=$1", [FRESH_SLOT]);
    await db.query("insert into public.slot_events(id,slot_id,to_stage) values($1,$2,'awaiting_approval')",
      [SECOND_ENTRY, FRESH_SLOT]);
    const all = await cards(FRESH_SLOT);
    expect(all).toHaveLength(2);
    expect(all.map((card) => card.source_version)).toContain(SECOND_ENTRY);
    expect(all.find((card) => card.source_version === FRESH_ENTRY)?.preview.post_copy[0]!.caption)
      .toBe("Frozen exact caption");
    expect(all.find((card) => card.source_version === SECOND_ENTRY)?.preview.post_copy[0]!.caption)
      .toBe("New version");
    await expect(asRole("authenticated", ADMIN, "aal2",
      "select public.fixture_decide_slot($1)", [first.id]))
      .rejects.toThrow(/incomplete exact-version evidence/i);
  });

  it("shows slot scope only to the client reviewer or admin", async () => {
    const own = await asRole("authenticated", REVIEWER, "aal1",
      "select source_id from public.approval_inbox_v6 where source_kind='engine_slot'");
    expect(own.length).toBeGreaterThan(0);
    const other = await asRole("authenticated", STRANGER, "aal2",
      "select source_id from public.approval_inbox_v6 where source_kind='engine_slot'");
    expect(other).toHaveLength(0);
    const admin = await asRole("authenticated", ADMIN, "aal2",
      "select source_id from public.approval_inbox_v6 where source_kind='engine_slot'");
    expect(admin.length).toBeGreaterThan(0);
  });
});
