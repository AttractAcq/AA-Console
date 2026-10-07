import { PGlite } from "@electric-sql/pglite";
import { readFile } from "node:fs/promises";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

/**
 * Migration 161 against a real Postgres.
 *
 * The bug it fixes is not in any one migration. Supabase grants EXECUTE on
 * every new function in `public` to anon, authenticated and service_role,
 * and `revoke all on function x from public` — which several migrations here
 * do while describing the function as service_role only — revokes from the
 * PUBLIC pseudo-role and leaves those three grants untouched.
 *
 * So the harness below does what Supabase does: it grants EXECUTE on
 * everything to anon before replaying 161, and then asserts that nothing
 * SECURITY DEFINER is left anon-callable. Without that grant the test would
 * pass on an empty set and prove nothing, which is the trap this whole file
 * is about.
 */
let db: PGlite;

const migration = (file: string) =>
  readFile(new URL(`../../supabase/migrations/${file}`, import.meta.url), "utf8");

const CLIENT = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const PILLAR = "33333333-3333-4333-8333-333333333333";
const ADMIN = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const STAFF = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

async function one<T = Record<string, unknown>>(sql: string): Promise<T> {
  return (await db.query<T>(sql)).rows[0]!;
}
async function rows<T = Record<string, unknown>>(sql: string): Promise<T[]> {
  return (await db.query<T>(sql)).rows;
}

/** Run as a given JWT role, then put the session back. */
async function as<T = Record<string, unknown>>(
  role: string,
  sub: string,
  sql: string,
): Promise<T[]> {
  await db.exec(`select set_config('request.jwt.claim.role','${role}',false);
                 select set_config('request.jwt.claim.sub','${sub}',false);`);
  try {
    return (await db.query<T>(sql)).rows;
  } finally {
    await db.exec(`select set_config('request.jwt.claim.role','authenticated',false);
                   select set_config('request.jwt.claim.sub','${ADMIN}',false);`);
  }
}

async function slotAt(stage: string, client = CLIENT): Promise<string> {
  const { id: asset } = await one<{ id: string }>(
    `insert into client_media_assets (client_id, title) values ('${client}','Built') returning id`,
  );
  const { id: slot } = await one<{ id: string }>(
    `select id from create_content_slot('${client}','instagram', now() + interval '2 days')`,
  );
  const walk = [
    "ideating",
    "idea_selected",
    "briefing",
    "building",
    "copywriting",
    "qa",
    "awaiting_approval",
  ];
  for (const next of walk) {
    if (next === "copywriting") {
      await db.exec(
        `select advance_slot('${slot}','copywriting'::slot_stage,'agent',null,null,null,null,null,null,'${asset}')`,
      );
    } else {
      await db.exec(`select advance_slot('${slot}','${next}'::slot_stage,'engine')`);
    }
    if (next === stage) break;
  }
  return slot;
}

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    create role anon; create role authenticated; create role service_role;
    create schema auth; create schema cron; create schema mcp_internal;
    create table auth.users (id uuid primary key);
    create function auth.uid() returns uuid language sql stable as
      $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    create function auth.role() returns text language sql stable as
      $$ select nullif(current_setting('request.jwt.claim.role', true), '') $$;
    create table cron.job (jobid bigserial primary key, jobname text, schedule text, command text);
    create function cron.schedule(a text,b text,c text) returns bigint language sql as
      $$ insert into cron.job (jobname,schedule,command) values (a,b,c) returning jobid $$;
    create function cron.unschedule(a text) returns boolean language sql as
      $$ delete from cron.job where jobname=a returning true $$;

    create type post_platform as enum ('facebook','instagram','tiktok','linkedin','youtube');
    create type post_channel as enum ('organic','paid');
    create type content_format as enum ('single','carousel','story','reel');
    create type media_type as enum ('image','text','video');
    create type review_status as enum ('pending','approved','rejected');

    create table clients (id uuid primary key, name text, timezone text not null default 'Europe/London');
    create table profiles (id uuid primary key, role text);
    create table client_members (client_id uuid, user_id uuid);
    create function is_admin() returns boolean language sql stable security definer as
      $$ select exists (select 1 from profiles where id = auth.uid() and role='admin') $$;
    create function can_access_client(p uuid) returns boolean language sql stable security definer as
      $$ select is_admin() or exists (select 1 from client_members m
            where m.client_id=p and m.user_id=auth.uid()) $$;
    create function client_timezone(p uuid) returns text language sql stable security definer as
      $$ select coalesce((select timezone from clients where id=p),'Europe/London') $$;
    -- Stubs for the two functions 161 pins a search_path onto. The real ones
    -- live in 144 and the MCP migrations; what matters here is that 161 can
    -- replace them and that the pin lands.
    create function default_post_time() returns time without time zone language sql immutable
      as $$ select time '09:00' $$;
    create function mcp_internal.clip_text(p text, p_max integer default 8000) returns text
      language sql immutable as $$ select left(p, p_max) $$;

    create table client_content_pillars (id uuid primary key default gen_random_uuid(),
      client_id uuid, name text, target_share int default 100, active boolean default true);
    create table client_engine_budgets (client_id uuid, month date, cap_usd numeric,
      primary key (client_id, month));
    create table client_proof_assets (id uuid primary key default gen_random_uuid(), client_id uuid);
    create table client_ideas (id uuid primary key default gen_random_uuid(), client_id uuid, slot_id uuid,
      title text, body text, source_question text, strategic_reason text, content_territory text,
      status text default 'draft', archived_at timestamptz, created_at timestamptz default now());
    create table client_briefs (id uuid primary key default gen_random_uuid());
    create table client_media_assets (id uuid primary key default gen_random_uuid(),
      client_id uuid, title text, storage_path text, render_path text,
      review_status review_status not null default 'pending', human_approved_at timestamptz);
    create table client_asset_reviews (id uuid primary key default gen_random_uuid(),
      asset_id uuid, decision review_status, reason text, reviewed_by uuid,
      created_at timestamptz default now());
    create table scheduled_posts (id uuid primary key default gen_random_uuid(),
      client_id uuid references clients(id), asset_id uuid references client_media_assets(id) on delete set null,
      ref_number text, scheduled_for date, scheduled_at timestamptz,
      channel post_channel not null default 'organic', media_type media_type not null default 'image',
      platform post_platform, notes text, published_at timestamptz, external_id text,
      created_by uuid, created_by_bot text, published_by_bot text, failure_reason text,
      publication_status text not null default 'scheduled'
        check (publication_status in ('scheduled','published','failed')),
      created_at timestamptz not null default now(), updated_at timestamptz not null default now());
    create table client_integrations (id uuid primary key default gen_random_uuid(),
      client_id uuid, provider text, credential_secret_id uuid, status text not null default 'connected',
      unique (client_id, provider));
    create function integration_secret(p_client_id uuid, p_provider text) returns text
      language sql stable security definer as $$ select 'token'::text $$;
    create function review_media_asset(p_asset_id uuid, p_decision review_status, p_reason text default null)
      returns void language plpgsql security definer set search_path to 'public' as $$
      begin
        update client_media_assets
           set review_status = p_decision,
               human_approved_at = case when p_decision='approved' then now() else null end
         where id = p_asset_id;
        insert into client_asset_reviews (asset_id, decision, reason, reviewed_by)
        values (p_asset_id, p_decision, p_reason, auth.uid());
      end; $$;

    create table agents (agent_key text primary key, name text, initials text, domain text,
      description text, requires_upstream text[], requires_input boolean default false,
      paused boolean not null default false, archived_at timestamptz);
    insert into agents (agent_key) values ('ideation'),('brief'),('creative_build'),('video_build');
    create table agent_jobs (id uuid primary key default gen_random_uuid(),
      agent_key text references agents(agent_key), client_id uuid, input_table text, input_id uuid,
      created_by uuid, params jsonb default '{}'::jsonb, status text default 'queued',
      cost_usd numeric default 0, created_at timestamptz default clock_timestamp());
    create table agent_job_events (id uuid primary key default gen_random_uuid(),
      job_id uuid, description text, payload jsonb);
    create function can_run_agent(a text,c uuid) returns boolean language sql stable as $$ select true $$;
    create function enqueue_agent_job_internal(p_agent_key text,p_client_id uuid,p_input_table text,
      p_input_id uuid,p_actor uuid,p_params jsonb default '{}'::jsonb,p_description text default 'q')
      returns uuid language plpgsql security definer set search_path to 'public' as $$
      declare v uuid; begin
        insert into agent_jobs (agent_key,client_id,input_table,input_id,created_by,params)
        values (p_agent_key,p_client_id,p_input_table,p_input_id,p_actor,p_params) returning id into v;
        return v; end; $$;
    create function agent_spend_for_client(c uuid,m date) returns numeric language sql stable as
      $$ select 0::numeric $$;
    create view content_archive as select client_id, title, title as idea_title
      from client_media_assets where false;

    insert into auth.users (id) values ('${ADMIN}'), ('${STAFF}');
    insert into profiles (id, role) values ('${ADMIN}','admin'), ('${STAFF}','staff');
    insert into clients (id, name) values ('${CLIENT}','Harbour'), ('${OTHER}','Beacon');
    insert into client_members (client_id, user_id) values ('${OTHER}','${STAFF}');
    insert into client_content_pillars (id, client_id, name) values ('${PILLAR}','${CLIENT}','Proof');
  `);

  for (const f of [
    "20261005210000_146_engine_settings.sql",
    "20261005230000_147_content_slots.sql",
    "20261005190000_145_post_copy.sql",
    "20261006020000_149_plan_slots.sql",
    "20261006040000_150_engine_tick.sql",
    "20261006060000_151_ideas_know_their_slot.sql",
    "20261006080000_152_idea_selection_and_policy.sql",
    "20261006140000_155_tick_queues_the_right_input.sql",
    "20261006200000_158_qa.sql",
    "20261006220000_159_approval_inbox.sql",
    "20261006240000_160_publishing.sql",
  ]) {
    await db.exec(await migration(f));
  }

  // What Supabase's default privileges do, and what every migration in this
  // repo was quietly relying on not being true. Without this line the
  // assertions below would pass on an empty set.
  await db.exec(`grant execute on all functions in schema public to anon, authenticated;
                 grant execute on all functions in schema mcp_internal to anon, authenticated;`);

  await db.exec(await migration("20261007090000_161_anon_cannot_drive_the_engine.sql"));

  // Supabase's defaults apply at CREATE time, so the two functions 161
  // itself created got them — and only those two. Granting the whole schema
  // again here would undo 161's own revokes on functions that existed
  // before it, which is not what happens in production.
  await db.exec(`grant execute on function public.lock_down_definer_functions() to anon, authenticated;
                 grant execute on function public.may_advance_slot(uuid) to anon, authenticated;`);

  await db.exec(await migration("20261007100000_162_three_the_sweep_could_not_fix.sql"));

  await db.exec(`select set_config('request.jwt.claim.role','authenticated',false);
                 select set_config('request.jwt.claim.sub','${ADMIN}',false);`);
});

beforeEach(async () => {
  await db.exec(`delete from post_copy; delete from scheduled_posts; delete from client_asset_reviews;
                 delete from content_slots; delete from client_media_assets; delete from client_ideas;
                 delete from client_integrations; delete from client_engine_settings;`);
  await db.exec(`select set_config('request.jwt.claim.role','authenticated',false);
                 select set_config('request.jwt.claim.sub','${ADMIN}',false);`);
  await db.exec(`select set_engine_settings('${CLIENT}', 14, true)`);
});

describe("anon holds the key that ships in the browser", () => {
  it("can execute no SECURITY DEFINER function at all", async () => {
    const left = await rows<{ schema: string; function: string }>(
      `select schema, "function" from security_definer_exposure where anon_can_execute`,
    );
    expect(left).toEqual([]);
  });

  it("is reported by the view the migration adds, not only by a lint", async () => {
    // The whole exposure is a query somebody can run against any
    // environment, rather than a dashboard page somebody has to remember.
    const { count } = await one<{ count: number }>(
      `select count(*)::int as count from security_definer_exposure`,
    );
    expect(count).toBeGreaterThan(0);
    const { ungated } = await one<{ ungated: number }>(
      `select count(*)::int as ungated from security_definer_exposure
        where not body_checks_the_caller and anon_can_execute`,
    );
    expect(ungated).toBe(0);
  });

  it("has nothing left to sweep straight after the migration", async () => {
    // The sweep is idempotent, and a non-zero count here would mean 161 had
    // left something behind.
    const swept = await as("service_role", "", `select lock_down_definer_functions() as n`);
    expect((swept[0] as { n: number }).n).toBe(0);
  });

  it("gets it back on the next function somebody writes, which is why the sweep is a function", async () => {
    // ALTER DEFAULT PRIVILEGES cannot stop this: revoking the implicit
    // EXECUTE-to-PUBLIC default is a revoke of nothing, and Postgres records
    // no default ACL for it. Checked against the real project as well as
    // here. So a new function arrives public, and the mechanism has to be
    // something a migration can run again.
    await db.exec(`create or replace function public.written_later() returns int
                   language sql security definer set search_path to 'public' as $$ select 1 $$;`);
    const before = await one<{ anon: boolean; pub: boolean }>(
      `select has_function_privilege('anon', 'public.written_later()', 'execute') as anon,
              has_function_privilege('public', 'public.written_later()', 'execute') as pub`,
    );
    expect(before.pub).toBe(true);

    const swept = await as("service_role", "", `select lock_down_definer_functions() as n`);
    expect((swept[0] as { n: number }).n).toBeGreaterThan(0);

    const after = await one<{ anon: boolean; pub: boolean }>(
      `select has_function_privilege('anon', 'public.written_later()', 'execute') as anon,
              has_function_privilege('public', 'public.written_later()', 'execute') as pub`,
    );
    expect(after.anon).toBe(false);
    expect(after.pub).toBe(false);
  });

});

describe("advance_slot, which had no permission check of any kind", () => {
  it("refuses a signed-in user of another client", async () => {
    // The hole this migration exists for. A slot id was the whole
    // credential, and the id of a slot is in every job event and every
    // engine view.
    const slot = await slotAt("qa");
    await expect(
      as(
        "authenticated",
        STAFF,
        `select advance_slot('${slot}','awaiting_approval'::slot_stage,'human')`,
      ),
    ).rejects.toThrow(/Not permitted for this client/);
  });

  it("will not move a slot out of awaiting_approval for an outsider", async () => {
    // awaiting_approval is the one human gate the engine stops at. Moving a
    // slot out of it is the single act this database exists to require a
    // person for.
    const slot = await slotAt("awaiting_approval");
    await expect(
      as("authenticated", STAFF, `select advance_slot('${slot}','scheduled'::slot_stage,'human')`),
    ).rejects.toThrow(/Not permitted for this client/);
    const { stage } = await one<{ stage: string }>(
      `select stage from content_slots where id = '${slot}'`,
    );
    expect(stage).toBe("awaiting_approval");
  });

  it("lets a person who can reach the client move it", async () => {
    const slot = await slotAt("qa");
    await db.exec(`select advance_slot('${slot}','awaiting_approval'::slot_stage,'human')`);
    const { stage } = await one<{ stage: string }>(
      `select stage from content_slots where id = '${slot}'`,
    );
    expect(stage).toBe("awaiting_approval");
  });

  it("lets the engine move it", async () => {
    const slot = await slotAt("qa");
    await as(
      "service_role",
      "",
      `select record_qa_result('${slot}', 100, '[]'::jsonb, 'awaiting_approval'::slot_stage)`,
    );
    const { stage } = await one<{ stage: string }>(
      `select stage from content_slots where id = '${slot}'`,
    );
    expect(stage).toBe("awaiting_approval");
  });

  it("lets the database's own cron move it, which has no JWT at all", async () => {
    // pg_cron runs engine_tick as the superuser with no request.jwt.*
    // settings, so auth.role() is null rather than a role name. Reaching
    // this with no JWT means already being inside the database, which is a
    // strictly larger privilege than this function.
    const slot = await slotAt("qa");
    await db.exec(`select set_config('request.jwt.claim.role','',false);
                   select set_config('request.jwt.claim.sub','',false);`);
    await db.exec(`select advance_slot('${slot}','awaiting_approval'::slot_stage,'engine')`);
    await db.exec(`select set_config('request.jwt.claim.role','authenticated',false);
                   select set_config('request.jwt.claim.sub','${ADMIN}',false);`);
    const { stage } = await one<{ stage: string }>(
      `select stage from content_slots where id = '${slot}'`,
    );
    expect(stage).toBe("awaiting_approval");
  });

  it("still refuses an illegal move for somebody who is allowed", async () => {
    // The new check is in addition to the transition rules, not instead of.
    const slot = await slotAt("qa");
    await expect(
      db.exec(`select advance_slot('${slot}','published'::slot_stage,'human')`),
    ).rejects.toThrow(/cannot go from qa to published/);
  });

  it("still refuses a direct update to the stage column", async () => {
    const slot = await slotAt("qa");
    await expect(
      db.exec(`update content_slots set stage = 'published' where id = '${slot}'`),
    ).rejects.toThrow(/through advance_slot/);
  });
});

describe("the engine's own drivers", () => {
  it("are not callable by a signed-in user, because they spend money", async () => {
    // Asked of pg directly rather than through the view: a function that is
    // service_role-only is absent from the view entirely, and "no row" is
    // the same answer as "false" only if you remember that it is.
    const reachable = await rows<{ proname: string }>(
      `select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public'
          and p.proname in ('engine_tick','plan_slots','select_idea_for_slot','reap_stale_publish_claims')
          and (has_function_privilege('authenticated', p.oid, 'execute')
               or has_function_privilege('anon', p.oid, 'execute'))`,
    );
    expect(reachable).toEqual([]);
  });

  it("are still callable by the engine", async () => {
    const engine = await rows<{ proname: string }>(
      `select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public'
          and p.proname in ('engine_tick','plan_slots','select_idea_for_slot','reap_stale_publish_claims')
          and has_function_privilege('service_role', p.oid, 'execute')
        order by p.proname`,
    );
    expect(engine.map((r) => r.proname)).toEqual([
      "engine_tick",
      "plan_slots",
      "reap_stale_publish_claims",
      "select_idea_for_slot",
    ]);
  });
});

describe("the rest of the lint", () => {
  it("pins the search_path on the two functions that had none", async () => {
    const pinned = await rows<{ proname: string }>(
      `select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where p.proname in ('default_post_time','clip_text')
          and 'search_path=public' = any (p.proconfig)`,
    );
    expect(pinned.map((r) => r.proname).sort()).toEqual(["clip_text", "default_post_time"]);
  });

  it("gives slot_pipeline the read policy it never had", async () => {
    // RLS was on with no policy, so it was readable by nobody. The tick
    // reads it as service_role and never noticed.
    const { count } = await one<{ count: number }>(
      `select count(*)::int as count from pg_policies
        where tablename = 'slot_pipeline' and cmd = 'SELECT'`,
    );
    expect(count).toBe(1);
  });
});

describe("the three the sweep could not fix", () => {
  it("will not let a signed-in person plan another client's month", async () => {
    // No check at all before this: anybody signed in could create slots
    // against any client_id — rows they cannot even read back — and the
    // tick would pick them up and spend that client's budget.
    await expect(
      as(
        "authenticated",
        STAFF,
        `select create_content_slot('${CLIENT}','instagram', now() + interval '5 days')`,
      ),
    ).rejects.toThrow(/Not permitted for this client/);
  });

  it("still plans for a client the caller can reach", async () => {
    const planned = await as<{ id: string }>(
      "authenticated",
      STAFF,
      `select id from create_content_slot('${OTHER}','instagram', now() + interval '5 days')`,
    );
    expect(planned[0]!.id).toBeTruthy();
  });

  it("still plans for the engine", async () => {
    const planned = await as<{ id: string }>(
      "service_role",
      "",
      `select id from create_content_slot('${CLIENT}','facebook', now() + interval '6 days')`,
    );
    expect(planned[0]!.id).toBeTruthy();
  });

  it("is still idempotent, which is what the planner leans on", async () => {
    // A literal instant, not now(): the index is on the exact timestamp, so
    // two calls a microsecond apart are two different windows and the test
    // would be measuring the clock rather than the function.
    const when = "timestamptz '2026-12-01 09:00:00+00'";
    const a = await one<{ id: string }>(`select id from create_content_slot('${CLIENT}','instagram', ${when})`);
    const b = await one<{ id: string }>(`select id from create_content_slot('${CLIENT}','instagram', ${when})`);
    expect(b.id).toBe(a.id);
  });

  it("will not say whether somebody else's account is connected", async () => {
    // Not a token and not a number, but it is somebody else's business, and
    // it was answerable one call at a time for every client in turn.
    await db.exec(`insert into client_integrations (client_id, provider, credential_secret_id, status)
                   values ('${CLIENT}','instagram','55555555-5555-4555-8555-555555555555','connected')`);
    const mine = await one<{ u: boolean }>(`select integration_usable('${CLIENT}','instagram') as u`);
    expect(mine.u).toBe(true);

    const theirs = await as<{ u: boolean | null }>(
      "authenticated",
      STAFF,
      `select integration_usable('${CLIENT}','instagram') as u`,
    );
    // Null, not false: "no" is also an answer about somebody else's account.
    expect(theirs[0]!.u).toBeNull();
  });

  it("still blocks a post whose client has no integration at all", async () => {
    // The null branch itself is unreachable through this view today —
    // scheduled_posts' RLS means a reader who cannot reach the client never
    // sees the row — so what is pinned here is that making the call
    // nullable did not break the ordinary answer.
    const { id: asset } = await one<{ id: string }>(
      `insert into client_media_assets (client_id, title, storage_path, human_approved_at, review_status)
       values ('${CLIENT}','Built','a.mp4', now(), 'approved') returning id`,
    );
    const { id: post } = await one<{ id: string }>(
      `insert into scheduled_posts (client_id, asset_id, scheduled_for, scheduled_at, platform, media_type)
       values ('${CLIENT}','${asset}', current_date, now() - interval '1 hour','instagram','video') returning id`,
    );
    await db.exec(`insert into post_copy (scheduled_post_id, platform, caption, source)
                   values ('${post}','instagram','Words.','agent');
                   select set_publishing_enabled('${CLIENT}', true);
                   delete from client_integrations where client_id = '${CLIENT}';`);

    const blocker = await one<{ blocker: string | null }>(
      `select blocker from publish_due where post_id = '${post}'`,
    );
    expect(blocker.blocker).toMatch(/No usable instagram integration/);
  });

  it("does not leave the privilege primitive callable by a signed-in person", async () => {
    const { can } = await one<{ can: boolean }>(
      `select has_function_privilege('authenticated', 'public.lock_down_definer_functions()', 'execute') as can`,
    );
    expect(can).toBe(false);
  });
});
