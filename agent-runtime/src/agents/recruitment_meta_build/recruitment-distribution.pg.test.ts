import { PGlite } from "@electric-sql/pglite";
import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, expect, it } from "vitest";

const admin = "11111111-1111-4111-8111-111111111111";
const employee = "22222222-2222-4222-8222-222222222222";
const house = "33333333-3333-4333-8333-333333333333";
const other = "44444444-4444-4444-8444-444444444444";
const brief = "55555555-5555-4555-8555-555555555555";
const asset = "66666666-6666-4666-8666-666666666666";
const foreignAsset = "77777777-7777-4777-8777-777777777777";
let db: PGlite;

async function asUser(id: string) {
  await db.exec(`reset role; select set_config('request.jwt.claim.role','authenticated',false);
    select set_config('request.jwt.claim.sub','${id}',false); set role authenticated;`);
}

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    create role anon; create role authenticated; create role service_role bypassrls;
    create schema auth;
    create function auth.uid() returns uuid language sql stable as
      $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
    create function auth.role() returns text language sql stable as
      $$ select current_setting('request.jwt.claim.role',true) $$;
    create table clients(id uuid primary key);
    create table profiles(id uuid primary key);
    create table client_briefs(
      id uuid primary key, client_id uuid references clients(id), purpose text,
      hook text, script text, call_to_action text, apply_url text
    );
    create table client_media_assets(
      id uuid primary key, client_id uuid references clients(id), brief_id uuid references client_briefs(id),
      purpose text, review_status text, media_type text, content_format text, storage_path text
    );
    create table agents(
      agent_key text primary key, name text, initials text, domain text,
      description text, requires_upstream text[], requires_input boolean
    );
    create table agent_jobs(
      id uuid primary key default gen_random_uuid(), agent_key text, client_id uuid,
      input_table text, input_id uuid, status text not null default 'queued'
    );
    create function is_admin() returns boolean language sql stable as
      $$ select auth.uid()='${admin}'::uuid $$;
    create function can_access_client(uuid) returns boolean language sql stable as
      $$ select is_admin() $$;
    create function aa_house_client_id() returns uuid language sql stable as
      $$ select '${house}'::uuid $$;
    create function enqueue_agent_job_internal(
      p_agent_key text, p_client_id uuid, p_input_table text, p_input_id uuid,
      p_actor uuid, p_params jsonb default '{}'::jsonb, p_description text default 'Queued'
    ) returns uuid language plpgsql security definer as $$
    declare v_id uuid;
    begin
      insert into agent_jobs(agent_key,client_id,input_table,input_id)
      values(p_agent_key,p_client_id,p_input_table,p_input_id) returning id into v_id;
      return v_id;
    end; $$;
    insert into clients(id) values ('${house}'),('${other}');
    insert into profiles(id) values ('${admin}'),('${employee}');
    insert into client_briefs(id,client_id,purpose,hook,script,call_to_action,apply_url)
      values ('${brief}','${house}','recruitment','Join AA','Hiring an editor','APPLY_NOW','https://example.com/apply');
    insert into client_media_assets(id,client_id,brief_id,purpose,review_status,media_type,content_format,storage_path)
      values ('${asset}','${house}','${brief}','recruitment','approved','image','single','hiring/editor.png'),
             ('${foreignAsset}','${other}',null,'recruitment','approved','image','single','other/ad.png');
    grant usage on schema public,auth to authenticated;
    grant select on agent_jobs to authenticated;
    grant execute on function auth.uid(),auth.role(),is_admin(),can_access_client(uuid),aa_house_client_id() to authenticated;
  `);
  const sql = await readFile(new URL("../../../../supabase/migrations/20260926110000_133_recruitment_meta_distribution.sql", import.meta.url), "utf8");
  await db.exec(sql);
});
afterAll(async () => { await db?.close(); });

it("queues selected house recruitment ads into a separate paused-build campaign", async () => {
  await asUser(admin);
  const result = await db.query<{ id: string }>(
    "select create_recruitment_meta_campaign($1,$2,$3,$4) as id",
    ["Editor hiring", 25, ["ZA"], [asset]],
  );
  const id = result.rows[0]!.id;
  const row = await db.query<{ client_id: string; meta_campaign_id: string | null }>(
    "select client_id,meta_campaign_id from recruitment_meta_campaigns where id=$1", [id]);
  expect(row.rows[0]).toEqual({ client_id: house, meta_campaign_id: null });
  expect((await db.query("select asset_id from recruitment_meta_campaign_ads where campaign_id=$1", [id])).rows).toHaveLength(1);
  expect((await db.query("select id from agent_jobs where input_id=$1 and agent_key='recruitment_meta_build'", [id])).rows).toHaveLength(1);
  await expect(db.query("select request_recruitment_meta_build($1)", [id])).rejects.toThrow(/already queued/);
  await expect(db.query("select * from delete_recruitment_ad($1)", [brief]))
    .rejects.toThrow(/cannot be deleted here/);
});

it("refuses non-admins, foreign assets and duplicate selections", async () => {
  await asUser(employee);
  await expect(db.query("select create_recruitment_meta_campaign($1,$2,$3,$4)",
    ["Hiring", 25, ["ZA"], [asset]])).rejects.toThrow(/Only an admin/);
  expect((await db.query("select id from recruitment_meta_campaigns")).rows).toHaveLength(0);
  await asUser(admin);
  await expect(db.query("select create_recruitment_meta_campaign($1,$2,$3,$4)",
    ["Hiring", 25, ["ZA"], [foreignAsset]])).rejects.toThrow(/approved AA recruitment/);
  await expect(db.query("select create_recruitment_meta_campaign($1,$2,$3,$4)",
    ["Hiring", 25, ["ZA"], [asset, asset]])).rejects.toThrow(/distinct approved/);
  await expect(db.query("select create_recruitment_meta_campaign($1,$2,$3,$4)",
    ["Hiring", 25, ["ZA", null], [asset]])).rejects.toThrow(/two-letter countries/);
});
