import { PGlite } from "@electric-sql/pglite";
import { readFile } from "node:fs/promises";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

/**
 * Migration 232 against a real Postgres, on top of 225 and 226.
 *
 * The point of the opportunity layer is that a campaign should exist because
 * somebody would buy something. The way that argument dies quietly is a
 * person approving an opportunity and then writing a campaign brief from
 * memory on another screen, so the things worth asserting here are:
 *
 *   - an unapproved opportunity cannot become a campaign
 *   - one that has stopped being ready since approval cannot either
 *   - the reasoning actually reaches the brief the planner reads
 *   - the linked offer's signed-off version is bound, and an unsigned one is not
 *   - a second press of the button does not make a second campaign
 *   - the link is readable from both ends
 */
let db: PGlite;

const CLIENT = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const MANAGER = "55555555-5555-4555-8555-555555555555";
const PROOF = "33333333-3333-4333-8333-333333333333";
const OFFER = "88888888-8888-4888-8888-888888888888";

const sql = (file: string) =>
  readFile(new URL(`../../supabase/migrations/${file}`, import.meta.url), "utf8");

async function rows<T = Record<string, unknown>>(query: string, params: unknown[] = []): Promise<T[]> {
  return (await db.query<T>(query, params)).rows;
}
async function one<T = Record<string, unknown>>(query: string, params: unknown[] = []): Promise<T> {
  return (await rows<T>(query, params))[0]!;
}

/** An opportunity worked up to the point a person could approve it. */
async function ready(over: { positioning?: string | null; key?: string } = {}): Promise<string> {
  const { id } = await one<{ id: string }>(
    `select create_market_opportunity_v6($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) as id`,
    [
      over.key ?? "garage-to-gym",
      CLIENT,
      "Garage-to-Gym Conversion",
      "Homeowners in semi-detached houses with an unused garage",
      "They have decided to stop paying for a gym and want the space usable this winter",
      "The garage is damp and unusable for half the year",
      "A warm, dry room they will actually train in",
      "The gym membership renews in January",
      "problem_aware",
      // The one field a test switches off, to prove an empty heading is left
      // out rather than printed with nothing under it.
      "positioning" in over ? over.positioning : "Insulation and flooring first, equipment second",
      "Book a survey",
    ],
  );
  await db.query(`select set_opportunity_attributes_v6($1,'problem',$2)`, [
    id,
    ["Condensation on the walls", "No power for machines"],
  ]);
  await db.query(`select set_opportunity_attributes_v6($1,'objection',$2)`, [
    id,
    ["Worried it will not be warm enough"],
  ]);
  await db.query(
    `select set_opportunity_awareness_v6($1,'problem_aware','They know it is damp','Damp is fixable')`,
    [id],
  );
  await db.query(`select link_opportunity_v6($1,'offer',$2)`, [id, OFFER]);
  await db.query(
    `select score_market_opportunity_v6($1, jsonb_build_object(
       'economic_value', 70, 'commercial_urgency', 75, 'reachability', 65,
       'available_proof', 60, 'offer_fit', 80, 'competitive_opportunity', 55,
       'delivery_capacity', 70))`,
    [id],
  );
  await db.query(`select set_opportunity_confidence_v6($1,'conversation','Three survey calls said so')`, [id]);
  // discovered -> validated -> approved. 225 has no shortcut, which is the
  // point: "somebody checked the hypothesis holds up" is its own act.
  await db.query(`select set_opportunity_status_v6($1,'validated')`, [id]);
  await db.query(`select set_opportunity_status_v6($1,'approved')`, [id]);
  return id;
}

/** What stops this opportunity, as the Activate screen reads it. */
async function blocker(id: string): Promise<string | null> {
  const row = await one<{ blocker: string | null }>(
    "select blocker from opportunity_readiness where opportunity_id = $1",
    [id],
  );
  return row?.blocker ?? null;
}

async function create(id: string, mode = "organic", platform: string | null = null) {
  return one<{
    id: string;
    name: string;
    brief: string;
    acquisition_mode: string;
    paid_platform: string | null;
    offer_version_id: string | null;
  }>("select * from create_campaign_from_opportunity_v6($1,$2,$3)", [id, mode, platform]);
}

beforeEach(async () => {
  db = new PGlite();
  await db.exec(`
 create role authenticated; create role anon; create role service_role;
 create schema auth;
 create function auth.role() returns text language sql as $$select coalesce(current_setting('test.role',true),'authenticated')$$;
 create function auth.uid() returns uuid language sql as $$select '${MANAGER}'::uuid$$;
 create function is_admin() returns boolean language sql as $$select coalesce(current_setting('test.admin',true),'true')='true'$$;
 create function active_video_approval_manager(uuid) returns uuid language sql as $$select '${MANAGER}'::uuid$$;
 create function can_access_client(uuid) returns boolean language sql as $$select $1='${CLIENT}'::uuid$$;
 create function lock_down_definer_functions() returns integer language sql as $$select 0$$;
 create function set_updated_at() returns trigger language plpgsql as $$begin new.updated_at := now(); return new; end$$;

 create table clients(id uuid primary key);
 create table profiles(id uuid primary key);
 create table agent_jobs(id uuid primary key default gen_random_uuid());
 create table client_agent_records(id uuid primary key, client_id uuid, agent_key text,
   status text, payload jsonb, created_at timestamptz default now());
 create table client_proof_assets(id uuid primary key, client_id uuid, title text,
   usage_rights text, expires_on date, permission_basis text);

 -- Migration 208's offer tables, in the shape 210's guard reads.
 create table service_offers(id uuid primary key, client_id uuid not null,
   service_name text not null, unique (id, client_id));
 create table service_offer_versions(id uuid primary key default gen_random_uuid(),
   offer_id uuid not null, client_id uuid not null, version integer not null,
   unique (offer_id, version), unique (id, client_id),
   foreign key (offer_id, client_id) references service_offers(id, client_id));
 create table service_offer_signoffs(offer_version_id uuid primary key, client_id uuid not null,
   approved_by uuid, approved_at timestamptz default now(),
   foreign key (offer_version_id, client_id) references service_offer_versions(id, client_id));

 -- Migration 72's campaign, plus the v6 columns 203 and 210 add and the
 -- guard 210 installs, which is the part that matters here.
 create table client_campaigns(
   id uuid primary key default gen_random_uuid(),
   client_id uuid not null references clients(id) on delete cascade,
   name text not null, brief text not null,
   status text not null default 'planning',
   acquisition_mode text not null default 'legacy',
   paid_platform text,
   offer_version_id uuid,
   built_at timestamptz,
   created_at timestamptz not null default now(),
   updated_at timestamptz not null default now(),
   unique (id, client_id),
   constraint client_campaigns_acquisition_route_check check (
     (acquisition_mode = 'paid' and paid_platform in ('meta','google'))
     or (acquisition_mode in ('legacy','organic') and paid_platform is null)),
   foreign key (offer_version_id, client_id)
     references service_offer_versions(id, client_id) on delete restrict);

 create function guard_campaign_offer_version_v6() returns trigger
 language plpgsql set search_path = pg_catalog, public as $g$
 begin
   if new.offer_version_id is not null and not exists (
     select 1 from public.service_offer_signoffs s
      where s.offer_version_id = new.offer_version_id and s.client_id = new.client_id) then
     raise exception 'Choose an approved offer version belonging to this client.';
   end if;
   return new;
 end $g$;
 create trigger guard_campaign_offer_version_v6
   before insert or update of offer_version_id on client_campaigns
   for each row execute function guard_campaign_offer_version_v6();

 insert into clients values('${CLIENT}'),('${OTHER}');
 insert into profiles values('${MANAGER}');
 insert into client_proof_assets values('${PROOF}','${CLIENT}','A real conversion','approved',null,'Written consent');
 insert into service_offers values('${OFFER}','${CLIENT}','Garage conversion');`);

  await db.exec(await sql("20261019160000_225_market_opportunities.sql"));
  await db.exec(await sql("20261019170000_226_opportunity_lifecycle.sql"));
  await db.exec(await sql("20261022110000_232_campaign_from_opportunity.sql"));

  // One signed-off offer version, and a later unsigned one, so the binding
  // test has something to get wrong.
  await db.exec(`
 insert into service_offer_versions(id, offer_id, client_id, version)
   values ('99999999-9999-4999-8999-999999999991','${OFFER}','${CLIENT}',1);
 insert into service_offer_signoffs(offer_version_id, client_id, approved_by)
   values ('99999999-9999-4999-8999-999999999991','${CLIENT}','${MANAGER}');`);
}, 60000);

afterAll(async () => {
  await db?.close();
});

describe("what may become a campaign", () => {
  it("refuses an opportunity nobody has approved", async () => {
    const id = await ready();
    await db.query(`select set_opportunity_status_v6($1,'paused','Waiting on the client.')`, [id]);
    await expect(create(id)).rejects.toThrow("This opportunity is paused");
  });

  it("refuses one that has stopped being ready since it was approved", async () => {
    const id = await ready();
    // A claim that lost its proof. Readiness is read now rather than
    // trusted from whenever the approval happened.
    await db.query(`select require_opportunity_proof_v6($1,$2)`, [
      id,
      "Three garages converted in this postcode",
    ]);
    expect(await blocker(id)).toContain("no proof on file");
    await expect(create(id)).rejects.toThrow("no proof on file");
  });

  it("refuses a route that is not one of the two", async () => {
    const id = await ready();
    await expect(create(id, "both")).rejects.toThrow("organic or paid route");
    await expect(create(id, "paid", null)).rejects.toThrow("Meta Ads or Google Ads");
    await expect(create(id, "paid", "tiktok")).rejects.toThrow("Meta Ads or Google Ads");
  });

  it("refuses anyone who is neither an admin nor the assigned manager", async () => {
    const id = await ready();
    await db.exec("set test.admin = 'false'");
    await db.exec("drop function active_video_approval_manager(uuid) cascade");
    await db.exec(`create function active_video_approval_manager(uuid) returns uuid
      language sql as $$select null::uuid$$`);
    await expect(create(id)).rejects.toThrow("admin or assigned client manager");
  });
});

describe("what the campaign carries", () => {
  it("puts the opportunity's reasoning in the brief the planner reads", async () => {
    const id = await ready();
    const campaign = await create(id);

    expect(campaign.name).toBe("Garage-to-Gym Conversion");
    expect(campaign.acquisition_mode).toBe("organic");
    expect(campaign.paid_platform).toBeNull();
    // Not a restatement of the name: the problem, the outcome, the trigger,
    // the positioning and the objections a person established.
    expect(campaign.brief).toContain("unused garage");
    expect(campaign.brief).toContain("The garage is damp and unusable");
    expect(campaign.brief).toContain("A warm, dry room");
    expect(campaign.brief).toContain("The gym membership renews in January");
    expect(campaign.brief).toContain("Insulation and flooring first");
    expect(campaign.brief).toContain("Book a survey");
    expect(campaign.brief).toContain("Condensation on the walls");
    expect(campaign.brief).toContain("Worried it will not be warm enough");
    expect(campaign.brief).toContain("problem aware");
  });

  it("leaves out a heading it has nothing to put under", async () => {
    const id = await ready({ positioning: null });
    const campaign = await create(id);
    // A heading with nothing under it reads as though somebody thought about
    // it and had nothing to say.
    expect(campaign.brief).not.toContain("How we position against it");
    expect(campaign.brief).toContain("The situation:");
  });

  it("binds the linked offer at its signed-off version", async () => {
    const id = await ready();
    const campaign = await create(id);
    expect(campaign.offer_version_id).toBe("99999999-9999-4999-8999-999999999991");
  });

  it("will not bind an unsigned later version", async () => {
    const id = await ready();
    // A draft version 2 exists and nobody has approved it. 210's guard would
    // refuse it, and this picks the signed one rather than finding out.
    await db.exec(`insert into service_offer_versions(id, offer_id, client_id, version)
      values ('99999999-9999-4999-8999-999999999992','${OFFER}','${CLIENT}',2)`);
    const campaign = await create(id);
    expect(campaign.offer_version_id).toBe("99999999-9999-4999-8999-999999999991");
  });

  it("takes a different name when a person gives one", async () => {
    const id = await ready();
    const campaign = await one<{ name: string }>(
      "select * from create_campaign_from_opportunity_v6($1,'paid','meta',$2)",
      [id, "  Winter garage push  "],
    );
    expect(campaign.name).toBe("Winter garage push");
  });
});

describe("the link, from both ends", () => {
  it("records the campaign on the opportunity and the opportunity on the campaign", async () => {
    const id = await ready();
    const campaign = await create(id);

    expect(
      await one<{ role: string; campaign_id: string }>(
        "select role, campaign_id from opportunity_links where role = 'campaign'",
      ),
    ).toMatchObject({ role: "campaign", campaign_id: campaign.id });

    // And the other way, as Campaign Factory reads it: the opportunity as it
    // stands now, not as it stood when the campaign was made.
    const origin = await one<{
      opportunity_name: string;
      opportunity_status: string;
      score: number;
      opportunity_blocker: string | null;
    }>("select * from campaign_origins where campaign_id = $1", [campaign.id]);
    expect(origin).toMatchObject({
      opportunity_name: "Garage-to-Gym Conversion",
      opportunity_status: "approved",
      opportunity_blocker: null,
    });
    expect(Number(origin.score)).toBeGreaterThan(0);

    await db.query(`select set_opportunity_status_v6($1,'paused','The client went quiet.')`, [id]);
    expect(
      await one<{ opportunity_status: string }>(
        "select opportunity_status from campaign_origins where campaign_id = $1",
        [campaign.id],
      ),
    ).toMatchObject({ opportunity_status: "paused" });
  });

  it("says in the opportunity's own history why the campaign exists", async () => {
    const id = await ready();
    await create(id, "paid", "meta");
    const event = await one<{ event: string; actor: string; detail: string }>(
      "select event, actor, detail from opportunity_events order by occurred_at desc limit 1",
    );
    expect(event).toMatchObject({ event: "linked", actor: "human" });
    expect(event.detail).toContain("Campaign created");
    expect(event.detail).toContain("paid meta");
  });
});

describe("pressing the button twice", () => {
  it("returns the campaign it already made rather than making another", async () => {
    const id = await ready();
    const first = await create(id);
    const second = await create(id);
    expect(second.id).toBe(first.id);
    expect(await rows("select 1 from client_campaigns")).toHaveLength(1);
  });

  it("still allows the other route, which is a different campaign", async () => {
    const id = await ready();
    const organic = await create(id);
    const paid = await create(id, "paid", "meta");
    expect(paid.id).not.toBe(organic.id);
    expect(await rows("select 1 from client_campaigns")).toHaveLength(2);
    // Two links, one per campaign, both pointing back at the one reason.
    expect(await rows("select 1 from opportunity_links where role = 'campaign'")).toHaveLength(2);
  });

  it("treats Meta and Google as different campaigns", async () => {
    const id = await ready();
    const meta = await create(id, "paid", "meta");
    const google = await create(id, "paid", "google");
    expect(google.id).not.toBe(meta.id);
  });
});

describe("the grant sweep", () => {
  it("is called by the migration", async () => {
    expect(await sql("20261022110000_232_campaign_from_opportunity.sql")).toContain(
      "select lock_down_definer_functions();",
    );
  });
});
