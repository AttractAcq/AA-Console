import { PGlite } from "@electric-sql/pglite";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

/**
 * Migration 313 against real Postgres.
 *
 * page_deploy was the only one of thirty-four approval classes whose executor
 * was reachable without a connected provider account. 237 already gated the
 * write on the exact approved bytes; what was missing was downstream of that.
 * The runtime publishes htmlToPublish(page.html), which injects the sales agent
 * widget, so for any page carrying one the committed bytes are not the approved
 * bytes -- and the executor recorded the approved hash regardless, which the
 * recorder took on trust.
 *
 * So the cases worth having are: that the recorder now checks the claim it used
 * to believe, that it insists on knowing what actually went live, and that the
 * unchecked four-argument function is gone rather than left callable beside it.
 */
let db: PGlite;

const CLIENT = "11111111-1111-4111-8111-111111111111";
const PAGE = "22222222-2222-4222-8222-222222222222";
const REV = "33333333-3333-4333-8333-333333333333";
const REPO = "44444444-4444-4444-8444-444444444444";
const APPROVAL = "55555555-5555-4555-8555-555555555555";

const APPROVED_HTML = "<!doctype html><html><body><h1>Winter offer</h1></body></html>";
const sha = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
const APPROVED = sha(APPROVED_HTML);
/** What actually goes live once the widget is injected at publish time. */
const PUBLISHED = sha(`${APPROVED_HTML}<script src="https://runtime/widget.js"></script>`);

async function one<T = Record<string, unknown>>(q: string, p: unknown[] = []): Promise<T> {
  return (await db.query<T>(q, p)).rows[0]!;
}

const record = (args: {
  rendered?: string; published?: string | null; url?: string; commit?: string;
} = {}) =>
  db.query(
    `select record_campaign_page_published_v6($1, $2, $3, $4, $5) as id`,
    [APPROVAL, args.url ?? "https://site.test/winter.html", args.commit ?? "abc123",
     args.rendered ?? APPROVED,
     args.published === undefined ? PUBLISHED : args.published],
  );

beforeEach(async () => {
  await db?.close();
  db = new PGlite();
  await db.exec(`
 create schema if not exists auth;
 create role authenticated; create role anon; create role service_role;
 create table clients(id uuid primary key);
 create table client_pages(id uuid primary key, client_id uuid not null);
 create table client_page_revisions(id uuid primary key, page_id uuid not null);
 create table client_site_repositories(id uuid primary key, client_id uuid not null);
 create table campaign_action_approvals(id uuid primary key, client_id uuid not null,
   action_key text not null, status text not null);
 create table campaign_page_approval_snapshots(
   approval_id uuid primary key references campaign_action_approvals(id) on delete cascade,
   client_id uuid not null, page_id uuid not null, revision_id uuid not null,
   site_repository_id uuid not null, site_path text not null,
   rendered_html text not null,
   rendered_sha256 text not null check (rendered_sha256 ~ '^[0-9a-f]{64}$'),
   created_at timestamptz not null default now());
 create table campaign_page_publications(
   id uuid primary key default gen_random_uuid(),
   approval_id uuid not null unique references campaign_action_approvals(id) on delete cascade,
   client_id uuid not null, page_id uuid not null, revision_id uuid not null,
   published_url text, commit_sha text, rendered_sha256 text,
   published_at timestamptz not null default now());

 create function auth.role() returns text language sql stable as $a$
   select coalesce(nullif(current_setting('test.role', true), ''), 'service_role') $a$;
 create function lock_down_definer_functions() returns void language plpgsql as $a$
   begin return; end $a$;

 -- 237's version, exactly as production had it: it trusts the caller's hash
 -- and knows nothing about what was committed.
 create function record_campaign_page_published_v6(
   p_approval_id uuid, p_published_url text, p_commit_sha text, p_rendered_sha256 text)
 returns uuid language plpgsql security definer set search_path = pg_catalog, public as $a$
 declare v_snapshot campaign_page_approval_snapshots%rowtype; v_id uuid;
 begin
   if auth.role() <> 'service_role' then
     raise exception 'Only the internal service may record a publication.'; end if;
   select * into v_snapshot from campaign_page_approval_snapshots where approval_id = p_approval_id;
   if not found then raise exception 'That approval has no snapshot.'; end if;
   insert into campaign_page_publications (
     approval_id, client_id, page_id, revision_id, published_url, commit_sha, rendered_sha256)
   values (p_approval_id, v_snapshot.client_id, v_snapshot.page_id, v_snapshot.revision_id,
           p_published_url, btrim(p_commit_sha), p_rendered_sha256)
   on conflict (approval_id) do nothing returning id into v_id;
   if v_id is null then
     select id into v_id from campaign_page_publications where approval_id = p_approval_id; end if;
   return v_id;
 end $a$;

 create table approval_class_coverage_versions_v6(
   class_id integer not null, revision integer not null, class_key text not null,
   title text not null, source_state text, source_evidence text,
   decision_state text, decision_evidence text,
   executor_state text, executor_evidence text, blocker text,
   primary key (class_id, revision));

 insert into clients values ('${CLIENT}');
 insert into client_pages values ('${PAGE}', '${CLIENT}');
 insert into client_page_revisions values ('${REV}', '${PAGE}');
 insert into client_site_repositories values ('${REPO}', '${CLIENT}');
 insert into campaign_action_approvals values ('${APPROVAL}', '${CLIENT}', 'page_deploy', 'approved');
 insert into campaign_page_approval_snapshots
   (approval_id, client_id, page_id, revision_id, site_repository_id, site_path,
    rendered_html, rendered_sha256)
   values ('${APPROVAL}', '${CLIENT}', '${PAGE}', '${REV}', '${REPO}', 'winter.html',
           '${APPROVED_HTML.replaceAll("'", "''")}', '${APPROVED}');
 insert into approval_class_coverage_versions_v6 values
   (19, 1, 'page_deploy', 'Campaign page deployment', 'verified', '274 evidence',
    'verified', '274 decision', 'missing', null,
    'Full HTML is frozen, but the deploy executor has not attested the same version.');
 `);

  await db.exec(
    await readFile(
      new URL("../../supabase/migrations/20261106000000_313_the_deploy_executor_attests_what_went_live.sql",
        import.meta.url), "utf8"),
  );
});

afterAll(async () => { await db?.close(); });

describe("the executor now attests the artefact", () => {
  it("records both hashes, which differ when the widget was injected", async () => {
    await record();
    const got = await one<{ rendered_sha256: string; published_sha256: string }>(
      `select rendered_sha256, published_sha256 from campaign_page_publications`);
    expect(got.rendered_sha256).toBe(APPROVED);
    expect(got.published_sha256).toBe(PUBLISHED);
    // The whole point: what went live is not what was approved, and the row
    // now says so instead of claiming they are the same.
    expect(got.published_sha256).not.toBe(got.rendered_sha256);
  });

  it("records equal hashes for a page with no widget to inject", async () => {
    await record({ published: APPROVED });
    const got = await one<{ rendered_sha256: string; published_sha256: string }>(
      `select rendered_sha256, published_sha256 from campaign_page_publications`);
    expect(got.published_sha256).toBe(got.rendered_sha256);
  });
});

describe("what it now refuses", () => {
  it("refuses a source hash that is not the approved one", async () => {
    // 237 took this on trust. The snapshot was right there.
    await expect(record({ rendered: sha("something else entirely") }))
      .rejects.toThrow(/not the approved version/);
  });

  it("refuses a publication that cannot say what it committed", async () => {
    await expect(record({ published: null }))
      .rejects.toThrow(/must record the hash of the bytes it committed/);
  });

  it("refuses a malformed published hash rather than storing it", async () => {
    await expect(record({ published: "not-a-sha" }))
      .rejects.toThrow(/must record the hash of the bytes it committed/);
  });

  it("refuses anyone who is not the service role", async () => {
    await db.exec(`set test.role = 'authenticated'`);
    await expect(record()).rejects.toThrow(/Only the internal service/);
  });

  it("still refuses an approval with no snapshot", async () => {
    await db.query(`delete from campaign_page_approval_snapshots where approval_id = $1`, [APPROVAL]);
    await expect(record()).rejects.toThrow(/no snapshot/);
  });
});

describe("the old unchecked function", () => {
  it("is gone, not left callable beside the new one", async () => {
    // Adding a defaulted parameter makes an OVERLOAD. Had the four-argument
    // version survived, a caller that kept passing four arguments would have
    // kept every one of the behaviours above -- the unchecked ones.
    const got = await one<{ n: number }>(
      `select count(*)::int as n from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname = 'record_campaign_page_published_v6'`);
    expect(got.n).toBe(1);
    await expect(
      db.query(`select record_campaign_page_published_v6($1, $2, $3, $4)`,
        [APPROVAL, "https://site.test/x.html", "abc", APPROVED]),
    ).rejects.toThrow();
  });
});

describe("the coverage ledger", () => {
  it("records page_deploy's executor as verified, with its evidence", async () => {
    const got = await one<{ executor_state: string; executor_evidence: string; blocker: string | null }>(
      `select executor_state, executor_evidence, blocker
         from approval_class_coverage_versions_v6
        where class_key = 'page_deploy' order by revision desc limit 1`);
    expect(got.executor_state).toBe("verified");
    expect(got.executor_evidence).toMatch(/313 record_campaign_page_published_v6/);
    expect(got.blocker).toBeNull();
  });

  it("keeps revision 1 rather than rewriting history", async () => {
    const got = await one<{ n: number }>(
      `select count(*)::int as n from approval_class_coverage_versions_v6 where class_key = 'page_deploy'`);
    expect(got.n).toBe(2);
  });
});
