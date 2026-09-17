import { PGlite } from "@electric-sql/pglite";
import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

const ADMIN = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const EMPLOYEE = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const PAYING = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

let db: PGlite;
const migration = async (file: string) =>
  readFile(new URL(`../../supabase/migrations/${file}`, import.meta.url), "utf8");

function must<T>(row: T | undefined): T {
  expect(row).toBeDefined();
  return row as T;
}

async function asUser(id: string) {
  await db.exec(`
    reset role;
    select set_config('request.jwt.claim.role','authenticated',false);
    select set_config('request.jwt.claim.sub','${id}',false);
    set role authenticated;
  `);
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
      $$ select current_setting('request.jwt.claim.role', true) $$;
    grant usage on schema public, auth to authenticated, service_role, anon;
  `);
  for (const file of [
    "20260903104450_01_foundations_roles_clients.sql",
    "20260903104529_02_team_and_operations.sql",
    "20260903104615_03_agent_registry_and_job_queue.sql",
    "20260903104816_05_content_chain_proof_ideas_briefs_media.sql",
    "20260904083559_15_brief_refs_and_job_link.sql",
    "20260907170000_55_structured_briefs.sql",
  ]) {
    await db.exec(await migration(file));
  }
  await db.exec(`
    alter table agents add column if not exists scheduled_only boolean not null default false;
    alter table agent_jobs add column if not exists params jsonb not null default '{}'::jsonb;
    revoke execute on all functions in schema public from public, anon;
    grant execute on function is_admin() to authenticated;
    grant execute on function can_access_client(uuid) to authenticated;
  `);
  for (const file of [
    "20260905131703_39_brief_build_pipeline.sql",
    "20260905134322_41_creative_reference_image.sql",
    "20260905143029_42_creative_renders.sql",
    "20260905143101_43_render_rpcs.sql",
    "20260917000000_94_team_recruitment.sql",
  ]) {
    await db.exec(await migration(file));
  }
  await db.exec(`
    grant execute on function aa_house_client_id() to authenticated;
    grant execute on function create_recruitment_brief(recruitment_role, text, text, text, text, text, text, text, text) to authenticated;
    grant execute on function approve_recruitment_brief(uuid) to authenticated;
    grant execute on function generate_recruitment_ad(uuid, text, text) to authenticated;
    grant execute on function build_brief_with_ai(uuid, text, text, text) to authenticated;
    grant select on table clients, client_briefs, agent_jobs, creative_generations, creative_renders
      to authenticated;
  `);
}, 60_000);

afterAll(async () => {
  await db?.close();
});

beforeEach(async () => {
  await db.exec(`
    reset role;
    truncate client_media_assets, creative_renders, creative_generations, agent_job_events, agent_jobs,
      client_briefs, ref_counters, client_users, clients, profiles, auth.users cascade;
    insert into auth.users (id, email) values
      ('${ADMIN}','alex@attractacq.com'),
      ('${EMPLOYEE}','editor@attractacq.com');
    update profiles set role = 'admin' where id = '${ADMIN}';
    update profiles set role = 'employee' where id = '${EMPLOYEE}';
    insert into clients (id, name, initials, is_internal) values
      ('${PAYING}', 'Harbour Dental', 'HD', false);
  `);
});

const createSql = (role = "editor") =>
  `select create_recruitment_brief(
     '${role}'::recruitment_role,
     'Editor — Attract Acquisition',
     'Cut the work that actually ships',
     'Attract Acquisition is hiring an editor.',
     'Apply now',
     'https://attractacq.com/careers/editor',
     'Documentary light',
     '£250/day',
     'Finish on-brand stills'
   ) as id`;

describe("recruitment schema — role enum and purpose tag", () => {
  it("rejects a role that is not editor, smm or avatar", async () => {
    await asUser(ADMIN);
    await expect(
      db.query(`select 'producer'::recruitment_role`),
    ).rejects.toThrow(/producer|invalid input value/i);
  });

  it("tags a created brief purpose=recruitment on the house client", async () => {
    await asUser(ADMIN);
    const created = await db.query<{ id: string }>(createSql("smm"));
    const rows = await db.query<{
      purpose: string;
      recruitment_role: string;
      channel_intent: string;
      media_type: string;
      apply_url: string;
      is_internal: boolean;
      name: string;
    }>(`
      select b.purpose::text, b.recruitment_role::text, b.channel_intent, b.media_type::text,
             b.apply_url, c.is_internal, c.name
        from client_briefs b
        join clients c on c.id = b.client_id
       where b.id = '${must(created.rows[0]).id}'
    `);
    expect(rows.rows[0]).toMatchObject({
      purpose: "recruitment",
      recruitment_role: "smm",
      channel_intent: "Meta static",
      media_type: "image",
      apply_url: "https://attractacq.com/careers/editor",
      is_internal: true,
      name: "Attract Acquisition",
    });
  });

  it("refuses to attach a recruitment brief to a paying client", async () => {
    await asUser(ADMIN);
    await db.query(createSql());
    await db.exec("reset role");
    await expect(
      db.exec(`
        insert into client_briefs (
          client_id, title, media_type, purpose, recruitment_role, apply_url, hook, script, call_to_action
        ) values (
          '${PAYING}', 'Leak', 'image', 'recruitment', 'editor',
          'https://attractacq.com/careers/editor', 'H', 'P', 'Apply now'
        )
      `),
    ).rejects.toThrow(/house client/i);
  });
});

describe("recruitment — Admin-only approve", () => {
  it("lets an admin approve a draft and blocks an employee", async () => {
    await asUser(ADMIN);
    const created = await db.query<{ id: string }>(createSql("avatar"));
    const id = must(created.rows[0]).id;

    await asUser(EMPLOYEE);
    await expect(db.query(`select approve_recruitment_brief('${id}')`)).rejects.toThrow(
      /only an admin/i,
    );

    await asUser(ADMIN);
    await db.query(`select approve_recruitment_brief('${id}')`);
    const status = await db.query<{ status: string }>(
      `select status::text as status from client_briefs where id = '${id}'`,
    );
    expect(must(status.rows[0]).status).toBe("approved");
  });
});

describe("recruitment — generate reuses the mig-93 render_id path", () => {
  it("inserts a generation and render, then enqueues creative_build with params.render_id", async () => {
    await asUser(ADMIN);
    const created = await db.query<{ id: string }>(createSql("editor"));
    const briefId = must(created.rows[0]).id;
    await db.query(`select approve_recruitment_brief('${briefId}')`);

    const gen = await db.query<{ generate_recruitment_ad: { generation_id: string; render_id: string; job_id: string } }>(
      `select generate_recruitment_ad('${briefId}', 'medium', '1024x1536')`,
    );
    const result = must(gen.rows[0]).generate_recruitment_ad;
    expect(result.render_id).toBeTruthy();
    expect(result.generation_id).toBeTruthy();
    expect(result.job_id).toBeTruthy();

    const job = await db.query<{ agent_key: string; render_id: string; input_table: string | null }>(`
      select agent_key, params->>'render_id' as render_id, input_table
        from agent_jobs where id = '${result.job_id}'
    `);
    expect(must(job.rows[0])).toMatchObject({
      agent_key: "creative_build",
      render_id: result.render_id,
    });

    const render = await db.query<{ generation_id: string; n: number }>(`
      select generation_id::text, (select count(*)::int from creative_renders where generation_id = '${result.generation_id}') as n
        from creative_renders where id = '${result.render_id}'
    `);
    expect(must(render.rows[0]).generation_id).toBe(result.generation_id);
    expect(must(render.rows[0]).n).toBe(1);

    const brief = await db.query<{ status: string }>(
      `select status::text as status from client_briefs where id = '${briefId}'`,
    );
    expect(must(brief.rows[0]).status).toBe("in_production");
  });

  it("will not generate until the brief is approved", async () => {
    await asUser(ADMIN);
    const created = await db.query<{ id: string }>(createSql("editor"));
    await expect(
      db.query(`select generate_recruitment_ad('${must(created.rows[0]).id}')`),
    ).rejects.toThrow(/approve the recruitment brief/i);
  });
});
