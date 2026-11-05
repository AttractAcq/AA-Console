import { PGlite } from "@electric-sql/pglite";
import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Migration 312's four archive views against real Postgres.
 *
 * Three of them are the same shape migration 121 established and are worth one
 * case each. The fourth is not: rejected_assets_archive filters on
 * review_status rather than archived_at, and carries the rejection note from
 * client_asset_reviews. That difference is the point of the domain -- the trend
 * is only visible if every rejection appears, not just the ones somebody also
 * archived -- so it gets the most cases.
 */
let db: PGlite;

const CLIENT = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";

async function rows<T = Record<string, unknown>>(q: string, p: unknown[] = []): Promise<T[]> {
  return (await db.query<T>(q, p)).rows;
}
async function one<T = Record<string, unknown>>(q: string, p: unknown[] = []): Promise<T> {
  return (await rows<T>(q, p))[0]!;
}

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
 create role authenticated; create role anon; create role service_role;
 create table clients(id uuid primary key);
 create table client_briefs(id uuid primary key default gen_random_uuid());
 create table opportunity_scores(
   id uuid primary key default gen_random_uuid(),
   opportunity_id uuid not null, client_id uuid not null,
   total integer, classification text, scored_at timestamptz not null default now());
 create table market_opportunities(
   id uuid primary key default gen_random_uuid(),
   client_id uuid not null references clients(id) on delete cascade,
   name text not null, micro_market text, core_problem text, desired_outcome text,
   status text not null default 'draft', confidence text, status_note text,
   created_at timestamptz not null default now());
 create table client_agent_records(
   id uuid primary key default gen_random_uuid(),
   client_id uuid not null references clients(id) on delete cascade,
   domain text not null, item_key text not null, title text, body text,
   period text, display_order integer, status text,
   edited_at timestamptz, created_at timestamptz not null default now());
 create table lead_magnets(
   id uuid primary key default gen_random_uuid(),
   client_id uuid not null references clients(id) on delete cascade,
   name text not null, objective text, audience text, format text,
   campaign_id uuid, archived_at timestamptz,
   created_at timestamptz not null default now());
 create table lead_magnet_versions(
   id uuid primary key default gen_random_uuid(),
   magnet_id uuid not null references lead_magnets(id) on delete cascade,
   client_id uuid not null, version integer);
 create table client_media_assets(
   id uuid primary key default gen_random_uuid(),
   client_id uuid not null references clients(id) on delete cascade,
   brief_id uuid, ref_number integer, media_type text not null default 'image',
   title text, review_status text not null default 'pending', purpose text,
   content_format text, archived_at timestamptz,
   created_at timestamptz not null default now());
 create table client_asset_reviews(
   id uuid primary key default gen_random_uuid(),
   asset_id uuid not null references client_media_assets(id) on delete cascade,
   decision text not null, reason text, reviewed_by uuid,
   created_at timestamptz not null default now());
 create function lock_down_definer_functions() returns void language plpgsql as $a$
   begin return; end $a$;
 insert into clients(id) values ('${CLIENT}'), ('${OTHER}');
 `);

  await db.exec(
    await readFile(
      new URL(
        "../../supabase/migrations/20261105040000_312_the_archive_takes_the_remaining_domains.sql",
        import.meta.url,
      ),
      "utf8",
    ),
  );
});

afterAll(async () => {
  await db?.close();
});

describe("the three hand-archived domains", () => {
  it("shows an archived opportunity with the score it was last given", async () => {
    const r = await one<{ id: string }>(
      `insert into market_opportunities (client_id, name, micro_market, status, archived_at)
       values ($1, 'Winter implants', 'dental', 'shaped', now()) returning id`, [CLIENT]);
    // Two scores: the archive must show the LATEST, not the first.
    await db.query(
      `insert into opportunity_scores (opportunity_id, client_id, total, scored_at)
       values ($1, $2, 41, now() - interval '2 days'), ($1, $2, 68, now())`, [r.id, CLIENT]);
    expect(await one(`select title, kind, score from opportunities_archive where id = $1`, [r.id]))
      .toMatchObject({ title: "Winter implants", kind: "dental", score: 68 });
  });

  it("leaves an unarchived opportunity out", async () => {
    await db.query(
      `insert into market_opportunities (client_id, name, status) values ($1, 'Still live', 'shaped')`,
      [CLIENT]);
    expect(await one(`select count(*)::int as n from opportunities_archive where title = 'Still live'`))
      .toMatchObject({ n: 0 });
  });

  it("counts the words of an archived model, and copes with an empty body", async () => {
    // A gestured-at model and a worked-through one are different things to find
    // in an archive, and nothing else in the row says which.
    await db.query(
      `insert into client_agent_records (client_id, domain, item_key, title, body, archived_at)
       values ($1, 'money_model', 'ladder', 'Money model', 'one two three four five', now()),
              ($1, 'icp', 'primary', 'ICP', '   ', now()),
              ($1, 'icp', 'secondary', null, null, now())`, [CLIENT]);
    const got = await rows<{ title: string; kind: string; words: number }>(
      `select title, kind, words from agent_models_archive order by words desc`);
    expect(got).toEqual([
      { title: "Money model", kind: "money_model", words: 5 },
      { title: "ICP", kind: "icp", words: 0 },
      // Falls back to item_key when a record was never titled.
      { title: "secondary", kind: "icp", words: 0 },
    ]);
  });

  it("counts an archived lead magnet's versions", async () => {
    const m = await one<{ id: string }>(
      `insert into lead_magnets (client_id, name, format, archived_at)
       values ($1, 'Pricing guide', 'pdf', now()) returning id`, [CLIENT]);
    await db.query(
      `insert into lead_magnet_versions (magnet_id, client_id, version)
       values ($1, $2, 1), ($1, $2, 2), ($1, $2, 3)`, [m.id, CLIENT]);
    expect(await one(`select title, kind, versions from lead_magnets_archive where id = $1`, [m.id]))
      .toMatchObject({ title: "Pricing guide", kind: "pdf", versions: 3 });
  });
});

describe("rejected creative, which is not archived by hand", () => {
  const reject = async (title: string | null, reason: string, over: { status?: string } = {}) => {
    const a = await one<{ id: string }>(
      `insert into client_media_assets (client_id, title, ref_number, review_status)
       values ($1, $2, 7, $3) returning id`,
      [CLIENT, title, over.status ?? "rejected"]);
    await db.query(
      `insert into client_asset_reviews (asset_id, decision, reason) values ($1, 'rejected', $2)`,
      [a.id, reason]);
    return a.id;
  };

  it("appears without anybody archiving it, and carries the reason", async () => {
    // The whole point. A trend built only from rejections somebody also
    // remembered to archive is a record of who tidied up.
    const id = await reject("Text card again", "Typography only; no scene.");
    expect(await one(`select title, status, rejection_note, archived_at is not null as filed
                        from rejected_assets_archive where id = $1`, [id]))
      .toMatchObject({
        title: "Text card again", status: "rejected",
        rejection_note: "Typography only; no scene.", filed: true,
      });
  });

  it("is filed at the moment of rejection, not when somebody tidied up", async () => {
    const id = await reject("Dated", "Off brief.");
    await db.query(
      `update client_asset_reviews set created_at = now() - interval '9 days' where asset_id = $1`,
      [id]);
    const got = await one<{ days: number }>(
      `select round(extract(epoch from (now() - archived_at)) / 86400)::int as days
         from rejected_assets_archive where id = $1`, [id]);
    expect(got.days).toBe(9);
  });

  it("shows the latest rejection's reason when an asset was reworked and refused again", async () => {
    const id = await reject("Second pass", "First reason.");
    await db.query(
      `insert into client_asset_reviews (asset_id, decision, reason, created_at)
       values ($1, 'rejected', 'Second reason.', now() + interval '1 hour')`, [id]);
    expect(await one(`select rejection_note from rejected_assets_archive where id = $1`, [id]))
      .toMatchObject({ rejection_note: "Second reason." });
  });

  it("counts every review, not only the rejecting ones", async () => {
    // An asset rejected on the third look is a different story from one
    // refused flat, and the count is the only thing that says so.
    const id = await reject("Third look", "Still not it.");
    await db.query(
      `insert into client_asset_reviews (asset_id, decision, reason)
       values ($1, 'approved', 'Looked fine then.'), ($1, 'rejected', 'Reworked, still no.')`, [id]);
    expect(await one(`select reviews from rejected_assets_archive where id = $1`, [id]))
      .toMatchObject({ reviews: 3 });
  });

  it("leaves approved and pending assets out", async () => {
    await reject("Approved one", "n/a", { status: "approved" });
    await reject("Pending one", "n/a", { status: "pending" });
    expect(await one(
      `select count(*)::int as n from rejected_assets_archive
        where title in ('Approved one', 'Pending one')`)).toMatchObject({ n: 0 });
  });

  it("names an untitled asset by its reference number", async () => {
    const id = await reject(null, "No title on this one.");
    expect(await one(`select title from rejected_assets_archive where id = $1`, [id]))
      .toMatchObject({ title: "Asset 7" });
  });
});
