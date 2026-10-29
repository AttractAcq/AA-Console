import { PGlite } from "@electric-sql/pglite";
import { readFile } from "node:fs/promises";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

/**
 * Migration 246 against a real Postgres.
 *
 * G09 and G10 are both about proof lineage reaching the surfaces 218 left
 * unsupported. The behaviours worth pinning:
 *
 *   an embed placement binds to a revision and a hash, and places only when
 *   that exact revision publishes -- a page regenerated after binding must
 *   not carry proof nobody checked against it
 *
 *   a published post's proof is recorded once, idempotently, and a post with
 *   no proof behind it records nothing rather than erroring
 *
 *   the reason all of this is worth a migration: on the day rights lapse,
 *   the proof is findable on every surface it reached
 */
let db: PGlite;

const CLIENT = "11111111-1111-4111-8111-111111111111";
const OTHER = "99999999-9999-4999-8999-999999999999";
const MANAGER = "55555555-5555-4555-8555-555555555555";
const PROOF = "33333333-3333-4333-8333-333333333333";
const CAMP = "22222222-2222-4222-8222-222222222222";

const sql = (file: string) =>
  readFile(new URL(`../../supabase/migrations/${file}`, import.meta.url), "utf8");

async function rows<T = Record<string, unknown>>(q: string, p: unknown[] = []): Promise<T[]> {
  return (await db.query<T>(q, p)).rows;
}
async function one<T = Record<string, unknown>>(q: string, p: unknown[] = []): Promise<T> {
  return (await rows<T>(q, p))[0]!;
}
/** The stubs read auth.role() from this setting, session-wide. */
async function asService(): Promise<void> {
  await db.query(`select set_config('test.role','service_role',false)`);
}
async function asUser(): Promise<void> {
  await db.query(`select set_config('test.role','authenticated',false)`);
}

async function refusal(q: string, p: unknown[] = []): Promise<string> {
  try { await db.query(q, p); } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
  throw new Error(`Expected a refusal from: ${q}`);
}

/** A placement at a given status, for a given destination. */
async function placement(destination: string, status = "approved"): Promise<string> {
  const { id } = await one<{ id: string }>(
    `insert into proof_placements (client_id, destination_key, source_proof_id, proof_id, status, payload_hash)
     values ($1,$2,$3,$3,'drafted',$4) returning id`,
    [CLIENT, destination, PROOF, `hash-${destination}-${Math.random()}`]);
  // Walk it up through the real transition table rather than inserting at the
  // target status, so the guard is exercised.
  if (status !== "drafted") {
    await db.query(`update proof_placements set status='awaiting_approval' where id=$1`, [id]);
    if (status !== "awaiting_approval") {
      await db.query(`update proof_placements set status='approved' where id=$1`, [id]);
    }
  }
  return id;
}

/** A page with built HTML, and a revision of it. */
async function page(html = "<h1>Proof</h1>"): Promise<{ pageId: string; revisionId: string; hash: string }> {
  const { id: pageId } = await one<{ id: string }>(
    `insert into client_pages (client_id, title, html) values ($1,'Garage conversions',$2) returning id`,
    [CLIENT, html]);
  const { id: revisionId } = await one<{ id: string }>(
    `insert into client_page_revisions (page_id, client_id) values ($1,$2) returning id`,
    [pageId, CLIENT]);
  const { h } = await one<{ h: string }>(
    `select encode(sha256(convert_to($1,'UTF8')),'hex') as h`, [html]);
  return { pageId, revisionId, hash: h };
}

/** Publish a revision, which is what the trigger listens for. */
async function publish(revisionId: string, hash: string, url = "https://example.com/garage") {
  await db.query(
    `insert into campaign_page_publications (client_id, page_id, revision_id, published_url, rendered_sha256)
     select $1, r.page_id, r.id, $3, $4 from client_page_revisions r where r.id = $2`,
    [CLIENT, revisionId, url, hash]);
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

 -- 218's proof tables, in the shapes production has.
 create table client_proof_assets(id uuid primary key, client_id uuid not null,
   title text, proof_type text, media_type text,
   usage_rights text not null default 'not_cleared'
     check (usage_rights in ('approved','restricted','not_cleared')),
   expires_on date);

 create table proof_destinations(
   destination_key text primary key,
   mode text not null check (mode in ('api','embed','assisted','reference')),
   supported boolean not null default false, note text not null);
 insert into proof_destinations values
   ('main_website','embed',false,'x'), ('campaign_landing_page','embed',false,'x'),
   ('seo_geo_content','embed',false,'x'), ('google_business_profile','api',true,'x'),
   ('organic_social','api',false,'x'), ('paid_advertising','api',false,'x'),
   ('sales_conversation','reference',false,'x'), ('email_sms_nurture','reference',false,'x'),
   ('third_party_directory','assisted',true,'x'), ('proposal_quotation','assisted',true,'x');

 create table proof_placements(
   id uuid primary key default gen_random_uuid(), client_id uuid not null,
   destination_key text not null references proof_destinations(destination_key),
   artifact_version_id uuid, proof_id uuid, source_proof_id uuid,
   production_request_id uuid, asset_id uuid, campaign_id uuid,
   payload_hash text not null, approval_id uuid,
   status text not null default 'drafted' check (status in (
     'drafted','awaiting_approval','approved','queued','placing',
     'awaiting_manual_placement','bound','placed','verified','failed','rejected',
     'retraction_required','retracted')),
   external_id text, external_url text,
   bound_revision_id uuid, bound_version_hash text,
   placed_by uuid, attempts integer not null default 0,
   claimed_at timestamptz, lease_until timestamptz, placed_at timestamptz,
   verified_at timestamptz, retracted_at timestamptz, last_error text,
   idempotency_key text, created_by uuid,
   created_at timestamptz not null default now(),
   updated_at timestamptz not null default now());

 create table proof_placement_events(
   id uuid primary key default gen_random_uuid(), placement_id uuid not null,
   client_id uuid not null, kind text not null, detail text,
   created_at timestamptz not null default now());

 create table proof_placement_transitions(from_status text not null, to_status text not null,
   primary key (from_status, to_status));
 insert into proof_placement_transitions values
   ('drafted','awaiting_approval'),('drafted','rejected'),('awaiting_approval','approved'),
   ('awaiting_approval','rejected'),('approved','queued'),('approved','awaiting_manual_placement'),
   ('approved','bound'),('queued','placing'),('placing','placed'),('placing','failed'),
   ('awaiting_manual_placement','placed'),('bound','placed'),('failed','queued'),
   ('failed','rejected'),('placed','verified'),('placed','retracted'),('verified','retracted'),
   ('placed','retraction_required'),('verified','retraction_required'),
   ('approved','retraction_required'),('queued','retraction_required'),
   ('awaiting_manual_placement','retraction_required'),('bound','retraction_required'),
   ('retraction_required','retracted'),('drafted','retraction_required'),
   ('awaiting_approval','retraction_required');

 create function guard_proof_placement_status() returns trigger
 language plpgsql set search_path = pg_catalog, public as $g$
 begin
   if new.status is distinct from old.status
      and not exists (select 1 from public.proof_placement_transitions t
                      where t.from_status = old.status and t.to_status = new.status) then
     raise exception 'A placement cannot go from % to %.', old.status, new.status;
   end if;
   new.updated_at := now();
   return new;
 end $g$;
 create trigger guard_proof_placement_status before update on proof_placements
   for each row execute function guard_proof_placement_status();

 create table client_pages(id uuid primary key default gen_random_uuid(),
   client_id uuid not null, title text, html text);
 create table client_page_revisions(id uuid primary key default gen_random_uuid(),
   page_id uuid not null references client_pages(id), client_id uuid not null);
 create table campaign_page_publications(id uuid primary key default gen_random_uuid(),
   approval_id uuid, client_id uuid not null, page_id uuid not null,
   revision_id uuid not null, published_url text not null, commit_sha text,
   rendered_sha256 text not null, probe_status text,
   published_at timestamptz not null default now());

 create table client_ideas(id uuid primary key default gen_random_uuid(), campaign_id uuid);
 create table client_briefs(id uuid primary key default gen_random_uuid(),
   source_idea_id uuid, proof_asset_id uuid);
 create table client_media_assets(id uuid primary key default gen_random_uuid(), brief_id uuid);
 create table scheduled_posts(id uuid primary key default gen_random_uuid(),
   client_id uuid not null, asset_id uuid, published_at timestamptz, external_url text);
 create table campaign_artifacts(id uuid primary key default gen_random_uuid(),
   campaign_id uuid, asset_id uuid, kind text);
 create table client_campaigns(id uuid primary key, client_id uuid not null);
 create table client_sales_agent_deployments(id uuid primary key default gen_random_uuid(),
   client_id uuid not null, enabled boolean not null default true);

 insert into clients values('${CLIENT}'),('${OTHER}');
 insert into profiles values('${MANAGER}');
 insert into client_proof_assets (id, client_id, title, proof_type, media_type, usage_rights)
   values ('${PROOF}','${CLIENT}','A completed conversion','customer_result','image','approved');
 insert into client_campaigns values('${CAMP}','${CLIENT}');`);

  await db.exec(await sql("20261025110000_246_proof_reaches_the_surfaces_it_was_made_for.sql"));
});

afterAll(async () => { await db?.close(); });

describe("G09 — proof on the client's own pages", () => {
  it("binds an approved embed placement to a revision and its hash", async () => {
    const p = await placement("main_website");
    const { pageId, revisionId, hash } = await page();
    const bound = await one<{ status: string; bound_revision_id: string; bound_version_hash: string }>(
      `select * from bind_proof_placement_to_page_v6($1,$2,$3)`, [p, pageId, revisionId]);
    expect(bound.status).toBe("bound");
    expect(bound.bound_revision_id).toBe(revisionId);
    expect(bound.bound_version_hash).toBe(hash);
  });

  it("refuses to bind a destination that is not embedded in a page", async () => {
    const p = await placement("google_business_profile");
    const { pageId, revisionId } = await page();
    const message = await refusal(
      `select bind_proof_placement_to_page_v6($1,$2,$3)`, [p, pageId, revisionId]);
    expect(message).toContain("Only an embed destination is bound to a page");
  });

  it("refuses to bind a placement nobody approved", async () => {
    const p = await placement("main_website", "awaiting_approval");
    const { pageId, revisionId } = await page();
    const message = await refusal(
      `select bind_proof_placement_to_page_v6($1,$2,$3)`, [p, pageId, revisionId]);
    expect(message).toContain("not approved");
  });

  it("refuses a revision that belongs to another page", async () => {
    const p = await placement("main_website");
    const first = await page();
    const second = await page("<h1>Other</h1>");
    const message = await refusal(
      `select bind_proof_placement_to_page_v6($1,$2,$3)`, [p, first.pageId, second.revisionId]);
    expect(message).toContain("does not belong to that page");
  });

  it("places it when that revision publishes, with the published URL", async () => {
    const p = await placement("campaign_landing_page");
    const { pageId, revisionId, hash } = await page();
    await db.query(`select bind_proof_placement_to_page_v6($1,$2,$3)`, [p, pageId, revisionId]);
    await publish(revisionId, hash, "https://client.example/offer");

    const row = await one<{ status: string; external_url: string; placed_at: string }>(
      `select status, external_url, placed_at from proof_placements where id = $1`, [p]);
    expect(row.status).toBe("placed");
    expect(row.external_url).toBe("https://client.example/offer");
    expect(row.placed_at).toBeTruthy();
  });

  it("leaves it bound when a different revision publishes", async () => {
    const p = await placement("main_website");
    const { pageId, revisionId, hash } = await page();
    await db.query(`select bind_proof_placement_to_page_v6($1,$2,$3)`, [p, pageId, revisionId]);
    const { id: other } = await one<{ id: string }>(
      `insert into client_page_revisions (page_id, client_id) values ($1,$2) returning id`,
      [pageId, CLIENT]);
    await publish(other, hash);
    expect((await one<{ status: string }>(
      `select status from proof_placements where id=$1`, [p])).status).toBe("bound");
  });

  it("does not carry proof onto bytes it was never checked against", async () => {
    const p = await placement("seo_geo_content");
    const { pageId, revisionId } = await page("<h1>Proof</h1>");
    await db.query(`select bind_proof_placement_to_page_v6($1,$2,$3)`, [p, pageId, revisionId]);
    // The page is regenerated after binding: same revision row, different bytes.
    await db.query(`update client_pages set html = '<h1>Regenerated</h1>' where id = $1`, [pageId]);
    const { h } = await one<{ h: string }>(
      `select encode(sha256(convert_to('<h1>Regenerated</h1>','UTF8')),'hex') as h`);
    await publish(revisionId, h);
    expect((await one<{ status: string }>(
      `select status from proof_placements where id=$1`, [p])).status).toBe("bound");
  });
});

describe("G10 — recording where proof already went", () => {
  /** A published post whose asset traces back to proof. */
  async function postWithProof(proof: string | null = PROOF): Promise<string> {
    const { id: idea } = await one<{ id: string }>(
      `insert into client_ideas (campaign_id) values ($1) returning id`, [CAMP]);
    const { id: brief } = await one<{ id: string }>(
      `insert into client_briefs (source_idea_id, proof_asset_id) values ($1,$2) returning id`,
      [idea, proof]);
    const { id: asset } = await one<{ id: string }>(
      `insert into client_media_assets (brief_id) values ($1) returning id`, [brief]);
    const { id: post } = await one<{ id: string }>(
      `insert into scheduled_posts (client_id, asset_id, published_at, external_url)
       values ($1,$2,now(),'https://instagram.com/p/abc') returning id`, [CLIENT, asset]);
    return post;
  }

  it("records a published post's proof as a placed organic_social placement", async () => {
    await asService();
    const post = await postWithProof();
    const { id } = await one<{ id: string }>(
      `select record_proof_placement_for_post_v6($1) as id`, [post]);
    const row = await one<{ status: string; destination_key: string; external_url: string; external_id: string }>(
      `select status, destination_key, external_url, external_id from proof_placements where id=$1`, [id]);
    expect(row.status).toBe("placed");
    expect(row.destination_key).toBe("organic_social");
    expect(row.external_url).toBe("https://instagram.com/p/abc");
    expect(row.external_id).toBe(post);
  });

  it("is idempotent, so a re-run of the publisher does not double-count", async () => {
    await asService();
    const post = await postWithProof();
    const first = await one<{ id: string }>(`select record_proof_placement_for_post_v6($1) as id`, [post]);
    const second = await one<{ id: string }>(`select record_proof_placement_for_post_v6($1) as id`, [post]);
    expect(second.id).toBe(first.id);
    expect(await rows(`select 1 from proof_placements where destination_key='organic_social'`))
      .toHaveLength(1);
  });

  it("records nothing for a post with no proof behind it, and does not error", async () => {
    await asService();
    const post = await postWithProof(null);
    const { id } = await one<{ id: string | null }>(
      `select record_proof_placement_for_post_v6($1) as id`, [post]);
    expect(id).toBeNull();
    expect(await rows(`select 1 from proof_placements`)).toHaveLength(0);
  });

  it("refuses a post that has not published", async () => {
    await asService();
    const { id: asset } = await one<{ id: string }>(
      `insert into client_media_assets (brief_id) values (null) returning id`);
    const { id: post } = await one<{ id: string }>(
      `insert into scheduled_posts (client_id, asset_id, published_at) values ($1,$2,null) returning id`,
      [CLIENT, asset]);
    expect(await refusal(`select record_proof_placement_for_post_v6($1)`, [post]))
      .toContain("has not published");
  });

  it("refuses a browser: recording is the transport's job, not a person's", async () => {
    const post = await postWithProof();
    await asUser();
    expect(await refusal(`select record_proof_placement_for_post_v6($1)`, [post]))
      .toContain("Only the internal service");
  });

  it("records every distinct proof behind a campaign's creative against the ad", async () => {
    await asService();
    const second = "44444444-4444-4444-8444-444444444444";
    await db.query(
      `insert into client_proof_assets (id, client_id, title, media_type, usage_rights)
       values ($1,$2,'A second result','image','approved')`, [second, CLIENT]);
    for (const proof of [PROOF, second, PROOF]) {
      const { id: brief } = await one<{ id: string }>(
        `insert into client_briefs (proof_asset_id) values ($1) returning id`, [proof]);
      const { id: asset } = await one<{ id: string }>(
        `insert into client_media_assets (brief_id) values ($1) returning id`, [brief]);
      await db.query(`insert into campaign_artifacts (campaign_id, asset_id) values ($1,$2)`,
        [CAMP, asset]);
    }
    const { n } = await one<{ n: number }>(
      `select record_proof_placement_for_ad_v6($1,'camp_9','https://facebook.com/ads/camp_9') as n`,
      [CAMP]);
    // Two distinct proofs across three artifacts.
    expect(Number(n)).toBe(2);
    // And re-running adds nothing.
    const again = await one<{ n: number }>(
      `select record_proof_placement_for_ad_v6($1,'camp_9') as n`, [CAMP]);
    expect(Number(again.n)).toBe(2);
  });

  it("will not release proof to a disabled sales agent deployment", async () => {
    const p = await placement("sales_conversation");
    const { id: dep } = await one<{ id: string }>(
      `insert into client_sales_agent_deployments (client_id, enabled) values ($1,false) returning id`,
      [CLIENT]);
    expect(await refusal(`select release_proof_to_sales_agent_v6($1,$2)`, [p, dep]))
      .toContain("disabled");
  });

  it("releases approved proof to an enabled deployment", async () => {
    const p = await placement("sales_conversation");
    const { id: dep } = await one<{ id: string }>(
      `insert into client_sales_agent_deployments (client_id) values ($1) returning id`, [CLIENT]);
    const row = await one<{ status: string; external_id: string }>(
      `select * from release_proof_to_sales_agent_v6($1,$2)`, [p, dep]);
    expect(row.status).toBe("placed");
    expect(row.external_id).toBe(dep);
  });
});

describe("the question on the day rights lapse", () => {
  it("names a proof that is live somewhere with rights that are not approved", async () => {
    await asService();
    const { id: brief } = await one<{ id: string }>(
      `insert into client_briefs (proof_asset_id) values ($1) returning id`, [PROOF]);
    const { id: asset } = await one<{ id: string }>(
      `insert into client_media_assets (brief_id) values ($1) returning id`, [brief]);
    const { id: post } = await one<{ id: string }>(
      `insert into scheduled_posts (client_id, asset_id, published_at, external_url)
       values ($1,$2,now(),'https://instagram.com/p/x') returning id`, [CLIENT, asset]);
    await db.query(`select record_proof_placement_for_post_v6($1)`, [post]);

    // The customer withdraws permission.
    await db.query(`update client_proof_assets set usage_rights='not_cleared' where id=$1`, [PROOF]);

    const row = await one<{ live_placements: number; live_on: string[] | string; problem: string }>(
      `select live_placements, live_on, problem from proof_surface_coverage where proof_asset_id=$1`,
      [PROOF]);
    expect(Number(row.live_placements)).toBe(1);
    expect(String(row.live_on)).toContain("organic_social");
    expect(row.problem).toContain("live somewhere and its rights are not_cleared");
  });

  it("distinguishes bound-but-unpublished from live", async () => {
    const p = await placement("main_website");
    const { pageId, revisionId } = await page();
    await db.query(`select bind_proof_placement_to_page_v6($1,$2,$3)`, [p, pageId, revisionId]);
    const row = await one<{ bound_not_published: number; live_placements: number; problem: string }>(
      `select bound_not_published, live_placements, problem from proof_surface_coverage where proof_asset_id=$1`,
      [PROOF]);
    expect(Number(row.bound_not_published)).toBe(1);
    expect(Number(row.live_placements)).toBe(0);
    expect(row.problem).toContain("has not published");
  });
});
