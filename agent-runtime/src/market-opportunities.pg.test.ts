import { PGlite } from "@electric-sql/pglite";
import { readFile } from "node:fs/promises";
import { beforeEach, afterAll, describe, expect, it } from "vitest";

/**
 * Migrations 225 and 226 against a real Postgres.
 *
 * The engine's whole value is that it refuses to let a guess read as an
 * insight, so most of this is about what it will not do: approve something
 * nobody scored, approve something with a claim it cannot prove, let an agent
 * raise its own confidence, or let one client's opportunity cite another
 * client's intelligence.
 */
let db: PGlite;

const CLIENT = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const MANAGER = "33333333-3333-4333-8333-333333333333";
const ICP = "44444444-4444-4444-8444-444444444444";
const OFFER = "55555555-5555-4555-8555-555555555555";
const PROOF = "66666666-6666-4666-8666-666666666666";

const migration = (file: string) =>
  readFile(new URL(`../../supabase/migrations/${file}`, import.meta.url), "utf8");

const rows = async <T = Record<string, unknown>>(sql: string, p: unknown[] = []) =>
  (await db.query<T>(sql, p)).rows;
const one = async <T = Record<string, unknown>>(sql: string, p: unknown[] = []) =>
  (await rows<T>(sql, p))[0]!;

/** Every factor at the same mark, which makes the weighted total that mark. */
const evenly = (mark: number) =>
  JSON.stringify(Object.fromEntries(
    ["economic_value", "commercial_urgency", "reachability", "available_proof",
     "offer_fit", "competitive_opportunity", "delivery_capacity"].map((f) => [f, mark]),
  ));

async function propose(key = "k1", client = CLIENT) {
  return (await one<{ id: string }>(
    "select create_market_opportunity_v6($1,$2,$3,$4,$5) as id",
    [key, client, "Garage-to-Gym Conversion", "Homeowners with an underused garage",
     "Mid-renovation, deciding what the garage becomes"],
  )).id;
}

/** Everything the readiness view asks for, so a test can remove one thing. */
async function makeReady(id: string) {
  await db.query(
    "select set_opportunity_fields_v6($1,$2,$3)",
    [id, "Their training space is poor and inconvenient", "A dedicated private gym at home"],
  );
  await db.query("select link_opportunity_v6($1,'offer',$2)", [id, OFFER]);
  await db.query("select score_market_opportunity_v6($1,$2::jsonb)", [id, evenly(80)]);
  await db.query("select set_opportunity_confidence_v6($1,'conversation',$2)", [
    id, "Three of the client's last ten jobs came in this way.",
  ]);
  await db.query(
    "select set_opportunity_awareness_v6($1,'solution_aware',$2,$3)",
    [id, "I could convert the garage", "See how we turn ordinary garages into complete home gyms"],
  );
}

beforeEach(async () => {
  db = new PGlite();
  await db.exec(`
    create role authenticated; create role anon; create role service_role;
    create schema auth;
    create function auth.uid() returns uuid language sql as
      $$ select '${MANAGER}'::uuid $$;
    create function auth.role() returns text language sql as
      $$ select coalesce(current_setting('test.role', true), 'authenticated') $$;
    create function is_admin() returns boolean language sql as
      $$ select coalesce(current_setting('test.admin', true), 'true') = 'true' $$;
    create function can_access_client(p uuid) returns boolean language sql as
      $$ select p = '${CLIENT}'::uuid $$;
    create function active_video_approval_manager(uuid) returns uuid language sql as
      $$ select '${MANAGER}'::uuid $$;
    create function lock_down_definer_functions() returns integer language sql as $$ select 0 $$;

    create table clients (id uuid primary key);
    create table profiles (id uuid primary key);
    create table agent_jobs (id uuid primary key default gen_random_uuid());
    create table client_agent_records (id uuid primary key, client_id uuid, domain text);
    create table service_offers (id uuid primary key, client_id uuid, name text);
    create table client_campaigns (id uuid primary key, client_id uuid);
    create table client_proof_assets (id uuid primary key, client_id uuid,
      usage_rights text, expires_on date);

    insert into clients values ('${CLIENT}'), ('${OTHER}');
    insert into profiles values ('${MANAGER}');
    insert into client_agent_records values ('${ICP}', '${CLIENT}', 'icp');
    insert into service_offers values ('${OFFER}', '${CLIENT}', 'Custom home gym');
    insert into client_proof_assets values ('${PROOF}', '${CLIENT}', 'approved', null);`);
  await db.exec(await migration("20261019160000_225_market_opportunities.sql"));
  await db.exec(await migration("20261019170000_226_opportunity_lifecycle.sql"));
}, 60000);

afterAll(async () => {
  await db?.close();
});

describe("proposing one", () => {
  it("is idempotent, and will not reuse a key for a different opportunity", async () => {
    const id = await propose();
    expect(await propose()).toEqual(id);
    await expect(
      db.query("select create_market_opportunity_v6($1,$2,$3,$4,$5)", [
        "k1", CLIENT, "Something else", "Someone else", "Elsewhere",
      ]),
    ).rejects.toThrow("already belongs to a different opportunity");
    expect(await rows("select 1 from market_opportunities")).toHaveLength(1);
  });

  it("starts as a hypothesis, whoever proposed it", async () => {
    const id = await propose();
    expect(
      await one<{ confidence: string; status: string }>(
        "select confidence, status from market_opportunities where id = $1", [id],
      ),
    ).toMatchObject({ confidence: "hypothesis", status: "discovered" });
  });

  it("records who proposed it, and refuses an agent claiming to be a person", async () => {
    await db.exec("set test.role = 'service_role'");
    await expect(
      db.query("select create_market_opportunity_v6($1,$2,$3,$4,$5,null,null,null,null,null,null,'human')",
        ["k2", CLIENT, "Agent idea", "Someone", "Somewhere"]),
    ).rejects.toThrow("proposes as an agent");
    const id = (await one<{ id: string }>(
      "select create_market_opportunity_v6($1,$2,$3,$4,$5,null,null,null,null,null,null,'agent') as id",
      ["k3", CLIENT, "Agent idea", "Someone", "Somewhere"])).id;
    expect(await one("select proposed_by from market_opportunities where id = $1", [id]))
      .toMatchObject({ proposed_by: "agent" });
  });

  it("is refused to anyone who is neither admin nor the assigned manager", async () => {
    await db.exec("set test.admin = 'false'");
    await db.exec("drop function active_video_approval_manager(uuid) cascade");
    await db.exec(`create function active_video_approval_manager(uuid) returns uuid
      language sql as $$ select null::uuid $$`);
    await expect(propose("k4")).rejects.toThrow("admin or assigned client manager");
  });
});

describe("what it is built on", () => {
  it("refuses to cite another client's intelligence", async () => {
    const id = await propose();
    await db.exec(`insert into client_agent_records values ('${OTHER}', '${OTHER}', 'icp')`);
    await expect(db.query("select link_opportunity_v6($1,'parent_icp',$2)", [id, OTHER]))
      .rejects.toThrow("does not belong to this client");
  });

  it("insists the role matches the kind of thing it points at", async () => {
    const id = await propose();
    await expect(db.query("select link_opportunity_v6($1,'offer',$2)", [id, ICP]))
      .rejects.toThrow("does not belong to this client");
    await db.query("select link_opportunity_v6($1,'parent_icp',$2)", [id, ICP]);
    expect(await one("select role, record_id from opportunity_links where opportunity_id = $1", [id]))
      .toMatchObject({ role: "parent_icp", record_id: ICP });
  });

  it("links a campaign without requiring one", async () => {
    // A campaign may exist with no recorded commercial reason, for now.
    const id = await propose();
    await db.exec(`insert into client_campaigns values ('${OTHER}', '${CLIENT}')`);
    await db.query("select link_opportunity_v6($1,'campaign',$2)", [id, OTHER]);
    expect(await rows("select 1 from opportunity_links where role = 'campaign'")).toHaveLength(1);
  });
});

describe("the lists", () => {
  it("replaces a list rather than appending to it, and keeps the order", async () => {
    const id = await propose();
    await db.query("select set_opportunity_attributes_v6($1,'objection',$2)", [
      id, ["Flooring", "Noise", "Ventilation"],
    ]);
    await db.query("select set_opportunity_attributes_v6($1,'objection',$2)", [
      id, ["Total cost", "Flooring"],
    ]);
    expect(
      await rows<{ body: string }>(
        "select body from opportunity_attributes where kind = 'objection' order by position",
      ),
    ).toEqual([{ body: "Total cost" }, { body: "Flooring" }]);
  });

  it("drops blanks and duplicates instead of storing them", async () => {
    const id = await propose();
    const n = await one<{ set_opportunity_attributes_v6: number }>(
      "select set_opportunity_attributes_v6($1,'problem',$2)",
      [id, ["Poor setup", "  ", "Poor setup", "Inconvenient"]],
    );
    expect(n).toMatchObject({ set_opportunity_attributes_v6: 2 });
  });
});

describe("scoring", () => {
  it("weights the factors and bands the result", async () => {
    const id = await propose();
    for (const [mark, band] of [[90, "scale"], [60, "test"], [40, "research"], [10, "reject"]] as const) {
      await db.query("select score_market_opportunity_v6($1,$2::jsonb)", [id, evenly(mark)]);
      // Every factor at the same mark means the weighted total is that mark,
      // which is only true while the weights add up to one.
      expect(
        await one<{ total: string; classification: string }>(
          "select total, classification from opportunity_scores where opportunity_id = $1 order by scored_at desc limit 1",
          [id],
        ),
      ).toMatchObject({ total: `${mark}.00`, classification: band });
    }
    // Kept, not overwritten.
    expect(await rows("select 1 from opportunity_scores")).toHaveLength(4);
  });

  it("refuses a partial score", async () => {
    const id = await propose();
    await expect(
      db.query("select score_market_opportunity_v6($1,$2::jsonb)", [
        id, JSON.stringify({ economic_value: 80, reachability: 70 }),
      ]),
    ).rejects.toThrow("Missing: available_proof");
  });

  it("will not let the weights stop adding up to one", async () => {
    await expect(
      db.exec("update opportunity_score_factors set weight = 0.5 where factor = 'economic_value'"),
    ).rejects.toThrow("add up to 1");
  });
});

describe("readiness", () => {
  it("names one thing at a time, in the order somebody should hear them", async () => {
    const id = await propose();
    const blocker = async () =>
      (await one<{ blocker: string | null }>(
        "select blocker from opportunity_readiness where opportunity_id = $1", [id],
      )).blocker;

    expect(await blocker()).toContain("No problem recorded");
    await db.query("select set_opportunity_fields_v6($1,$2)", [id, "Poor training space"]);
    expect(await blocker()).toContain("No desired outcome");
    await db.query("select set_opportunity_fields_v6($1,null,$2)", [id, "A private gym"]);
    expect(await blocker()).toContain("something the client actually sells");
    await db.query("select link_opportunity_v6($1,'offer',$2)", [id, OFFER]);
    expect(await blocker()).toContain("Nobody has scored it");
    await db.query("select score_market_opportunity_v6($1,$2::jsonb)", [id, evenly(10)]);
    expect(await blocker()).toContain("Scored as reject");
    await db.query("select score_market_opportunity_v6($1,$2::jsonb)", [id, evenly(80)]);
    expect(await blocker()).toContain("Still a hypothesis");
    await db.query("select set_opportunity_confidence_v6($1,'desk_research',$2)", [id, "Checked."]);
    expect(await blocker()).toContain("No awareness journey");
    await db.query("select set_opportunity_awareness_v6($1,'unaware',$2,$3)", [
      id, "I have no good setup", "What could you do with that unused garage?",
    ]);
    expect(await blocker()).toBeNull();
  });

  it("counts an unproven claim as a blocker", async () => {
    const id = await propose();
    await makeReady(id);
    expect(await one("select blocker from opportunity_readiness where opportunity_id = $1", [id]))
      .toMatchObject({ blocker: null });

    await db.query("select require_opportunity_proof_v6($1,$2)", [
      id, "A completed garage conversion with costs",
    ]);
    expect(
      await one<{ blocker: string }>(
        "select blocker from opportunity_readiness where opportunity_id = $1", [id],
      ),
    ).toMatchObject({ blocker: "1 claim has no proof on file. Capture it, or change the claim." });

    const req = await one<{ id: string }>("select id from opportunity_proof_requirements");
    await db.query("select satisfy_opportunity_proof_v6($1,$2)", [req.id, PROOF]);
    expect(await one("select blocker from opportunity_readiness where opportunity_id = $1", [id]))
      .toMatchObject({ blocker: null });
  });

  it("will not let uncleared proof satisfy a claim", async () => {
    const id = await propose();
    await db.query("select require_opportunity_proof_v6($1,$2)", [id, "Anything"]);
    const req = await one<{ id: string }>("select id from opportunity_proof_requirements");
    await db.exec(`update client_proof_assets set usage_rights = 'not_cleared'`);
    await expect(db.query("select satisfy_opportunity_proof_v6($1,$2)", [req.id, PROOF]))
      .rejects.toThrow("not cleared for use");
  });
});

describe("the lifecycle", () => {
  it("refuses to approve anything the readiness view objects to", async () => {
    const id = await propose();
    await expect(db.query("select set_opportunity_status_v6($1,'approved')", [id]))
      .rejects.toThrow("No problem recorded");
    await makeReady(id);
    // discovered -> approved is not a legal move even once it is ready.
    await expect(db.query("select set_opportunity_status_v6($1,'approved')", [id]))
      .rejects.toThrow("cannot go from discovered to approved");
    await db.query("select set_opportunity_status_v6($1,'validated')", [id]);
    await db.query("select set_opportunity_status_v6($1,'approved')", [id]);
    expect(await one("select status from market_opportunities where id = $1", [id]))
      .toMatchObject({ status: "approved" });
  });

  it("insists on a reason for stopping or writing one off", async () => {
    const id = await propose();
    await expect(db.query("select set_opportunity_status_v6($1,'rejected')", [id]))
      .rejects.toThrow();
    await db.query("select set_opportunity_status_v6($1,'rejected',$2)", [id, "Too few of them."]);
    expect(await one("select status, status_note from market_opportunities where id = $1", [id]))
      .toMatchObject({ status: "rejected", status_note: "Too few of them." });
  });

  it("lets anything in flight pause and come back, but rejection is one way", async () => {
    const id = await propose();
    await db.query("select set_opportunity_status_v6($1,'paused',$2)", [id, "Client on hold."]);
    await db.query("select set_opportunity_status_v6($1,'discovered')", [id]);
    await db.query("select set_opportunity_status_v6($1,'rejected',$2)", [id, "No."]);
    await expect(db.query("select set_opportunity_status_v6($1,'discovered')", [id]))
      .rejects.toThrow("cannot go from rejected to discovered");
  });
});

describe("confidence", () => {
  it("needs a person and a reason", async () => {
    const id = await propose();
    await expect(db.query("select set_opportunity_confidence_v6($1,'proven',$2)", [id, "  "]))
      .rejects.toThrow("what evidence moved this");
    await db.query("select set_opportunity_confidence_v6($1,'first_party',$2)", [
      id, "Eleven of last quarter's customers came in this way.",
    ]);
    expect(await one("select confidence from market_opportunities where id = $1", [id]))
      .toMatchObject({ confidence: "first_party" });
  });

  it("will not let an agent raise its own", async () => {
    await db.exec("set test.role = 'service_role'");
    const id = (await one<{ id: string }>(
      "select create_market_opportunity_v6($1,$2,$3,$4,$5,null,null,null,null,null,null,'agent') as id",
      ["k9", CLIENT, "Agent idea", "Someone", "Somewhere"])).id;
    await expect(
      db.exec(`update market_opportunities set confidence = 'proven' where id = '${id}'`),
    ).rejects.toThrow("cannot raise its own");
  });
});

describe("the event log", () => {
  it("records what happened and cannot be rewritten", async () => {
    const id = await propose();
    await makeReady(id);
    const events = await rows<{ event: string }>(
      "select event from opportunity_events where opportunity_id = $1 order by occurred_at", [id],
    );
    expect(events.map((e) => e.event)).toEqual(
      expect.arrayContaining(["proposed", "edited", "linked", "scored", "confidence_changed"]),
    );
    await expect(db.exec("update opportunity_events set detail = 'changed'"))
      .rejects.toThrow("not edited");
  });
});
