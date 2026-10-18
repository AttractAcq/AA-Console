import { PGlite } from "@electric-sql/pglite";
import { readFile } from "node:fs/promises";
import { beforeAll, afterAll, expect, it } from "vitest";
let db: PGlite;
const a = "00000000-0000-0000-0000-000000000001",
  b = "00000000-0000-0000-0000-000000000002",
  proof = "00000000-0000-0000-0000-000000000003";
beforeAll(async () => {
  db = new PGlite();
  await db.exec(`create role authenticated; create role anon; create role service_role;
 create schema auth;
 create function auth.role() returns text language sql as $$select coalesce(current_setting('test.role',true),'authenticated')$$;
 create function auth.uid() returns uuid language sql as $$select '${a}'::uuid$$;
 create function is_admin() returns boolean language sql as $$select coalesce(current_setting('test.admin',true),'true')='true'$$;
 create function active_video_approval_manager(uuid) returns uuid language sql as $$select null::uuid$$;
 create function can_access_client(uuid) returns boolean language sql as $$select $1='${a}'::uuid$$;
 create type media_type as enum ('image','video','text'); create type content_format as enum ('single','carousel','story','reel');
 create table clients(id uuid primary key);
 create table client_pages(id uuid primary key,client_id uuid);
 create table client_proof_assets(id uuid primary key,client_id uuid,title text,body text,evidence text,usage_rights text,expires_on date,permission_basis text);
 create table agent_jobs(id uuid primary key default gen_random_uuid());
 create table client_ideas(id uuid primary key default gen_random_uuid(),client_id uuid,title text,body text,media_type media_type,content_format content_format,source text,proof_id uuid,created_by uuid,status text,content_territory text,job_id uuid);
 create table client_briefs(id uuid primary key default gen_random_uuid(),client_id uuid,source_idea_id uuid,proof_asset_id uuid,derived_from_asset_id uuid,body text);
 create table client_media_assets(id uuid primary key,client_id uuid,brief_id uuid,review_status text);
 create function enqueue_agent_job_internal(text,uuid,text,uuid,uuid,jsonb,text) returns uuid language plpgsql as $$declare j uuid; begin insert into agent_jobs default values returning id into j; return j; end $$;
 insert into clients values('${a}'),('${b}');
 insert into client_proof_assets values('${proof}','${a}','Actual result','A real customer quote','A real customer quote','approved',null,'Customer consent');
 insert into client_pages values('${b}','${b}');`);
  await db.exec(
    await readFile(
      new URL(
        "../../supabase/migrations/20261018100000_215_proof_factory_v2.sql",
        import.meta.url,
      ),
      "utf8",
    ),
  );
}, 30000);
afterAll(async () => {
  await db.close();
});
function request(
  id: string,
  over: {
    client?: string;
    asset?: string;
    media?: string;
    format?: string;
    direction?: string;
  } = {},
) {
  return db.query(
    "select request_proof_production_v2($1,$2,$3,$4,$5,$6,$7,$8) as id",
    [
      id,
      over.client ?? a,
      proof,
      over.asset ?? null,
      over.media ?? "image",
      over.format ?? "single",
      over.direction ?? "Use only this actual quote",
      "Organic Social Media",
    ],
  );
}
it("queues one brief idempotently and binds the exact source", async () => {
  const id = "00000000-0000-0000-0000-000000000010";
  await request(id);
  await request(id);
  expect(
    (await db.query("select * from proof_production_requests")).rows,
  ).toHaveLength(1);
  expect((await db.query("select * from agent_jobs")).rows).toHaveLength(1);
  await expect(request(id, { direction: "different" })).rejects.toThrow(
    "different instructions",
  );
  await expect(
    db.exec(
      `insert into client_briefs(client_id,source_idea_id,proof_asset_id) select client_id,idea_id,null from proof_production_requests`,
    ),
  ).rejects.toThrow("selected evidence");
  await db.exec(
    `insert into client_briefs(client_id,source_idea_id,proof_asset_id,body) select client_id,idea_id,source_proof_id,'Approved parent argument' from proof_production_requests`,
  );
});
it("rejects cross-client, uncleared, incompatible and unauthorized requests", async () => {
  const id = "00000000-0000-0000-0000-000000000011";
  await expect(request(id, { client: b })).rejects.toThrow("Clear this proof");
  await expect(
    request(id, { media: "text", format: "carousel" }),
  ).rejects.toThrow("Unsupported");
  await db.exec("update client_proof_assets set usage_rights='not_cleared'");
  await expect(request(id)).rejects.toThrow("Clear this proof");
  await db.exec(
    "update client_proof_assets set usage_rights='approved'; set test.admin='false'",
  );
  await expect(request(id)).rejects.toThrow("Only an admin");
  await db.exec("set test.admin='true'");
});
it("repurposes only an approved asset from the same evidence and retains its parent", async () => {
  const asset = "00000000-0000-0000-0000-000000000020",
    id = "00000000-0000-0000-0000-000000000021";
  await db.exec(
    `insert into client_media_assets select '${asset}',client_id,id,'pending' from client_briefs limit 1`,
  );
  await expect(request(id, { asset })).rejects.toThrow("approved asset");
  await db.exec("update client_media_assets set review_status='approved'");
  await request(id, { asset });
  await db.exec(
    `insert into client_briefs(client_id,source_idea_id,proof_asset_id) select client_id,idea_id,source_proof_id from proof_production_requests where id='${id}'`,
  );
  expect(
    (
      await db.query(
        `select derived_from_asset_id from client_briefs where derived_from_asset_id is not null`,
      )
    ).rows,
  ).toEqual([{ derived_from_asset_id: asset }]);
});
it("rejects cross-client capture pages and mismatched source classification", async () => {
  await expect(
    db.exec(
      `insert into proof_capture_configs(client_id,method,name,page_id) values('${a}','field_capture','Portal','${b}')`,
    ),
  ).rejects.toThrow("belonging to this client");
  await expect(
    db.exec(
      "update client_proof_assets set source_category='customers',source_kind='Historical Project Import'",
    ),
  ).rejects.toThrow();
  await db.exec(
    "update client_proof_assets set source_category='customers',source_kind='Online Reviews'",
  );
  await db.exec(
    `insert into proof_capture_configs(client_id,method,name,instructions) values('${a}','guided_interview','Interview','Ask for concrete outcomes')`,
  );
});
