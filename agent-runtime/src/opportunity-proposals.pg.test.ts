import { PGlite } from "@electric-sql/pglite";
import { readFile } from "node:fs/promises";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

/**
 * Migrations 306 and 307 against a real Postgres.
 *
 * 306 exists because an agent may not score an opportunity. Scoring is what
 * unlocks spend against a hypothesis, so on Alex's decision of 4 November the
 * agent proposes and a human accepts, and no guard was widened to do it. What
 * is worth pinning is therefore mostly what the thing REFUSES: a proposal
 * nobody can argue with, a second decision on a decided card, a rejection
 * without a reason, and a person clearing a queue they have no standing to act
 * on.
 *
 * score_market_opportunity_v6 is stubbed here with a faithful minimum -- guard
 * on can_shape_opportunity, require every factor, insert the row. Its own
 * behaviour is covered where it is defined; what matters here is that accepting
 * goes THROUGH it rather than around it, so the one rule about who may score
 * stays in one place.
 */
let db: PGlite;

const CLIENT = "11111111-1111-4111-8111-111111111111";
const OTHER_CLIENT = "22222222-2222-4222-8222-222222222222";
const OPP = "33333333-3333-4333-8333-333333333333";
const OTHER_OPP = "44444444-4444-4444-8444-444444444444";
const MANAGER = "55555555-5555-4555-8555-555555555555";

const sql = (file: string) =>
  readFile(new URL(`../../supabase/migrations/${file}`, import.meta.url), "utf8");

async function rows<T = Record<string, unknown>>(q: string, p: unknown[] = []): Promise<T[]> {
  return (await db.query<T>(q, p)).rows;
}
async function one<T = Record<string, unknown>>(q: string, p: unknown[] = []): Promise<T> {
  return (await rows<T>(q, p))[0]!;
}
/** Who the session is, and whether they may shape. */
const asManager = () => db.exec(`set local_test.shape = 'yes'`);
const asReader = () => db.exec(`set local_test.shape = 'no'`);

const FACTORS = {
  available_proof: 60, commercial_urgency: 70, competitive_opportunity: 50,
  delivery_capacity: 80, economic_value: 90, offer_fit: 75, reachability: 65,
};

beforeEach(async () => {
  await db?.close();
  db = new PGlite();

  await db.exec(`
 create schema if not exists auth;
 create role authenticated; create role anon; create role service_role;

 create table auth.users(id uuid primary key);
 -- opportunity_proposals.resolved_by references profiles(id), matching
 -- opportunity_scores.scored_by rather than auth.users directly.
 create table profiles(id uuid primary key references auth.users(id) on delete cascade);
 create table clients(id uuid primary key);
 create table market_opportunities(
   id uuid primary key, client_id uuid not null references clients(id) on delete cascade,
   name text not null, micro_market text);
 create table agent_jobs(
   id uuid primary key default gen_random_uuid(),
   agent_key text not null,
   client_id uuid references clients(id) on delete cascade,
   input_table text, input_id uuid,
   status text not null default 'queued',
   params jsonb not null default '{}',
   note text,
   created_by uuid,
   created_at timestamptz not null default now());
 create table agents(
   id uuid primary key default gen_random_uuid(),
   agent_key text not null unique,
   name text not null, initials text not null, domain text, description text,
   requires_upstream text[] not null default '{}',
   config jsonb not null default '{}',
   paused boolean not null default false,
   created_at timestamptz not null default now(),
   updated_at timestamptz not null default now(),
   archived_at timestamptz,
   scheduled_only boolean not null default false,
   requires_input boolean not null default false);
 create table opportunity_score_factors(factor text primary key, weight numeric not null, label text);
 create table opportunity_scores(
   id uuid primary key default gen_random_uuid(),
   opportunity_id uuid not null, client_id uuid not null,
   factors jsonb not null, total numeric not null, classification text not null,
   note text, scored_by uuid, scored_at timestamptz not null default now());
 create table opportunity_events(
   id uuid primary key default gen_random_uuid(),
   opportunity_id uuid not null, client_id uuid not null,
   event text not null, actor text not null, detail text,
   occurred_at timestamptz not null default now());

 create function auth.uid() returns uuid language sql stable as $a$
   select '${MANAGER}'::uuid $a$;
 create function current_role_of() returns text language sql stable as $a$
   select 'admin'::text $a$;
 create function can_access_client(p uuid) returns boolean language sql stable as $a$
   select p in ('${CLIENT}'::uuid, '${OTHER_CLIENT}'::uuid) $a$;
 create function can_shape_opportunity(p uuid) returns boolean language sql stable as $a$
   select coalesce(current_setting('local_test.shape', true), 'yes') = 'yes' $a$;
 create function lock_down_definer_functions() returns void language plpgsql as $a$
   begin return; end $a$;
 create function enqueue_agent_job_internal(
   p_agent_key text, p_client_id uuid, p_input_table text, p_input_id uuid,
   p_created_by uuid, p_params jsonb, p_note text) returns uuid
   language plpgsql as $a$
 declare v uuid;
 begin
   insert into agent_jobs(agent_key, client_id, input_table, input_id,
                          created_by, params, note)
   values (p_agent_key, p_client_id, p_input_table, p_input_id,
           p_created_by, p_params, p_note)
   returning id into v;
   return v;
 end $a$;

 -- Faithful minimum of the real scorer: the guard, the required factors, the
 -- weighted total, the row and the event.
 create function score_market_opportunity_v6(
   p_opportunity_id uuid, p_factors jsonb, p_note text default null)
   returns opportunity_scores language plpgsql as $a$
 declare
   v market_opportunities%rowtype; v_missing text; v_total numeric;
   v_class text; v_row opportunity_scores;
 begin
   select * into v from market_opportunities where id = p_opportunity_id;
   if v.id is null then raise exception 'No such opportunity.' using errcode='P0001'; end if;
   if not can_shape_opportunity(v.client_id) then
     raise exception 'Only an admin or assigned client manager can score opportunities.'
       using errcode='P0001';
   end if;
   if p_factors is null or jsonb_typeof(p_factors) <> 'object' then
     raise exception 'Score every factor from 0 to 100.' using errcode='P0001';
   end if;
   select string_agg(f.factor, ', ' order by f.factor) into v_missing
     from opportunity_score_factors f where not (p_factors ? f.factor);
   if v_missing is not null then
     raise exception 'Score every factor. Missing: %.', v_missing using errcode='P0001';
   end if;
   select sum(f.weight * least(greatest((p_factors->>f.factor)::numeric,0),100))
     into v_total from opportunity_score_factors f;
   v_class := case when v_total >= 75 then 'scale' when v_total >= 55 then 'test'
                   when v_total >= 35 then 'research' else 'reject' end;
   insert into opportunity_scores(opportunity_id, client_id, factors, total,
                                  classification, note, scored_by)
   values (p_opportunity_id, v.client_id, p_factors, round(v_total,2), v_class,
           nullif(btrim(p_note),''), auth.uid())
   returning * into v_row;
   insert into opportunity_events(opportunity_id, client_id, event, actor, detail)
   values (p_opportunity_id, v.client_id, 'scored', 'human',
           v_class || ' at ' || round(v_total,2));
   return v_row;
 end $a$;

 insert into auth.users(id) values ('${MANAGER}');
 insert into profiles(id) values ('${MANAGER}');
 insert into clients(id) values ('${CLIENT}'), ('${OTHER_CLIENT}');
 insert into market_opportunities(id, client_id, name, micro_market) values
   ('${OPP}', '${CLIENT}', 'Garage-to-Gym Conversion', 'Detached garages, 1930s semis'),
   ('${OTHER_OPP}', '${OTHER_CLIENT}', 'Loft Conversions', null);
 insert into opportunity_score_factors(factor, weight) values
   ('available_proof', 0.150), ('commercial_urgency', 0.150),
   ('competitive_opportunity', 0.100), ('delivery_capacity', 0.100),
   ('economic_value', 0.200), ('offer_fit', 0.150), ('reachability', 0.150);
 insert into agents(agent_key, name, initials) values
   ('opportunity_discovery', 'Opportunity Discovery', 'OD'),
   ('offer_strategy', 'Offer Strategist', 'OF');
 `);

  await db.exec(await sql("20261104010000_306_an_agent_may_propose_a_score_not_assert_one.sql"));
  await db.exec(await sql("20261104020000_307_the_offer_compiler.sql"));
});

afterAll(async () => {
  await db?.close();
});

/** What the agent writes, as service_role would. */
const propose = (over: Partial<Record<string, unknown>> = {}) => {
  const p = {
    opportunity_id: OPP, client_id: CLIENT, kind: "score",
    payload: JSON.stringify({ factors: FACTORS }),
    rationale: "Strong economic value; proof is thin but reachable.",
    proposed_by: "opportunity_evaluate",
    ...over,
  };
  return one<{ id: string }>(
    `insert into opportunity_proposals
       (opportunity_id, client_id, kind, payload, rationale, proposed_by)
     values ($1,$2,$3,$4::jsonb,$5,$6) returning id`,
    [p.opportunity_id, p.client_id, p.kind, p.payload, p.rationale, p.proposed_by],
  );
};

describe("what a proposal will not be", () => {
  it("refuses one with no rationale, because that is a number to rubber-stamp", async () => {
    await expect(propose({ rationale: "   " })).rejects.toThrow(/rationale/);
  });

  it("refuses a payload that is not an object", async () => {
    await expect(propose({ payload: JSON.stringify(7) }))
      .rejects.toThrow(/payload_object/);
  });

  it("refuses a kind it has no accept path for", async () => {
    await expect(propose({ kind: "vibes" })).rejects.toThrow(/kind/);
  });

  it("cannot be open and resolved at once, in either direction", async () => {
    const { id } = await propose();
    await expect(db.query(
      `update opportunity_proposals set resolved_at = now() where id = $1`, [id],
    )).rejects.toThrow(/open_is_unresolved/);
    await expect(db.query(
      `update opportunity_proposals set resolution = 'accepted' where id = $1`, [id],
    )).rejects.toThrow(/open_is_unresolved/);
  });

  it("carries a rejection reason only when rejected", async () => {
    const { id } = await propose();
    await expect(db.query(
      `update opportunity_proposals set rejection_reason = 'no' where id = $1`, [id],
    )).rejects.toThrow(/reason_only_when_rejected/);
  });
});

describe("accepting is the human's own scoring act", () => {
  it("scores exactly what was proposed, attributed to the accepting person", async () => {
    const { id } = await propose();
    asManager();
    const score = await one<{ total: string; classification: string; scored_by: string }>(
      `select total, classification, scored_by
         from accept_opportunity_score_proposal_v6($1)`, [id],
    );
    // 0.15*60 + 0.15*70 + 0.10*50 + 0.10*80 + 0.20*90 + 0.15*75 + 0.15*65 = 71.5
    expect(Number(score.total)).toBeCloseTo(71.5, 2);
    expect(score.classification).toBe("test");
    expect(score.scored_by).toBe(MANAGER);

    expect(await one(`select resolution, resolved_by from opportunity_proposals where id=$1`, [id]))
      .toMatchObject({ resolution: "accepted", resolved_by: MANAGER });
  });

  it("records that a machine drafted it, separately from who asserted it", async () => {
    const { id } = await propose();
    asManager();
    await db.query(`select accept_opportunity_score_proposal_v6($1)`, [id]);
    const events = await rows<{ event: string; actor: string; detail: string }>(
      `select event, actor, detail from opportunity_events order by event`,
    );
    // The assertion is the human's; the draft's origin is a separate fact.
    expect(events.map((e) => [e.event, e.actor])).toEqual([
      ["score_proposal_accepted", "human"],
      ["scored", "human"],
    ]);
    expect(events.find((e) => e.event === "score_proposal_accepted")!.detail)
      .toBe("drafted by opportunity_evaluate");
  });

  it("goes through the scorer's guard rather than around it", async () => {
    const { id } = await propose();
    asReader();
    await expect(db.query(`select accept_opportunity_score_proposal_v6($1)`, [id]))
      .rejects.toThrow(/can score opportunities/);
    // And nothing was half-done: no score, and the proposal is still open.
    expect(await one(`select count(*)::int as n from opportunity_scores`)).toMatchObject({ n: 0 });
    expect(await one(`select resolution from opportunity_proposals where id=$1`, [id]))
      .toMatchObject({ resolution: "open" });
  });

  it("refuses a second decision on a decided proposal", async () => {
    const { id } = await propose();
    asManager();
    await db.query(`select accept_opportunity_score_proposal_v6($1)`, [id]);
    await expect(db.query(`select accept_opportunity_score_proposal_v6($1)`, [id]))
      .rejects.toThrow(/already accepted/);
  });

  it("will not accept a strategy proposal as a score", async () => {
    const { id } = await propose({ kind: "strategy", payload: JSON.stringify({ positioning: "x" }) });
    asManager();
    await expect(db.query(`select accept_opportunity_score_proposal_v6($1)`, [id]))
      .rejects.toThrow(/not a score/);
  });
});

describe("rejecting", () => {
  it("needs a reason the next pass can read", async () => {
    const { id } = await propose();
    asManager();
    await expect(db.query(`select reject_opportunity_proposal_v6($1, '  ')`, [id]))
      .rejects.toThrow(/Say why/);
  });

  it("takes the same standing as accepting", async () => {
    const { id } = await propose();
    asReader();
    await expect(db.query(`select reject_opportunity_proposal_v6($1, 'Economic value is guessed')`, [id]))
      .rejects.toThrow(/decide on a proposal/);
  });

  it("records the reason on the opportunity", async () => {
    const { id } = await propose();
    asManager();
    await db.query(`select reject_opportunity_proposal_v6($1, 'Economic value is guessed')`, [id]);
    expect(await one(`select resolution, rejection_reason from opportunity_proposals where id=$1`, [id]))
      .toMatchObject({ resolution: "rejected", rejection_reason: "Economic value is guessed" });
    expect(await one(`select event, actor, detail from opportunity_events`))
      .toMatchObject({ event: "proposal_rejected", actor: "human", detail: "Economic value is guessed" });
  });
});

describe("asking for the work", () => {
  it("queues one evaluation and refuses a concurrent second", async () => {
    const job = await one<{ request_opportunity_evaluation_v6: string }>(
      `select request_opportunity_evaluation_v6($1, $2)`, [CLIENT, OPP],
    );
    expect(job.request_opportunity_evaluation_v6).toBeTruthy();
    expect(await one(`select agent_key, input_table, input_id, note from agent_jobs`))
      .toMatchObject({
        agent_key: "opportunity_evaluate", input_table: "market_opportunities",
        input_id: OPP, note: "Queued: evaluate Garage-to-Gym Conversion",
      });
    await expect(db.query(`select request_opportunity_evaluation_v6($1, $2)`, [CLIENT, OPP]))
      .rejects.toThrow(/already queued or running/);
  });

  it("refuses an opportunity belonging to another client", async () => {
    await expect(db.query(`select request_opportunity_evaluation_v6($1, $2)`, [CLIENT, OTHER_OPP]))
      .rejects.toThrow(/belongs to another client/);
    await expect(db.query(`select request_opportunity_strategy_v6($1, $2)`, [CLIENT, OTHER_OPP]))
      .rejects.toThrow(/belongs to another client/);
  });

  it("queues a strategy pass independently of an evaluation", async () => {
    await db.query(`select request_opportunity_evaluation_v6($1, $2)`, [CLIENT, OPP]);
    await db.query(`select request_opportunity_strategy_v6($1, $2)`, [CLIENT, OPP]);
    expect(await rows(`select agent_key from agent_jobs order by agent_key`))
      .toEqual([{ agent_key: "opportunity_evaluate" }, { agent_key: "opportunity_strategise" }]);
  });

  it("registers both agents as needing an input row", async () => {
    expect(await rows(`select agent_key, requires_input from agents
                        where agent_key like 'opportunity_%' and agent_key <> 'opportunity_discovery'
                        order by agent_key`))
      .toEqual([
        { agent_key: "opportunity_evaluate", requires_input: true },
        { agent_key: "opportunity_strategise", requires_input: true },
      ]);
  });
});

describe("migration 307: the offer compiler", () => {
  it("compiles a main or secondary offer from strategy", async () => {
    await db.query(`select request_offer_compile_v6($1, 'main', 'strategy')`, [CLIENT]);
    expect(await one(`select agent_key, params, input_id from agent_jobs`))
      .toMatchObject({
        agent_key: "offer_compile",
        params: { kind: "main", source: "strategy" },
        input_id: null,
      });
  });

  it("refuses a kind or source it has no meaning for", async () => {
    await expect(db.query(`select request_offer_compile_v6($1, 'tertiary', 'strategy')`, [CLIENT]))
      .rejects.toThrow(/main offer or a secondary offer/);
    await expect(db.query(`select request_offer_compile_v6($1, 'main', 'vibes')`, [CLIENT]))
      .rejects.toThrow(/offer strategy or from a micro-niche/);
  });

  it("needs the opportunity when compiling from a micro-niche", async () => {
    await expect(db.query(`select request_offer_compile_v6($1, 'main', 'micro_niche')`, [CLIENT]))
      .rejects.toThrow(/needs the opportunity/);
    await db.query(`select request_offer_compile_v6($1, 'main', 'micro_niche', $2)`, [CLIENT, OPP]);
    expect(await one(`select input_table, input_id from agent_jobs`))
      .toMatchObject({ input_table: "market_opportunities", input_id: OPP });
  });

  it("refuses an opportunity with no micro-niche to compile from", async () => {
    await db.exec(`update market_opportunities set micro_market = null where id = '${OPP}'`);
    await expect(db.query(`select request_offer_compile_v6($1, 'main', 'micro_niche', $2)`, [CLIENT, OPP]))
      .rejects.toThrow(/no micro-niche/);
  });

  it("refuses an opportunity it would not read", async () => {
    // Compiling from strategy does not look at an opportunity, so accepting one
    // would record an input the run never used.
    await expect(db.query(`select request_offer_compile_v6($1, 'main', 'strategy', $2)`, [CLIENT, OPP]))
      .rejects.toThrow(/does not take an opportunity/);
  });

  it("holds one compile per kind, not one per client", async () => {
    await db.query(`select request_offer_compile_v6($1, 'main', 'strategy')`, [CLIENT]);
    await expect(db.query(`select request_offer_compile_v6($1, 'main', 'strategy')`, [CLIENT]))
      .rejects.toThrow(/already being compiled/);
    // A secondary offer is a different thing, so it is not held by the first.
    await db.query(`select request_offer_compile_v6($1, 'secondary', 'strategy')`, [CLIENT]);
    expect(await one(`select count(*)::int as n from agent_jobs`)).toMatchObject({ n: 2 });
  });
});
