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
 create table client_proof_assets(id uuid primary key default gen_random_uuid(),client_id uuid,title text,body text,evidence text,usage_rights text,expires_on date,permission_basis text);
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
        "../../../supabase/migrations/20261018100000_215_proof_factory_v2.sql",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  await db.exec(`create table profiles(id uuid primary key); insert into profiles values('${a}');
 create schema storage; create table storage.objects(bucket_id text,name text);
 alter table client_proof_assets add media_type media_type, add storage_path text, add source text;
 alter table agent_jobs add status text default 'queued',add error text,add terminal boolean default false,add input_id uuid,add input_table text,add agent_key text;
 alter table client_briefs add media_type media_type default 'image', add format_code text, add status text default 'approved';
 alter table client_media_assets add media_type media_type default 'image',add render_path text;
 create function build_brief_with_ai(p_brief_id uuid,p_quality text,p_size text,p_ref text,p_frames integer,p_directions text[]) returns uuid language plpgsql as $$declare j uuid; begin if not is_admin() then raise exception 'Admin only'; end if; insert into agent_jobs default values returning id into j; update client_briefs set status='in_production' where id=p_brief_id; return j; end $$;`);
  for (const file of [
    "20261018110000_216_proof_capture_delivery.sql",
    "20261018120000_217_proof_auto_production.sql",
  ])
    await db.exec(
      await readFile(
        new URL("../../../supabase/migrations/" + file, import.meta.url),
        "utf8",
      ),
    );
}, 30000);
afterAll(async () => {
  await db.close();
});
const config = "00000000-0000-0000-0000-000000000020",
  link = "00000000-0000-0000-0000-000000000021",
  submission = "00000000-0000-0000-0000-000000000022",
  delivery = "00000000-0000-0000-0000-000000000023";
it("captures once, preserves clearance boundary and enforces quota/revocation", async () => {
  await db.exec(
    `insert into proof_capture_configs(id,client_id,method,name,instructions) values('${config}','${a}','field_capture','Job evidence','Tell us what happened'); insert into proof_capture_links(id,client_id,config_id,token_hash,expires_at) values('${link}','${a}','${config}','hash',now()+interval '1 day');`,
  );
  const submit = () =>
    db.query(
      "select accept_proof_capture_submission('hash',$1,'Technician','job-1','Actual work completed',null,null,'customers','Online Reviews','Permission to review')",
      [submission],
    );
  await expect(submit()).rejects.toThrow("Service role");
  await db.exec("set test.role='service_role'");
  await submit();
  await submit();
  expect(
    (await db.query("select * from proof_capture_submissions")).rows,
  ).toHaveLength(1);
  expect(
    (
      await db.query(
        "select usage_rights from client_proof_assets where id<>( $1::uuid )",
        [proof],
      )
    ).rows[0],
  ).toEqual({ usage_rights: "not_cleared" });
  await expect(
    db.query(
      "select accept_proof_capture_submission('hash',gen_random_uuid(),'Other','','Evidence',null,null,'customers','Online Reviews','Consent')",
    ),
  ).rejects.toThrow("unavailable");
  await db.exec(
    `update proof_capture_links set revoked_at=now() where id='${link}'`,
  );
  await expect(submit()).rejects.toThrow("unavailable");
});
it("requires approval, claims once and quarantines ambiguous sends", async () => {
  await db.exec(
    `update proof_capture_links set revoked_at=null,submissions=0; insert into proof_request_deliveries(id,client_id,config_id,link_id,event_key,recipient,channel,subject,message,capture_url) values('${delivery}','${a}','${config}','${link}','event1','a@example.com','email','Evidence','Please submit','https://example.com');`,
  );
  expect(
    (await db.query("select (claim_proof_delivery()).id as id")).rows[0],
  ).toEqual({ id: null });
  await db.exec("set test.role='authenticated';set test.admin='false'");
  await expect(
    db.query("select decide_proof_delivery($1,true)", [delivery]),
  ).rejects.toThrow("Not permitted");
  await db.exec("set test.admin='true'");
  await db.query("select decide_proof_delivery($1,true)", [delivery]);
  await db.exec("set test.role='service_role'");
  expect(
    (await db.query("select (claim_proof_delivery()).id as id")).rows[0],
  ).toEqual({ id: delivery });
  expect(
    (await db.query("select (claim_proof_delivery()).id as id")).rows[0],
  ).toEqual({ id: null });
  await db.exec(
    "update proof_request_deliveries set lease_until=now()-interval '1 minute'",
  );
  await db.query("select claim_proof_delivery()");
  expect(
    (await db.query("select status from proof_request_deliveries")).rows[0],
  ).toEqual({ status: "uncertain" });
});
it("automatically builds once, waits for retries and completes only with output", async () => {
  await db.exec("set test.role='authenticated';set test.admin='true'");
  const result = await db.query<{ id: string }>(
    "select request_proof_auto_production(gen_random_uuid(),$1,$2,null,'image','single','Genuine evidence only','Organic Social Media') as id",
    [a, proof],
  );
  const rid = result.rows[0]!.id;
  await db.exec("set test.role='service_role';set test.admin='false'");
  await db.exec(
    `update agent_jobs set status='failed',terminal=false where id=(select job_id from proof_production_requests where id='${rid}')`,
  );
  await db.query("select advance_proof_production()");
  expect(
    (
      await db.query(
        "select production_status from proof_production_requests where id=$1",
        [rid],
      )
    ).rows[0],
  ).toEqual({ production_status: "briefing" });
  await db.exec(
    `insert into client_briefs(client_id,source_idea_id,proof_asset_id,body) select client_id,idea_id,source_proof_id,'Brief' from proof_production_requests where id='${rid}'`,
  );
  await db.query("select advance_proof_production()");
  await db.query("select advance_proof_production()");
  expect(
    (
      await db.query(
        "select production_status from proof_production_requests where id=$1",
        [rid],
      )
    ).rows[0],
  ).toEqual({ production_status: "building" });
  expect((await db.query("select * from agent_jobs")).rows).toHaveLength(2);
  await db.exec(
    `update agent_jobs set status='completed' where id=(select production_job_id from proof_production_requests where id='${rid}'); insert into client_media_assets(id,client_id,brief_id) select gen_random_uuid(),client_id,id from client_briefs where source_idea_id=(select idea_id from proof_production_requests where id='${rid}')`,
  );
  await db.query("select advance_proof_production()");
  expect(
    (
      await db.query(
        "select production_status from proof_production_requests where id=$1",
        [rid],
      )
    ).rows[0],
  ).toEqual({ production_status: "complete" });
});
