import { PGlite } from "@electric-sql/pglite";
import { readFile } from "node:fs/promises";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

/**
 * Migration 309 against a real Postgres.
 *
 * provision_campaign is the moment the notes mean by "before the agent runs":
 * it writes a landing page row, writes a sales agent row, and enqueues both
 * jobs. Before 309 it refused only when there was no plan at all -- and the
 * plan it ran from was approved by nobody, because save_campaign_plan_* sets
 * built_at itself.
 *
 * The property worth pinning hardest is that the approval NAMES THE PLAN. A
 * bare flag would not be a gate: the notes ask for a plan that is correctable,
 * and a corrected plan must not provision on a decision made about different
 * text. So most of these cases are about the fingerprint.
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

const C = (n: number) => `666666${String(n).padStart(2, "0")}-6666-4666-8666-666666666666`;

/** A planned campaign: built_at set, as save_campaign_plan_* leaves it. */
async function planned(id: string, over: Record<string, unknown> = {}) {
  const needsPage = over.needs_landing_page ?? true;
  await db.query(
    `insert into client_campaigns
       (id, client_id, name, acquisition_mode, runs_organic, content_count,
        organic_content_count, objective, built_at, needs_landing_page)
     values ($1, $2, 'A campaign', 'organic', true, 4, 4, $3, now(), $4)`,
    [id, CLIENT, over.objective ?? "Fill the winter diary", needsPage],
  );
}

const asPerson = () => db.exec(`set test.role = 'authenticated'`);
const asRuntime = () => db.exec(`set test.role = 'service_role'`);

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
 create table client_pages(
   id uuid primary key default gen_random_uuid(),
   client_id uuid not null, page_type text, title text, brief text, status text);
 create table client_sales_agents(
   id uuid primary key default gen_random_uuid(),
   client_id uuid not null, page_id uuid, name text, purpose text);
 create table campaign_artifacts(
   id uuid primary key default gen_random_uuid(),
   campaign_id uuid not null, client_id uuid not null, kind text,
   page_id uuid, sales_agent_id uuid);
 create table agent_jobs(
   id uuid primary key default gen_random_uuid(),
   agent_key text not null, client_id uuid, input_table text, input_id uuid,
   created_by uuid);

 create function auth.role() returns text language sql stable as $a$
   select coalesce(nullif(current_setting('test.role', true), ''), 'authenticated') $a$;
 create function auth.uid() returns uuid language sql stable as $a$
   select '${PERSON}'::uuid $a$;
 create function can_access_client(p uuid) returns boolean language sql stable as $a$
   select p = '${CLIENT}'::uuid $a$;
 create function lock_down_definer_functions() returns void language plpgsql as $a$
   begin return; end $a$;
 create function enqueue_agent_job_internal(
   p_agent_key text, p_client_id uuid, p_input_table text, p_input_id uuid,
   p_created_by uuid) returns uuid language plpgsql as $a$
 declare v uuid;
 begin
   insert into agent_jobs(agent_key, client_id, input_table, input_id, created_by)
   values (p_agent_key, p_client_id, p_input_table, p_input_id, p_created_by)
   returning id into v;
   return v;
 end $a$;

 -- provision_campaign as it was before 309: refuses only a missing plan.
 create function provision_campaign(p_campaign_id uuid)
 returns table (created text, artifact_id uuid)
 language plpgsql volatile security definer
 set search_path = public
 as $a$
 declare c client_campaigns%rowtype; v_page uuid;
 begin
   select * into c from client_campaigns where client_campaigns.id = p_campaign_id;
   if c.id is null then raise exception 'That campaign no longer exists.'; end if;
   if c.built_at is null then
     raise exception 'This campaign has no plan yet. There is nothing to build from.';
   end if;
   if c.needs_landing_page then
     insert into client_pages(client_id, page_type, title, status)
       values (c.client_id, 'landing', c.name, 'draft') returning id into v_page;
     insert into campaign_artifacts(campaign_id, client_id, kind, page_id)
       values (c.id, c.client_id, 'landing_page', v_page);
     perform enqueue_agent_job_internal('landing_page', c.client_id, 'client_pages', v_page, auth.uid());
     created := 'landing_page'; artifact_id := v_page; return next;
   end if;
   return;
 end $a$;

 insert into auth.users(id) values ('${PERSON}');
 insert into profiles(id) values ('${PERSON}');
 insert into clients(id) values ('${CLIENT}'), ('${OTHER}');
 `);

  // 308 first: 309's fingerprint reads the columns it adds.
  await db.exec(await sql("20261105000000_308_a_both_campaign_plans_each_route_s_volume.sql"));
  await db.exec(await sql("20261105010000_309_a_plan_is_reviewed_before_the_agents_run.sql"));
  asPerson();
});

afterAll(async () => {
  await db?.close();
});

const approve = (id: string, note: string | null = null) =>
  db.query(`select approve_campaign_plan_v6($1, $2)`, [id, note]);
const provision = (id: string) => db.query(`select * from provision_campaign($1)`, [id]);

describe("nothing provisions from an unreviewed plan", () => {
  it("refuses a planned campaign nobody has approved", async () => {
    await planned(C(1));
    await expect(provision(C(1))).rejects.toThrow(/has not been reviewed/);
    // And nothing was half-created on the way to refusing.
    expect(await one(`select count(*)::int as n from client_pages`)).toMatchObject({ n: 0 });
    expect(await one(`select count(*)::int as n from agent_jobs`)).toMatchObject({ n: 0 });
  });

  it("provisions once the plan is approved", async () => {
    await planned(C(2));
    await approve(C(2), "Reads right, and the budget matches what we agreed.");
    const out = await rows<{ created: string }>(`select * from provision_campaign($1)`, [C(2)]);
    expect(out.map((r) => r.created)).toEqual(["landing_page"]);
    expect(await one(`select agent_key from agent_jobs`))
      .toMatchObject({ agent_key: "landing_page" });
    expect(await one(`select plan_review_note from client_campaigns where id = $1`, [C(2)]))
      .toMatchObject({ plan_review_note: "Reads right, and the budget matches what we agreed." });
  });
});

describe("the approval names the plan it approved", () => {
  it("un-approves a plan that is corrected afterwards", async () => {
    // The notes ask for a plan that is correctable. A bare flag would let the
    // corrected plan provision on a decision made about different text.
    await planned(C(3));
    await approve(C(3));
    await db.query(
      `update client_campaigns set objective = 'Fill the spring diary instead' where id = $1`,
      [C(3)],
    );
    await expect(provision(C(3))).rejects.toThrow(/changed after it was approved/);
  });

  it("provisions again once the correction is approved", async () => {
    await planned(C(4));
    await approve(C(4));
    await db.query(`update client_campaigns set objective = 'A better objective' where id = $1`, [C(4)]);
    await approve(C(4));
    const out = await rows(`select * from provision_campaign($1)`, [C(4)]);
    expect(out).toHaveLength(1);
  });

  it("does not un-approve a plan because something downstream moved", async () => {
    // A campaign that launches, or gets an external id, has not been replanned.
    // Re-approving for that would train people to click past the gate.
    await planned(C(5));
    await approve(C(5));
    await db.query(`update client_campaigns set updated_at = now() where id = $1`, [C(5)]);
    const out = await rows(`select * from provision_campaign($1)`, [C(5)]);
    expect(out).toHaveLength(1);
  });

  it("notices a change to the route split, which is part of the plan", async () => {
    await planned(C(6));
    await approve(C(6));
    await db.query(
      `update client_campaigns set content_count = 6, organic_content_count = 6 where id = $1`,
      [C(6)],
    );
    await expect(provision(C(6))).rejects.toThrow(/changed after it was approved/);
  });
});

describe("who may approve", () => {
  it("refuses the runtime: a machine does not approve its own plan", async () => {
    await planned(C(7));
    asRuntime();
    await expect(approve(C(7))).rejects.toThrow(/Only a person with access/);
  });

  it("refuses a person with no access to the client", async () => {
    await planned(C(8));
    await db.exec(`update client_campaigns set client_id = '${OTHER}' where id = '${C(8)}'`);
    await expect(approve(C(8))).rejects.toThrow(/Only a person with access/);
  });

  it("refuses to approve a campaign with no plan", async () => {
    await db.query(
      `insert into client_campaigns (id, client_id, name) values ($1, $2, 'Unplanned')`,
      [C(9), CLIENT],
    );
    await expect(approve(C(9))).rejects.toThrow(/no plan yet/);
  });

  it("refuses to approve the same plan twice", async () => {
    await planned(C(10));
    await approve(C(10));
    await expect(approve(C(10))).rejects.toThrow(/already approved/);
  });

  it("records who approved it", async () => {
    await planned(C(11));
    await approve(C(11));
    expect(await one(`select plan_approved_by from client_campaigns where id = $1`, [C(11)]))
      .toMatchObject({ plan_approved_by: PERSON });
  });
});

describe("the constraint", () => {
  it("will not let an approval exist without the plan it named", async () => {
    await planned(C(12));
    await expect(db.query(
      `update client_campaigns set plan_approved_at = now() where id = $1`, [C(12)],
    )).rejects.toThrow(/client_campaigns_plan_approval_check/);
  });

  it("will not let a fingerprint exist without an approval", async () => {
    await planned(C(13));
    await expect(db.query(
      `update client_campaigns set plan_approved_fingerprint = 'abc' where id = $1`, [C(13)],
    )).rejects.toThrow(/client_campaigns_plan_approval_check/);
  });
});
