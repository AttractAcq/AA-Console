import { PGlite } from "@electric-sql/pglite";
import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const ADMIN = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CLIENT_USER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
let db: PGlite;

async function asUser<T extends Record<string, unknown>>(id: string, sql: string) {
  await db.query("select set_config('request.jwt.claim.role','authenticated',false)");
  await db.query("select set_config('request.jwt.claim.sub',$1,false)", [id]);
  await db.exec("set role authenticated");
  try {
    return (await db.query<T>(sql)).rows;
  } finally {
    await db.exec("reset role");
    await db.exec("select set_config('request.jwt.claim.role','',false); select set_config('request.jwt.claim.sub','',false)");
  }
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
      $$ select '{}'::jsonb $$;
    create table public.clients (id uuid primary key);
    create table public.profiles (id uuid primary key, role text not null);
    insert into public.profiles values ('${ADMIN}','admin'),('${CLIENT_USER}','client');
    create function public.current_role_of() returns text language sql stable
      security definer set search_path=public as $$
        select role from public.profiles where id=auth.uid()
      $$;
    create function public.is_admin() returns boolean language sql stable
      security definer set search_path=public as $$
        select coalesce(public.current_role_of()='admin',false)
      $$;
    create function public.active_video_approval_manager(uuid) returns uuid
      language sql stable as $$ select null::uuid $$;
    create function public.lock_down_definer_functions() returns integer
      language sql as $$ select 0 $$;
    grant usage on schema public,auth to authenticated,service_role;
    grant execute on function auth.uid(),auth.role(),auth.jwt(),
      public.current_role_of(),public.is_admin() to authenticated,service_role;
  `);
  for (const filename of [
    "20261030110000_273_canonical_approval_ledger.sql",
    "20261030160000_279_approval_class_coverage.sql",
  ]) {
    await db.exec(await readFile(new URL(`../../supabase/migrations/${filename}`, import.meta.url), "utf8"));
  }
}, 60_000);

afterAll(async () => { await db?.close(); });

describe("34-class Approval Inbox coverage feed migration 279", () => {
  it("contains every class exactly once and remains red while executors are missing", async () => {
    const classes = (await db.query<{
      class_id: number; class_key: string; overall_status: string;
      source_state: string; decision_state: string; executor_state: string;
    }>("select * from public.approval_class_coverage_v6 order by class_id")).rows;
    expect(classes).toHaveLength(34);
    expect(classes.map((row) => row.class_id)).toEqual(
      Array.from({ length: 34 }, (_, index) => index + 1),
    );
    expect(new Set(classes.map((row) => row.class_key)).size).toBe(34);
    expect(classes.every((row) => row.overall_status !== "operational")).toBe(true);
    expect(classes.find((row) => row.class_id === 1)).toMatchObject({
      class_key: "engine_slot", source_state: "blocked",
      decision_state: "missing", executor_state: "missing",
    });
    expect(classes.find((row) => row.class_id === 21)).toMatchObject({
      class_key: "google_review_reply", source_state: "verified",
      decision_state: "verified", executor_state: "missing",
      overall_status: "blocked",
    });
    expect(classes.find((row) => row.class_id === 34)).toMatchObject({
      class_key: "team_invitation", overall_status: "missing",
    });
    const summary = (await db.query<{
      expected_classes: number; inventoried_classes: number;
      operational_classes: number; fully_operational: boolean;
    }>("select * from public.approval_coverage_summary_v6")).rows[0]!;
    expect(summary).toMatchObject({ expected_classes: 34, inventoried_classes: 34,
      operational_classes: 0, fully_operational: false });
  });

  it("requires separate executor evidence and preserves an append-only history", async () => {
    await expect(db.query(`insert into public.approval_class_coverage_versions_v6
      (class_id,revision,class_key,title,source_state,source_evidence,
       decision_state,decision_evidence,executor_state)
      values (21,2,'google_review_reply','Google review reply',
        'verified','278 source trigger','verified','278 decision trigger','verified')`))
      .rejects.toThrow(/check constraint/i);
    await expect(db.query(`insert into public.approval_class_coverage_versions_v6
      (class_id,revision,class_key,title,source_state,
       decision_state,executor_state)
      values (21,2,'renamed_reply','Google review reply',
        'missing','missing','missing')`))
      .rejects.toThrow(/immutable class identity/i);
    await expect(db.query(`update public.approval_class_coverage_versions_v6
      set executor_state='verified' where class_id=21`))
      .rejects.toThrow(/append-only/i);
    await expect(db.query("delete from public.approval_class_coverage_versions_v6 where class_id=21"))
      .rejects.toThrow(/append-only/i);
    await expect(db.query("truncate public.approval_class_coverage_versions_v6"))
      .rejects.toThrow(/append-only/i);
  });

  it("exposes the feed to an admin, not to a client reader", async () => {
    const admin = await asUser<{ class_id: number }>(ADMIN,
      "select class_id from public.approval_class_coverage_v6");
    const client = await asUser<{ class_id: number }>(CLIENT_USER,
      "select class_id from public.approval_class_coverage_v6");
    expect(admin).toHaveLength(34);
    expect(client).toHaveLength(0);
  });
});
