import { PGlite } from "@electric-sql/pglite";
import { readFile } from "node:fs/promises";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

/**
 * Migration 238 against a real Postgres.
 *
 * The case this exists for is a reprice. A client moves from v2 to v3, every
 * new asset is correct, and something live keeps carrying v2 — a magnet
 * emailed to strangers, a published page. v1 had every binding needed to spot
 * that and none of them joined.
 *
 * So the assertions are: a superseded live surface says so in words, a draft
 * nobody signed off does not make a live version wrong, and a claim whose
 * proof has since expired is reported even though the sign-off that accepted
 * it was valid at the time.
 */
let db: PGlite;

const CLIENT = "11111111-1111-4111-8111-111111111111";
const OFFER = "22222222-2222-4222-8222-222222222222";
const V1 = "33333333-3333-4333-8333-333333333331";
const V2 = "33333333-3333-4333-8333-333333333332";
const V3 = "33333333-3333-4333-8333-333333333333";
const CAMPAIGN = "44444444-4444-4444-8444-444444444444";
const PAGE = "55555555-5555-4555-8555-555555555555";
const MAGNET = "66666666-6666-4666-8666-666666666666";
const PROOF = "77777777-7777-4777-8777-777777777777";
const MANAGER = "88888888-8888-4888-8888-888888888888";

const sql = (file: string) =>
  readFile(new URL(`../../supabase/migrations/${file}`, import.meta.url), "utf8");

async function rows<T = Record<string, unknown>>(q: string, p: unknown[] = []): Promise<T[]> {
  return (await db.query<T>(q, p)).rows;
}
async function one<T = Record<string, unknown>>(q: string, p: unknown[] = []): Promise<T> {
  return (await rows<T>(q, p))[0]!;
}

/** The drift sentence for one surface, or null when it is current. */
async function drift(surface: string): Promise<string | null> {
  const row = await one<{ drift: string | null }>(
    "select drift from offer_version_drift where surface = $1",
    [surface],
  );
  return row?.drift ?? null;
}

beforeEach(async () => {
  db = new PGlite();
  await db.exec(`
 create role authenticated; create role anon; create role service_role;
 create schema auth;
 create function auth.role() returns text language sql as $$select 'authenticated'$$;
 create function auth.uid() returns uuid language sql as $$select '${MANAGER}'::uuid$$;
 create function is_admin() returns boolean language sql as $$select true$$;
 create function active_video_approval_manager(uuid) returns uuid language sql as $$select '${MANAGER}'::uuid$$;
 create function can_access_client(uuid) returns boolean language sql as $$select true$$;

 create table clients(id uuid primary key);
 create table profiles(id uuid primary key);
 create table client_proof_assets(id uuid primary key, client_id uuid, title text,
   usage_rights text, expires_on date, permission_basis text);
 create table service_offers(id uuid primary key, client_id uuid, service_name text,
   unique (id, client_id));
 create table service_offer_versions(id uuid primary key, offer_id uuid, client_id uuid,
   version integer, claims jsonb not null default '[]'::jsonb, unique (id, client_id));
 create table service_offer_signoffs(offer_version_id uuid primary key, client_id uuid);
 create table client_campaigns(id uuid primary key, client_id uuid, name text,
   offer_version_id uuid, archived_at timestamptz, unique (id, client_id));
 create table campaign_manifest_versions(id uuid primary key, campaign_id uuid, client_id uuid,
   version integer);
 create table campaign_manifest_offers(manifest_id uuid primary key, campaign_id uuid,
   client_id uuid, offer_version_id uuid);
 create table client_pages(id uuid primary key, client_id uuid, title text);
 create table campaign_artifacts(campaign_id uuid, client_id uuid, kind text, page_id uuid);
 create table campaign_page_publications(id uuid primary key default gen_random_uuid(),
   page_id uuid, client_id uuid);
 create table lead_magnets(id uuid primary key, client_id uuid, name text,
   offer_version_id uuid, archived_at timestamptz);
 create table lead_magnet_versions(id uuid primary key, magnet_id uuid, client_id uuid);
 create table lead_magnet_approvals(id uuid primary key default gen_random_uuid(),
   magnet_version_id uuid, status text);

 insert into clients values('${CLIENT}');
 insert into profiles values('${MANAGER}');
 insert into service_offers values('${OFFER}','${CLIENT}','Garage conversion');
 insert into client_proof_assets values
   ('${PROOF}','${CLIENT}','Four-day conversion','approved',null,'Written consent');
 insert into service_offer_versions(id, offer_id, client_id, version, claims) values
   ('${V1}','${OFFER}','${CLIENT}',1,'[]'::jsonb),
   ('${V2}','${OFFER}','${CLIENT}',2,
     jsonb_build_array(jsonb_build_object('kind','quantified','text','Dry in four days','proof_asset_id','${PROOF}'))),
   ('${V3}','${OFFER}','${CLIENT}',3,'[]'::jsonb);
 insert into service_offer_signoffs values('${V1}','${CLIENT}'),('${V2}','${CLIENT}');
 insert into client_pages values('${PAGE}','${CLIENT}','Garage survey');`);

  await db.exec(await sql("20261024120000_238_where_each_offer_version_is_live.sql"));
}, 60000);

afterAll(async () => {
  await db?.close();
});

describe("what counts as current", () => {
  it("is the newest signed-off version, not the newest version", async () => {
    // v3 exists and nobody approved it, so v2 is current and a surface
    // carrying v2 is right rather than behind.
    expect(
      await one<{ current_version: number }>("select current_version from offer_current_version"),
    ).toMatchObject({ current_version: 2 });

    await db.exec(
      `insert into client_campaigns values('${CAMPAIGN}','${CLIENT}','Winter push','${V2}',null)`,
    );
    expect(await drift("campaign")).toBeNull();
  });

  it("says nothing is approved copy when no version is signed off", async () => {
    await db.exec("delete from service_offer_signoffs");
    await db.exec(
      `insert into client_campaigns values('${CAMPAIGN}','${CLIENT}','Winter push','${V2}',null)`,
    );
    expect(await drift("campaign")).toContain("No version of this offer has been signed off");
  });
});

describe("the row that earns the tab", () => {
  it("names a live surface still carrying a superseded version", async () => {
    // The reprice case: the magnet was built against v1 and is still live.
    await db.exec(`
      insert into lead_magnets values('${MAGNET}','${CLIENT}','Cost guide','${V1}',null);
      insert into lead_magnet_versions values(gen_random_uuid(),'${MAGNET}','${CLIENT}');
      insert into lead_magnet_approvals(magnet_version_id, status)
        select id, 'approved' from lead_magnet_versions;`);

    const row = await one<{ drift: string; live: boolean; superseded: boolean }>(
      "select drift, live, superseded from offer_version_drift where surface = 'lead_magnet'",
    );
    expect(row.superseded).toBe(true);
    expect(row.live).toBe(true);
    expect(row.drift).toBe("Carrying v1 while v2 is current, and it is live.");
  });

  it("distinguishes a superseded surface that is not live from one that is", async () => {
    await db.exec(`
      insert into lead_magnets values('${MAGNET}','${CLIENT}','Cost guide','${V1}',null);
      insert into lead_magnet_versions values(gen_random_uuid(),'${MAGNET}','${CLIENT}');`);
    // No approval, so nothing is being sent: behind, but not out there.
    const row = await one<{ drift: string; live: boolean }>(
      "select drift, live from offer_version_drift where surface = 'lead_magnet'",
    );
    expect(row.live).toBe(false);
    expect(row.drift).toBe("Carrying v1 while v2 is current.");
  });

  it("calls a published campaign page live, and an unpublished one not", async () => {
    await db.exec(`
      insert into client_campaigns values('${CAMPAIGN}','${CLIENT}','Winter push','${V1}',null);
      insert into campaign_artifacts values('${CAMPAIGN}','${CLIENT}','landing_page','${PAGE}');`);
    expect(
      await one<{ live: boolean }>("select live from offer_version_drift where surface = 'campaign_page'"),
    ).toMatchObject({ live: false });

    await db.exec(
      `insert into campaign_page_publications(page_id, client_id) values('${PAGE}','${CLIENT}')`,
    );
    const row = await one<{ live: boolean; drift: string; label: string }>(
      "select live, drift, label from offer_version_drift where surface = 'campaign_page'",
    );
    expect(row).toMatchObject({ live: true, label: "Garage survey" });
    expect(row.drift).toContain("and it is live");
  });

  it("does not claim a v6 campaign is live, and says why", async () => {
    await db.exec(
      `insert into client_campaigns values('${CAMPAIGN}','${CLIENT}','Winter push','${V1}',null)`,
    );
    const row = await one<{ live: boolean | null; live_note: string }>(
      "select live, live_note from offer_version_drift where surface = 'campaign'",
    );
    // Unknown stays unknown rather than being promoted to a badge.
    expect(row.live).toBeNull();
    expect(row.live_note).toContain("gated elsewhere");
  });

  it("leaves an archived campaign out of it", async () => {
    await db.exec(
      `insert into client_campaigns values('${CAMPAIGN}','${CLIENT}','Old push','${V1}',now())`,
    );
    expect(await rows("select 1 from offer_version_usage")).toHaveLength(0);
  });

  it("covers all four surfaces in one answer", async () => {
    await db.exec(`
      insert into client_campaigns values('${CAMPAIGN}','${CLIENT}','Winter push','${V1}',null);
      insert into campaign_artifacts values('${CAMPAIGN}','${CLIENT}','landing_page','${PAGE}');
      insert into campaign_manifest_versions values('99999999-9999-4999-8999-999999999999','${CAMPAIGN}','${CLIENT}',1);
      insert into campaign_manifest_offers values('99999999-9999-4999-8999-999999999999','${CAMPAIGN}','${CLIENT}','${V1}');
      insert into lead_magnets values('${MAGNET}','${CLIENT}','Cost guide','${V1}',null);`);
    const surfaces = (
      await rows<{ surface: string }>("select surface from offer_version_usage order by surface")
    ).map((r) => r.surface);
    expect(surfaces).toEqual(["campaign", "campaign_page", "lead_magnet", "package"]);
  });
});

describe("claims and what stands behind them", () => {
  it("reports a claim whose proof expired after the sign-off", async () => {
    // The sign-off was valid when it happened. Rights do not ask permission
    // before expiring, and the claim does not know.
    await db.exec("update client_proof_assets set expires_on = current_date - 1");
    const row = await one<{ problem: string; claim_text: string }>(
      "select problem, claim_text from offer_claim_evidence where kind = 'quantified'",
    );
    expect(row.claim_text).toBe("Dry in four days");
    expect(row.problem).toContain("expired on");
  });

  it("reports proof that has been un-cleared, and one that is gone", async () => {
    await db.exec("update client_proof_assets set usage_rights = 'not_cleared'");
    expect(
      await one<{ problem: string }>("select problem from offer_claim_evidence where kind = 'quantified'"),
    ).toMatchObject({ problem: "The proof behind this claim is not cleared." });

    await db.exec("delete from client_proof_assets");
    expect(
      await one<{ problem: string }>("select problem from offer_claim_evidence where kind = 'quantified'"),
    ).toMatchObject({ problem: "The proof behind this claim no longer exists." });
  });

  it("says nothing about a claim that is fine", async () => {
    expect(
      await one<{ problem: string | null; proof_title: string }>(
        "select problem, proof_title from offer_claim_evidence where kind = 'quantified'",
      ),
    ).toMatchObject({ problem: null, proof_title: "Four-day conversion" });
  });
});
