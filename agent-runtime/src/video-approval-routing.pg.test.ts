import { PGlite } from "@electric-sql/pglite";
import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, expect, it } from "vitest";

const owner = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const manager = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const clientUser = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const client = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const asset = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
let db: PGlite;

async function as(user: string) {
  await db.query("select set_config('test.user_id',$1,false)", [user]);
}

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    create role anon; create role authenticated;
    create schema auth;
    create function auth.uid() returns uuid language sql stable as
      $$ select nullif(current_setting('test.user_id', true),'')::uuid $$;
    create type app_role as enum ('admin','employee','client');
    create type team_category as enum ('avatars','editors','smm');
    create type media_type as enum ('image','text','video');
    create type content_format as enum ('single','carousel','story','reel');
    create type review_status as enum ('pending','approved','rejected');
    create table profiles(id uuid primary key, role app_role, full_name text, email text);
    create table client_users(client_id uuid, user_id uuid);
    create table team_members(id uuid primary key, user_id uuid, active boolean, category team_category);
    create table client_assignments(id uuid primary key, member_id uuid, client_id uuid, ended_at timestamptz,
      created_at timestamptz default now());
    create table client_media_assets(id uuid primary key, client_id uuid, media_type media_type,
      content_format content_format, edit_stage text, render_path text, storage_path text, review_status review_status,
      human_approved_at timestamptz);
    create table client_asset_reviews(asset_id uuid, decision review_status, reason text, reviewed_by uuid);
    create function is_admin() returns boolean language sql stable as
      $$ select exists(select 1 from profiles where id=auth.uid() and role='admin') $$;
    create function can_access_client(uuid) returns boolean language sql stable as
      $$ select exists(select 1 from client_users where client_id=$1 and user_id=auth.uid())
          or is_admin() or exists(select 1 from team_members tm join client_assignments ca on ca.member_id=tm.id
             where ca.client_id=$1 and tm.user_id=auth.uid() and ca.ended_at is null) $$;
    insert into profiles values
      ('${owner}','admin','Owner','owner@example.com'),
      ('${manager}','employee','Manager','manager@example.com'),
      ('${clientUser}','client','Client','client@example.com');
    insert into client_users values ('${client}','${clientUser}');
    insert into team_members values ('11111111-1111-4111-8111-111111111111','${manager}',true,'smm');
    insert into client_assignments(id,member_id,client_id)
      values ('22222222-2222-4222-8222-222222222222','11111111-1111-4111-8111-111111111111','${client}');
    insert into client_media_assets values ('${asset}','${client}','video','reel','review_ready','cut.mp4','opening.png','pending',null);
  `);
  await db.exec(await readFile(new URL("../../supabase/migrations/20261010130000_175_video_approval_routing.sql", import.meta.url), "utf8"));
});
afterAll(async () => { await db?.close(); });

it("requires the configured owner and active SMM, then optional client", async () => {
  await as(owner);
  await expect(db.query("select review_media_asset($1,'approved')", [asset]))
    .rejects.toThrow(/Configure an owner/);
  await db.query("select set_content_approval_owner($1)", [owner]);
  await db.query("select sign_video_approval($1,'owner')", [asset]);
  await expect(db.query("select review_media_asset($1,'approved')", [asset]))
    .rejects.toThrow(/sign-offs/);

  await as(manager);
  await db.query("select sign_video_approval($1,'manager')", [asset]);
  await db.query("select request_video_client_approval($1,$2)", [asset, clientUser]);
  await expect(db.query("select review_media_asset($1,'approved')", [asset]))
    .rejects.toThrow(/sign-offs/);

  await as(clientUser);
  await db.query("select decline_video_client_approval($1,$2)", [asset, "Tighten the opening."]);
  await expect(db.query("select sign_video_approval($1,'client')", [asset]))
    .rejects.toThrow(/declined/);
  await as(manager);
  await db.query("select request_video_client_approval($1,$2)", [asset, clientUser]);
  await as(clientUser);
  await db.query("select sign_video_approval($1,'client')", [asset]);
  await expect(db.query("select review_media_asset($1,'approved')", [asset]))
    .rejects.toThrow(/Only the owner or active SMM/);
  await as(owner);
  await db.query("select review_media_asset($1,'approved')", [asset]);
  const state = await db.query<{ review_status: string; human_approved_at: string }>(
    "select review_status,human_approved_at from client_media_assets where id=$1", [asset]);
  expect(state.rows[0]?.review_status).toBe("approved");
  expect(state.rows[0]?.human_approved_at).toBeTruthy();
  await expect(db.query("update client_media_assets set render_path='replacement.mp4' where id=$1", [asset]))
    .rejects.toThrow(/Create a new version/);
});
