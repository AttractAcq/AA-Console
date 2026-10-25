import { PGlite } from "@electric-sql/pglite";
import { readFile } from "node:fs/promises";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { CAMPAIGN_TEMPLATES } from "./campaigns/templates.js";

/**
 * Migration 244 against a real Postgres, on top of 225 and 226.
 *
 * G06 was that the sixteen templates lived only in TypeScript, so the one
 * question the opportunity work asks -- which template moves somebody in
 * this mindset -- could not be answered by a join. The things worth
 * asserting are therefore:
 *
 *   - the matrix in the database is the matrix the planner uses, exactly
 *   - a stage with no audience state gets no recommendation at all,
 *     rather than every template or a wrong one
 *   - a stage with a state gets precisely the templates that enter there
 *   - a template that enters somewhere else is refused, naming both states
 *   - choosing one without saying why is refused
 *   - the readiness sentence changes as the journey is filled in
 */
let db: PGlite;

const CLIENT = "11111111-1111-4111-8111-111111111111";
const MANAGER = "55555555-5555-4555-8555-555555555555";

const sql = (file: string) =>
  readFile(new URL(`../../supabase/migrations/${file}`, import.meta.url), "utf8");

async function rows<T = Record<string, unknown>>(q: string, p: unknown[] = []): Promise<T[]> {
  return (await db.query<T>(q, p)).rows;
}
async function one<T = Record<string, unknown>>(q: string, p: unknown[] = []): Promise<T> {
  return (await rows<T>(q, p))[0]!;
}
/** Throws if the call unexpectedly succeeds, so a refusal test cannot pass by accident. */
async function refusal(q: string, p: unknown[] = []): Promise<string> {
  try {
    await db.query(q, p);
  } catch (thrown) {
    return thrown instanceof Error ? thrown.message : String(thrown);
  }
  throw new Error(`Expected a refusal from: ${q}`);
}

/** An opportunity far enough along to carry an awareness journey. */
async function opportunity(): Promise<string> {
  const { id } = await one<{ id: string }>(
    `select create_market_opportunity_v6($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) as id`,
    [
      "garage-to-gym", CLIENT, "Garage-to-Gym Conversion",
      "Homeowners with an unused garage",
      "They want the space usable this winter",
      "The garage is damp",
      "A warm, dry room",
      "The gym membership renews in January",
      "problem_aware", "Insulation first", "Book a survey",
    ],
  );
  return id;
}

/** One awareness stage. `level` is one of production's five, not free text. */
async function stage(oppId: string, level: string, mindset: string): Promise<string> {
  await db.query(`select set_opportunity_awareness_v6($1,$2,$3,$4)`, [
    oppId, level, mindset, "A message that moves them one step",
  ]);
  const { id } = await one<{ id: string }>(
    `select id from opportunity_awareness_stages where opportunity_id = $1 and stage = $2`,
    [oppId, level],
  );
  return id;
}

beforeEach(async () => {
  db = new PGlite();
  await db.exec(`
 create role authenticated; create role anon; create role service_role;
 create schema auth;
 create function auth.role() returns text language sql as $$select coalesce(current_setting('test.role',true),'authenticated')$$;
 create function auth.uid() returns uuid language sql as $$select '${MANAGER}'::uuid$$;
 create function is_admin() returns boolean language sql as $$select coalesce(current_setting('test.admin',true),'true')='true'$$;
 create function can_access_client(uuid) returns boolean language sql as $$select $1='${CLIENT}'::uuid$$;
 create function active_video_approval_manager(uuid) returns uuid language sql as $$select '${MANAGER}'::uuid$$;
 create function lock_down_definer_functions() returns integer language sql as $$select 0$$;
 create function set_updated_at() returns trigger language plpgsql as $$begin new.updated_at := now(); return new; end$$;

 -- The enum is production's, not text: 244 types the matrix's primary key by
 -- it, so a stub with text here would accept a seventeenth code.
 create type campaign_template as enum
   ('P1','P2','P3','P4','P5','R1','R2','R3','R4','C1','C2','C3','O1','O2','X1','X2');

 create table clients(id uuid primary key);
 create table profiles(id uuid primary key);
 create table agent_jobs(id uuid primary key default gen_random_uuid());
 create table client_agent_records(id uuid primary key, client_id uuid, agent_key text,
   status text, payload jsonb, created_at timestamptz default now());
 create table client_proof_assets(id uuid primary key, client_id uuid, title text,
   usage_rights text, expires_on date, permission_basis text);
 create table service_offers(id uuid primary key, client_id uuid not null,
   service_name text not null, unique (id, client_id));
 create table service_offer_versions(id uuid primary key default gen_random_uuid(),
   offer_id uuid not null, client_id uuid not null, version integer not null,
   unique (offer_id, version), unique (id, client_id));
 create table client_campaigns(id uuid primary key default gen_random_uuid(),
   client_id uuid not null references clients(id), name text not null,
   template campaign_template, created_at timestamptz not null default now(),
   unique (id, client_id));

 insert into clients values('${CLIENT}');
 insert into profiles values('${MANAGER}');`);

  await db.exec(await sql("20261019160000_225_market_opportunities.sql"));
  await db.exec(await sql("20261019170000_226_opportunity_lifecycle.sql"));
  await db.exec(await sql("20261025090000_244_which_template_fits_this_stage.sql"));
});

afterAll(async () => {
  await db?.close();
});

describe("migration 244 — the matrix as data", () => {
  it("holds exactly the sixteen the planner uses, field for field", async () => {
    const dbRows = await rows<{
      code: string; name: string; fn: string; entry_state: string; exit_state: string;
      objective: string | null; optimisation: string | null; ctas: string[] | string;
      destination: string; kpi: string; purpose: string; guardrail: string;
      prerequisite: string | null; mirrors: boolean;
    }>("select * from campaign_template_matrix order by code");

    expect(dbRows).toHaveLength(16);
    expect(dbRows).toHaveLength(CAMPAIGN_TEMPLATES.length);

    const byCode = new Map(dbRows.map((r) => [r.code, r]));
    for (const t of CAMPAIGN_TEMPLATES) {
      const row = byCode.get(t.code);
      expect(row, `${t.code} is missing from the database matrix`).toBeDefined();
      expect(row!.name).toBe(t.name);
      expect(row!.fn).toBe(t.fn);
      expect(row!.entry_state).toBe(t.entry);
      expect(row!.exit_state).toBe(t.exit);
      expect(row!.objective).toBe(t.objective ?? null);
      expect(row!.optimisation).toBe(t.optimisation ?? null);
      expect(row!.destination).toBe(t.destination);
      expect(row!.kpi).toBe(t.kpi);
      expect(row!.purpose).toBe(t.purpose);
      expect(row!.guardrail).toBe(t.guardrail);
      expect(row!.prerequisite).toBe(t.prerequisite ?? null);
      expect(row!.mirrors).toBe(t.mirrors);
      const ctas = Array.isArray(row!.ctas)
        ? row!.ctas
        : String(row!.ctas).replace(/^\{|\}$/g, "").split(",").filter(Boolean);
      expect(ctas).toEqual([...t.ctas]);
    }
  });

  it("will not accept a seventeenth code, because the key is the enum", async () => {
    const message = await refusal(
      `insert into campaign_template_matrix (code, name, fn, entry_state, exit_state,
         destination, kpi, purpose, guardrail)
       values ('P9','Invented','build','S0','S1','page','k','p','g')`,
    );
    expect(message).toMatch(/invalid input value for enum campaign_template/i);
  });
});

describe("migration 244 — the awareness-to-audience map", () => {
  it("covers all five awareness levels", async () => {
    const got = await rows<{ awareness_level: string }>(
      "select distinct awareness_level from awareness_audience_map order by 1",
    );
    expect(got.map((r) => r.awareness_level)).toEqual([
      "most_aware", "problem_aware", "product_aware", "solution_aware", "unaware",
    ]);
  });

  it("maps unaware to S0 only, because a stranger is the definition", async () => {
    const got = await rows<{ audience_state: string }>(
      "select audience_state from awareness_audience_map where awareness_level = 'unaware'",
    );
    expect(got.map((r) => r.audience_state)).toEqual(["S0"]);
  });

  it("names the three templates no awareness stage can reach", async () => {
    const got = await rows<{ code: string; entry_state: string }>(
      "select code, entry_state from customer_lifecycle_templates order by code",
    );
    expect(got.map((r) => r.code)).toEqual(["C1", "C2", "C3"]);
    // C1 and C3 enter at S5, C2 at S6. Awareness describes neither.
    expect(new Set(got.map((r) => r.entry_state))).toEqual(new Set(["S5", "S6"]));
  });
});

describe("migration 244 — recommending a template for a stage", () => {
  it("recommends from the awareness level alone, with no new data entry", async () => {
    const opp = await opportunity();
    const id = await stage(opp, "unaware", "Does not know the problem has a name");
    const got = await rows<{ candidate_template: string }>(
      "select candidate_template from awareness_stage_templates where stage_id = $1 order by candidate_template",
      [id],
    );
    // unaware maps to S0, so exactly the templates that enter at S0. Sorted in
    // JS on both sides: `candidate_template` is the enum, and Postgres orders
    // an enum by its declaration order rather than alphabetically.
    const expected = CAMPAIGN_TEMPLATES.filter((t) => t.entry === "S0").map((t) => t.code).sort();
    expect(got.map((r) => r.candidate_template).sort()).toEqual(expected);
    expect(expected).toContain("P1");
    expect(expected).not.toContain("R1");
  });

  it("gives a problem_aware stage both its states' templates", async () => {
    const opp = await opportunity();
    const id = await stage(opp, "problem_aware", "Feels it, has not looked");
    const got = await rows<{ candidate_template: string; audience_state: string }>(
      "select candidate_template, audience_state from awareness_stage_templates where stage_id = $1",
      [id],
    );
    // S0 and S1 both, because both are true of different people in the niche.
    expect(new Set(got.map((r) => r.audience_state))).toEqual(new Set(["S0", "S1"]));
    expect(got.map((r) => r.candidate_template)).toContain("P1");
    expect(got.map((r) => r.candidate_template)).toContain("R1");
  });

  it("says what each candidate would do, and how it is got wrong", async () => {
    const opp = await opportunity();
    const id = await stage(opp, "problem_aware", "Feels it");
    const r1 = await one<{ fit: string; guardrail: string }>(
      "select fit, guardrail from awareness_stage_templates where stage_id = $1 and candidate_template = 'R1'",
      [id],
    );
    expect(r1.fit).toBe("Moves S1 to S3 via page. Needs: P1 or P4 running 14 days or more.");
    expect(r1.guardrail.length).toBeGreaterThan(0);
  });

  it("an override replaces the map entirely for that stage", async () => {
    const opp = await opportunity();
    const id = await stage(opp, "problem_aware", "In this trade everybody already follows somebody");
    await db.query(`select set_awareness_stage_template_v6($1,null,null,'S1')`, [id]);
    const got = await rows<{ audience_state: string; state_overridden: boolean }>(
      "select distinct audience_state, state_overridden from awareness_stage_templates where stage_id = $1",
      [id],
    );
    expect(got).toHaveLength(1);
    expect(got[0]!.audience_state).toBe("S1");
    expect(got[0]!.state_overridden).toBe(true);
  });

  it("refuses a template that enters somewhere this audience is not", async () => {
    const opp = await opportunity();
    const id = await stage(opp, "unaware", "Knows nothing");
    // R1 enters at S1. An unaware audience is at S0 only.
    const message = await refusal(
      `select set_awareness_stage_template_v6($1,'R1','Because I like it')`, [id],
    );
    expect(message).toContain("enters at S1");
    expect(message).toContain("unaware audience is at S0");
  });

  it("refuses a customer template from any awareness stage", async () => {
    const opp = await opportunity();
    const id = await stage(opp, "most_aware", "Ready to buy");
    const message = await refusal(
      `select set_awareness_stage_template_v6($1,'C1','Expand them')`, [id],
    );
    expect(message).toContain("enters at S5");
  });

  it("refuses a template chosen without a reason", async () => {
    const opp = await opportunity();
    const id = await stage(opp, "unaware", "Knows nothing");
    const message = await refusal(
      `select set_awareness_stage_template_v6($1,'P1',null)`, [id],
    );
    expect(message).toMatch(/say why this template fits/i);
  });

  it("records the choice and marks it chosen among the candidates", async () => {
    const opp = await opportunity();
    const id = await stage(opp, "unaware", "Knows nothing");
    await db.query(
      `select set_awareness_stage_template_v6($1,'P1','Buys a channel we keep for free')`, [id],
    );
    const chosen = await rows<{ candidate_template: string }>(
      "select candidate_template from awareness_stage_templates where stage_id = $1 and chosen",
      [id],
    );
    expect(chosen.map((c) => c.candidate_template)).toEqual(["P1"]);
    const row = await one<{ template_rationale: string }>(
      "select template_rationale from opportunity_awareness_stages where id = $1", [id],
    );
    expect(row.template_rationale).toBe("Buys a channel we keep for free");
  });

  it("lets an override unlock a template the map would have refused", async () => {
    const opp = await opportunity();
    const id = await stage(opp, "unaware", "Unusual niche: they lurk for months first");
    await refusal(`select set_awareness_stage_template_v6($1,'R4','Seed the post')`, [id]);
    await db.query(
      `select set_awareness_stage_template_v6($1,'R4','They lurk before they ever search','S1')`,
      [id],
    );
    const row = await one<{ recommended_template: string; audience_state_override: string }>(
      "select recommended_template, audience_state_override from opportunity_awareness_stages where id = $1",
      [id],
    );
    expect(row.recommended_template).toBe("R4");
    expect(row.audience_state_override).toBe("S1");
  });
});

describe("migration 244 — readiness and the implied plan", () => {
  it("walks the blocker sentence as the journey is filled in", async () => {
    const opp = await opportunity();
    const read = async () =>
      (await one<{ blocker: string | null }>(
        "select blocker from opportunity_template_readiness where opportunity_id = $1", [opp],
      )).blocker;

    expect(await read()).toMatch(/no awareness journey/i);

    const a = await stage(opp, "unaware", "Knows nothing");
    expect(await read()).toMatch(/nobody has chosen one yet/i);

    const b = await stage(opp, "product_aware", "Comparing providers");
    await db.query(`select set_awareness_stage_template_v6($1,'P1','Pool first')`, [a]);
    expect(await read()).toMatch(/1 stage\(s\) still have no chosen template/);

    await db.query(`select set_awareness_stage_template_v6($1,'O1','Deadline closes them')`, [b]);
    expect(await read()).toBeNull();
  });

  it("orders the implied campaigns by awareness, not by entry order", async () => {
    const opp = await opportunity();
    // Recorded late-stage first, so ordering cannot pass by luck.
    const late = await stage(opp, "most_aware", "Ready now");
    await db.query(`select set_awareness_stage_template_v6($1,'R2','Answer the last objection')`, [late]);
    const early = await stage(opp, "unaware", "Knows nothing");
    await db.query(`select set_awareness_stage_template_v6($1,'P1','Build the pool')`, [early]);

    const plan = await rows<{ step: string; template: string; awareness_level: string }>(
      "select step, template, awareness_level from opportunity_campaign_plan where opportunity_id = $1 order by step",
      [opp],
    );
    expect(plan.map((p) => p.awareness_level)).toEqual(["unaware", "most_aware"]);
    expect(plan.map((p) => p.template)).toEqual(["P1", "R2"]);
  });
});
