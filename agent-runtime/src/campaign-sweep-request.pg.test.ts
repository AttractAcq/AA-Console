import { PGlite } from "@electric-sql/pglite";
import { readFile } from "node:fs/promises";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

/**
 * Migration 310 against a real Postgres.
 *
 * The sweep's engine already existed, so 310 adds a kind, a way to ask for a
 * sweep, and a re-check. The regression worth pinning hardest is the kind:
 * `workflow_runs_kind_check` lists the permitted kinds AND `create_workflow_run`
 * repeats that list in its own body, so changing only the constraint would
 * leave the function refusing every sweep with "Unknown workflow kind" --
 * a half-change that looks applied and is not.
 *
 * The rest is the gate. A sweep is the moment a plan becomes work, so 309's
 * refusals apply to it, and they are re-checked at compose time because 309
 * deliberately makes a plan correctable.
 */
let db: PGlite;

const CLIENT = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const PERSON = "55555555-5555-4555-8555-555555555555";

const sql = (file: string) =>
  readFile(new URL(`../../supabase/migrations/${file}`, import.meta.url), "utf8");

async function rows<T = Record<string, unknown>>(q: string, p: unknown[] = []): Promise<T[]> {
  return (await db.query<T>(q, p)).rows;
}
async function one<T = Record<string, unknown>>(q: string, p: unknown[] = []): Promise<T> {
  return (await rows<T>(q, p))[0]!;
}

const C = (n: number) => `777777${String(n).padStart(2, "0")}-7777-4777-8777-777777777777`;

/** A planned, approved campaign, as 309 leaves one ready to sweep. */
async function approved(id: string, over: Record<string, unknown> = {}) {
  await db.query(
    `insert into client_campaigns
       (id, client_id, name, acquisition_mode, runs_organic, content_count,
        organic_content_count, objective, channels, built_at)
     values ($1, $2, 'A campaign', 'organic', true, $3, $3,
             'Fill the winter diary', array['instagram'], now())`,
    [id, over.client_id ?? CLIENT, over.content_count ?? 4],
  );
  await db.query(`select approve_campaign_plan_v6($1)`, [id]);
}

beforeEach(async () => {
  await db?.close();
  db = new PGlite();

  await db.exec(`
 create schema if not exists auth;
 create role authenticated; create role anon; create role service_role;

 create table auth.users(id uuid primary key);
 create table profiles(id uuid primary key references auth.users(id) on delete cascade);
 create table clients(id uuid primary key);
 create table client_campaigns(
   id uuid primary key default gen_random_uuid(),
   client_id uuid not null references clients(id) on delete cascade,
   name text not null,
   acquisition_mode text not null default 'legacy',
   paid_platform text,
   runs_organic boolean not null default false,
   runs_paid boolean not null default false,
   content_count integer not null default 0,
   objective text, audience text, offer_summary text, core_message text,
   channels text[], budget numeric, starts_on date, ends_on date,
   kpi_metric text, kpi_target numeric,
   needs_landing_page boolean not null default false,
   needs_sales_agent boolean not null default false,
   offer_version_id uuid,
   built_at timestamptz,
   updated_at timestamptz not null default now());
 create table client_pages(id uuid primary key default gen_random_uuid(),
   client_id uuid not null, page_type text, title text, brief text, status text);
 create table client_sales_agents(id uuid primary key default gen_random_uuid(),
   client_id uuid not null, page_id uuid, name text, purpose text);
 create table campaign_artifacts(id uuid primary key default gen_random_uuid(),
   campaign_id uuid not null, client_id uuid not null, kind text,
   page_id uuid, sales_agent_id uuid);
 create table agent_jobs(
   id uuid primary key default gen_random_uuid(),
   agent_key text not null, client_id uuid, input_table text, input_id uuid,
   status text not null default 'queued', params jsonb not null default '{}',
   note text, created_by uuid);
 create table agents(
   id uuid primary key default gen_random_uuid(),
   agent_key text not null unique, name text not null, initials text not null,
   domain text, description text,
   requires_upstream text[] not null default '{}',
   config jsonb not null default '{}', paused boolean not null default false,
   created_at timestamptz not null default now(),
   updated_at timestamptz not null default now(),
   archived_at timestamptz, scheduled_only boolean not null default false,
   requires_input boolean not null default false);

 -- Enough of workflow_runs to exercise create_workflow_run's kind list.
 create table workflow_runs(
   id uuid primary key default gen_random_uuid(),
   client_id uuid not null references clients(id) on delete cascade,
   campaign_id uuid references client_campaigns(id) on delete set null,
   kind text not null,
   workflow_version text not null,
   idempotency_key text not null,
   root_request_id text,
   input_snapshot jsonb not null,
   deadline_at timestamptz not null,
   created_by uuid,
   status text not null default 'pending',
   sealed_at timestamptz,
   created_at timestamptz not null default now(),
   constraint workflow_runs_kind_check check (
     kind = any (array['daily_content_package', 'client_launch_package'])),
   unique (client_id, kind, idempotency_key));

 create function auth.role() returns text language sql stable as $a$
   select coalesce(nullif(current_setting('test.role', true), ''), 'authenticated') $a$;
 create function auth.uid() returns uuid language sql stable as $a$
   select '${PERSON}'::uuid $a$;
 create function current_role_of() returns text language sql stable as $a$
   select 'admin'::text $a$;
 create function can_access_client(p uuid) returns boolean language sql stable as $a$
   select p = '${CLIENT}'::uuid $a$;
 create function lock_down_definer_functions() returns void language plpgsql as $a$
   begin return; end $a$;
 create function enqueue_agent_job_internal(
   p_agent_key text, p_client_id uuid, p_input_table text, p_input_id uuid,
   p_created_by uuid, p_params jsonb default '{}', p_note text default null)
   returns uuid language plpgsql as $a$
 declare v uuid;
 begin
   insert into agent_jobs(agent_key, client_id, input_table, input_id, created_by, params, note)
   values (p_agent_key, p_client_id, p_input_table, p_input_id, p_created_by, p_params, p_note)
   returning id into v;
   return v;
 end $a$;
 create function provision_campaign(p_campaign_id uuid)
   returns table (created text, artifact_id uuid)
   language plpgsql volatile security definer set search_path = public
   as $a$ begin return; end $a$;
 -- create_workflow_run as migration 190 really declares it, character for
 -- character in the header: the three defaults and the search_path included,
 -- with the old kind list in its own body.
 --
 -- This matters more than it looks. The first version of this scaffold declared
 -- it WITHOUT the defaults, and so did 310's replacement -- so the replace
 -- succeeded here and failed on a real database with "cannot remove parameter
 -- defaults from existing function". A scaffold that is merely plausible proves
 -- the migration against itself. Copy the real declaration.
 create function create_workflow_run(
   p_client_id uuid, p_kind text, p_workflow_version text, p_idempotency_key text,
   p_input_snapshot jsonb, p_deadline_at timestamptz,
   p_campaign_id uuid default null, p_root_request_id text default null,
   p_created_by uuid default null) returns workflow_runs
   language plpgsql security definer set search_path to 'public'
 as $a$
 declare v_run workflow_runs;
 begin
   if auth.role() <> 'service_role' then raise exception 'AUTH: service role required'; end if;
   if p_kind not in ('daily_content_package', 'client_launch_package') then
     raise exception 'Unknown workflow kind.';
   end if;
   insert into workflow_runs(client_id, campaign_id, kind, workflow_version,
     idempotency_key, root_request_id, input_snapshot, deadline_at, created_by)
   values (p_client_id, p_campaign_id, p_kind, p_workflow_version, p_idempotency_key,
     p_root_request_id, p_input_snapshot, p_deadline_at, p_created_by)
   returning * into v_run;
   return v_run;
 end $a$;

 insert into auth.users(id) values ('${PERSON}');
 insert into profiles(id) values ('${PERSON}');
 insert into clients(id) values ('${CLIENT}'), ('${OTHER}');
 insert into agents(agent_key, name, initials) values ('campaign_plan','Planner','CP');
 `);

  await db.exec(await sql("20261105000000_308_a_both_campaign_plans_each_route_s_volume.sql"));
  await db.exec(await sql("20261105010000_309_a_plan_is_reviewed_before_the_agents_run.sql"));
  await db.exec(await sql("20261105020000_310_the_campaign_sweep_is_a_workflow_kind.sql"));
});

afterAll(async () => {
  await db?.close();
});

const request = (id: string) => db.query(`select request_campaign_sweep_v6($1)`, [id]);

describe("the kind, in both places that list it", () => {
  it("lets the constraint accept a campaign sweep without losing the old kinds", async () => {
    for (const kind of ["daily_content_package", "client_launch_package", "campaign_sweep"]) {
      await db.query(
        `insert into workflow_runs (client_id, kind, workflow_version, idempotency_key,
                                    input_snapshot, deadline_at)
         values ($1, $2, 'v1', $2, '{}'::jsonb, now() + interval '1 day')`,
        [CLIENT, kind],
      );
    }
    expect(await one(`select count(*)::int as n from workflow_runs`)).toMatchObject({ n: 3 });
    await expect(db.query(
      `insert into workflow_runs (client_id, kind, workflow_version, idempotency_key,
                                  input_snapshot, deadline_at)
       values ($1, 'something_else', 'v1', 'k', '{}'::jsonb, now() + interval '1 day')`,
      [CLIENT],
    )).rejects.toThrow(/workflow_runs_kind_check/);
  });

  it("lets create_workflow_run accept it too, which the constraint alone would not", async () => {
    // The regression: the function repeats the kind list in its own body, so
    // a migration that changed only the constraint would leave every sweep
    // refused with "Unknown workflow kind".
    await db.exec(`set test.role = 'service_role'`);
    const run = await one<{ kind: string }>(
      `select kind from create_workflow_run($1, 'campaign_sweep', 'v6.sweep.1', 'k1',
         '{}'::jsonb, now() + interval '3 days', null, null, null)`,
      [CLIENT],
    );
    expect(run.kind).toBe("campaign_sweep");
    await expect(db.query(
      `select create_workflow_run($1, 'nonsense', 'v1', 'k2', '{}'::jsonb,
         now() + interval '1 day', null, null, null)`, [CLIENT],
    )).rejects.toThrow(/Unknown workflow kind/);
  });
});

describe("asking for a sweep", () => {
  it("queues one for an approved plan", async () => {
    await approved(C(1));
    await request(C(1));
    expect(await one(`select agent_key, input_table, input_id, note from agent_jobs`))
      .toMatchObject({
        agent_key: "campaign_sweep", input_table: "client_campaigns",
        input_id: C(1), note: "Queued: sweep A campaign into work",
      });
  });

  it("refuses a second while one is running", async () => {
    await approved(C(2));
    await request(C(2));
    await expect(request(C(2))).rejects.toThrow(/already queued or running/);
  });

  it("refuses an unreviewed plan, because a sweep is when a plan becomes work", async () => {
    await db.query(
      `insert into client_campaigns (id, client_id, name, acquisition_mode, runs_organic,
                                     content_count, organic_content_count, built_at)
       values ($1, $2, 'Unapproved', 'organic', true, 4, 4, now())`,
      [C(3), CLIENT],
    );
    await expect(request(C(3))).rejects.toThrow(/has not been reviewed/);
  });

  it("refuses a plan corrected after approval", async () => {
    await approved(C(4));
    await db.query(`update client_campaigns set objective = 'Something else' where id = $1`, [C(4)]);
    await expect(request(C(4))).rejects.toThrow(/changed after it was approved/);
  });

  it("refuses a plan that asks for no content", async () => {
    await approved(C(5), { content_count: 0 });
    await expect(request(C(5))).rejects.toThrow(/no content/);
  });

  it("refuses a client the caller cannot reach, before it looks at the plan", async () => {
    // Unapproved on purpose: the permission check comes first, so a caller
    // learns nothing about another client's campaign from the refusal.
    await db.query(
      `insert into client_campaigns (id, client_id, name, acquisition_mode, runs_organic,
                                     content_count, organic_content_count, built_at)
       values ($1, $2, 'Not yours', 'organic', true, 4, 4, now())`,
      [C(6), OTHER],
    );
    await expect(request(C(6))).rejects.toThrow(/Not permitted for this client/);
  });
});

describe("re-checking at compose time", () => {
  it("passes a plan that is still approved", async () => {
    await approved(C(7));
    expect(await one(`select campaign_sweep_blocker_v6($1) as blocker`, [C(7)]))
      .toMatchObject({ blocker: null });
  });

  it("names the reason when the approval was withdrawn by a correction", async () => {
    // 309 makes a plan correctable, so the approval this sweep was asked for
    // may be minutes stale by the time the runtime composes it.
    await approved(C(8));
    await db.query(`update client_campaigns set kpi_target = 99 where id = $1`, [C(8)]);
    expect(await one<{ blocker: string }>(`select campaign_sweep_blocker_v6($1) as blocker`, [C(8)]))
      .toMatchObject({ blocker: expect.stringContaining("changed after it was approved") });
  });

  it("names the reason for a campaign that has gone", async () => {
    expect(await one<{ blocker: string }>(
      `select campaign_sweep_blocker_v6($1) as blocker`, [C(9)],
    )).toMatchObject({ blocker: "That campaign no longer exists." });
  });
});
