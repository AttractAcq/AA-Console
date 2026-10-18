import { PGlite } from "@electric-sql/pglite";
import { readFile } from "node:fs/promises";
import { beforeEach, afterAll, describe, expect, it } from "vitest";

/**
 * Migration 218 against a real Postgres.
 *
 * The things worth asserting here are the ones that would be expensive to get
 * wrong in public: placing without an approval, placing under an approval
 * that was given for a different version of the words, placing proof whose
 * permission has since expired, and a rights revocation that leaves live
 * placements standing. Each of those has a test below.
 *
 * The harness stubs what Supabase and earlier migrations provide, in the same
 * shape they provide it — in particular `lock_down_definer_functions`, which
 * the migration calls at the end and which lives in 161.
 */
let db: PGlite;

const CLIENT = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const PROOF = "33333333-3333-4333-8333-333333333333";
const ARTIFACT = "44444444-4444-4444-8444-444444444444";
const MANAGER = "55555555-5555-4555-8555-555555555555";

const migration = () =>
  readFile(
    new URL(
      "../../supabase/migrations/20261019090000_218_proof_distribution_spine.sql",
      import.meta.url,
    ),
    "utf8",
  );

async function rows<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
  return (await db.query<T>(sql, params)).rows;
}
async function one<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T> {
  return (await rows<T>(sql, params))[0]!;
}
/** The blocker sentence for a placement, or null when it would be acted on. */
async function blocker(id: string): Promise<string | null> {
  const row = await one<{ blocker: string | null }>(
    "select blocker from proof_placement_due where placement_id = $1",
    [id],
  );
  return row?.blocker ?? null;
}
async function draft(key: string, over: { client?: string; destination?: string } = {}) {
  return (
    await one<{ id: string }>(
      "select create_proof_placement_v6($1,$2,$3,$4) as id",
      [key, over.client ?? CLIENT, over.destination ?? "third_party_directory", ARTIFACT],
    )
  ).id;
}
/** Draft, ask, and approve in one go: the happy path most tests start from. */
async function approved(key: string, destination = "third_party_directory") {
  const id = await draft(key, { destination });
  const approval = (
    await one<{ id: string }>("select request_proof_placement_approval_v6($1) as id", [id])
  ).id;
  await db.query("select decide_proof_placement_approval_v6($1,true)", [approval]);
  return { id, approval };
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
 create function integration_usable(uuid, text) returns boolean language sql as $$select coalesce(current_setting('test.integration',true),'true')='true'$$;
 -- Migration 161's sweep. Stubbed, because the point of calling it here is
 -- that the migration does call it; what it does is 161's own test.
 create function lock_down_definer_functions() returns integer language sql as $$select 0$$;

 create table clients(id uuid primary key);
 create table profiles(id uuid primary key);
 create table client_campaigns(id uuid primary key, client_id uuid);
 create table client_pages(id uuid primary key, client_id uuid);
 create table client_page_revisions(id uuid primary key, page_id uuid);
 create table campaign_action_approvals(id uuid primary key);
 create table client_engine_settings(client_id uuid primary key references clients(id) on delete cascade,
   enabled boolean not null default false);
 create table client_proof_assets(id uuid primary key, client_id uuid, title text, body text,
   claim text, evidence text, usage_rights text, expires_on date, permission_basis text);
 create table client_briefs(id uuid primary key, client_id uuid, proof_asset_id uuid);
 create table client_media_assets(id uuid primary key, client_id uuid, brief_id uuid,
   review_status text, human_approved_at timestamptz, render_path text, storage_path text);
 create table proof_production_requests(id uuid primary key);
 create table proof_artifact_versions(id uuid primary key, client_id uuid, source_proof_id uuid,
   content_hash text, supported_claim text);
 create table proof_artifact_signoffs(artifact_version_id uuid primary key, client_id uuid);

 insert into clients values('${CLIENT}'),('${OTHER}');
 insert into profiles values('${MANAGER}');
 insert into client_engine_settings(client_id, enabled) values('${CLIENT}', true);
 insert into client_proof_assets values('${PROOF}','${CLIENT}','A real result','body',
   'Cut their response time in half','They said it took half as long','approved',null,'Written consent 2026-02-01');
 insert into proof_artifact_versions values('${ARTIFACT}','${CLIENT}','${PROOF}',
   repeat('a',64),'Cut their response time in half');
 insert into proof_artifact_signoffs values('${ARTIFACT}','${CLIENT}');`);
  await db.exec(await migration());
  // Everything that makes a placement possible, so each test can switch off
  // exactly the one thing it is about.
  await db.exec(`
 update proof_destinations set supported = true;
 insert into client_proof_destinations(client_id, destination_key, enabled)
   select '${CLIENT}', destination_key, true from proof_destinations;
 update client_engine_settings set proof_publishing_enabled = true;`);
}, 60000);

afterAll(async () => {
  await db?.close();
});

describe("what may be placed at all", () => {
  it("refuses proof that is not cleared, is expired, or has no recorded permission", async () => {
    await db.exec("update client_proof_assets set usage_rights = 'not_cleared'");
    await expect(draft("k1")).rejects.toThrow("Clear this proof");

    await db.exec(
      "update client_proof_assets set usage_rights='approved', expires_on = current_date - 1",
    );
    await expect(draft("k2")).rejects.toThrow("Clear this proof");

    await db.exec("update client_proof_assets set expires_on = null, permission_basis = null");
    await expect(draft("k3")).rejects.toThrow("Clear this proof");
  });

  it("refuses another client's proof and an unknown destination", async () => {
    await expect(draft("k4", { client: OTHER })).rejects.toThrow("does not belong to this client");
    await expect(draft("k5", { destination: "carrier_pigeon" })).rejects.toThrow(
      "known destination",
    );
  });

  it("refuses anyone who is neither an admin nor the assigned manager", async () => {
    await db.exec("set test.admin = 'false'");
    await db.exec(`create function active_video_approval_manager_other(uuid) returns uuid
      language sql as $$select null::uuid$$`);
    await db.exec("drop function active_video_approval_manager(uuid) cascade");
    await db.exec(`create function active_video_approval_manager(uuid) returns uuid
      language sql as $$select null::uuid$$`);
    await expect(draft("k6")).rejects.toThrow("admin or assigned client manager");
  });

  it("is idempotent, and will not reuse a key for a different placement", async () => {
    const first = await draft("same-key");
    expect(await draft("same-key")).toEqual(first);
    await expect(draft("same-key", { destination: "proposal_quotation" })).rejects.toThrow(
      "different placement",
    );
    expect(await rows("select 1 from proof_placements")).toHaveLength(1);
  });

  it("requires the artifact's claim sign-off before the placement decision", async () => {
    await db.exec("delete from proof_artifact_signoffs");
    const id = await draft("k7");
    await expect(
      db.query("select request_proof_placement_approval_v6($1)", [id]),
    ).rejects.toThrow("source and claim");
  });
});

describe("the placement decision", () => {
  it("will not let a placement reach a destination without one", async () => {
    const id = await draft("k8");
    expect(await blocker(id)).toBeNull(); // drafted rows are not in the view at all
    expect(await rows("select 1 from proof_placement_due where placement_id = $1", [id]))
      .toHaveLength(0);
    // The move the transitions table exists to forbid.
    await expect(
      db.query("update proof_placements set status = 'placed' where id = $1", [id]),
    ).rejects.toThrow("cannot go from drafted to placed");
  });

  it("invalidates an approval when the payload changes under it", async () => {
    const id = await draft("k9");
    await db.query("select request_proof_placement_approval_v6($1)", [id]);
    await expect(
      db.query("update proof_placements set payload_hash = $1 where id = $2", [
        "b".repeat(64),
        id,
      ]),
    ).rejects.toThrow("Draft a new placement");
  });

  it("records who decided, and why, when it is a no", async () => {
    const id = await draft("k10");
    const approval = (
      await one<{ id: string }>("select request_proof_placement_approval_v6($1) as id", [id])
    ).id;
    await expect(
      db.query("select decide_proof_placement_approval_v6($1,false,null)", [approval]),
    ).rejects.toThrow("why it was rejected");
    await db.query("select decide_proof_placement_approval_v6($1,false,$2)", [
      approval,
      "The customer withdrew the quote.",
    ]);
    const row = await one<{ status: string; decided_by: string; rejection_reason: string }>(
      "select status, decided_by, rejection_reason from proof_placement_approvals where id = $1",
      [approval],
    );
    expect(row.status).toBe("rejected");
    expect(row.decided_by).toBe(MANAGER);
    expect(await one<{ status: string }>(
      "select status from proof_placements where id = $1", [id],
    )).toMatchObject({ status: "rejected" });
  });

  it("sends each mode where it actually waits", async () => {
    const assisted = await approved("k11", "third_party_directory");
    const api = await approved("k12", "google_business_profile");
    const embed = await approved("k13", "main_website");
    const statuses = Object.fromEntries(
      (await rows<{ id: string; status: string }>("select id, status from proof_placements")).map(
        (r) => [r.id, r.status],
      ),
    );
    expect(statuses[assisted.id]).toBe("awaiting_manual_placement");
    expect(statuses[api.id]).toBe("queued");
    expect(statuses[embed.id]).toBe("bound");
  });
});

describe("the one sentence that says why not", () => {
  it("names the single thing that is stopping each placement", async () => {
    const { id } = await approved("k14", "google_business_profile");
    expect(await blocker(id)).toBeNull();

    await db.exec("update client_engine_settings set proof_publishing_enabled = false");
    expect(await blocker(id)).toBe("Proof distribution is off for this client.");
    await db.exec("update client_engine_settings set proof_publishing_enabled = true");

    await db.exec("update client_proof_destinations set enabled = false");
    expect(await blocker(id)).toContain("is not switched on for this client");
    await db.exec("update client_proof_destinations set enabled = true");

    await db.exec("set test.integration = 'false'");
    expect(await blocker(id)).toContain("No usable google_business integration");
    await db.exec("set test.integration = 'true'");

    await db.exec("update proof_destinations set supported = false");
    expect(await blocker(id)).toBe("There is no adapter for Google Business Profile.");
    await db.exec("update proof_destinations set supported = true");

    expect(await blocker(id)).toBeNull();
  });

  it("re-checks rights at placement time, not at request time", async () => {
    const { id } = await approved("k15", "google_business_profile");
    expect(await blocker(id)).toBeNull();
    // Approved in March, expired by July. Nothing was written when the date
    // passed, so the trigger never fired and the approval is still good --
    // the view is the only thing standing between this and a placement.
    await db.exec(`alter table client_proof_assets disable trigger proof_rights_retraction;
      update client_proof_assets set expires_on = current_date - 1 where id = '${PROOF}';
      alter table client_proof_assets enable trigger proof_rights_retraction;`);
    expect(await blocker(id)).toContain("expired on");
    expect(
      await one<{ status: string }>("select status from proof_placement_approvals where placement_id = $1", [id]),
    ).toMatchObject({ status: "approved" });

    // A revocation that IS written goes further: the placement leaves the due
    // set altogether, because it is no longer waiting to go out -- it is
    // waiting to be taken down.
    await db.exec(`update client_proof_assets set usage_rights = 'restricted' where id = '${PROOF}'`);
    expect(await rows("select 1 from proof_placement_due where placement_id = $1", [id])).toHaveLength(0);
    expect(
      await one<{ status: string }>("select status from proof_placements where id = $1", [id]),
    ).toMatchObject({ status: "retraction_required" });
  });

  it("says a non-api destination is somebody else's job rather than pretending it is due", async () => {
    const { id } = await approved("k16", "proposal_quotation");
    expect(await blocker(id)).toBe(
      "This destination is placed by proof_distribution, not by the sweep.",
    );
  });
});

describe("claiming", () => {
  it("is service_role only, and claims only unblocked api work", async () => {
    const { id } = await approved("k17", "google_business_profile");
    await approved("k18", "third_party_directory"); // assisted: never claimed

    await expect(db.query("select * from claim_proof_placements(5)")).rejects.toThrow(
      "internal service",
    );
    await db.exec("set test.role = 'service_role'");
    const claimed = await rows<{ placement_id: string }>("select * from claim_proof_placements(5)");
    expect(claimed.map((c) => c.placement_id)).toEqual([id]);
    expect(
      await one<{ status: string; attempts: number }>(
        "select status, attempts from proof_placements where id = $1",
        [id],
      ),
    ).toMatchObject({ status: "placing", attempts: 1 });

    // A second sweep finds nothing: the row is no longer queued.
    expect(await rows("select * from claim_proof_placements(5)")).toHaveLength(0);
  });

  it("keeps a failure failed unless it is explicitly retryable", async () => {
    const { id } = await approved("k19", "google_business_profile");
    await db.exec("set test.role = 'service_role'");
    await db.query("select * from claim_proof_placements(5)");
    await db.query("select record_proof_placement_failure($1,$2,false)", [id, "Rate limited."]);
    expect(
      await one<{ status: string; last_error: string }>(
        "select status, last_error from proof_placements where id = $1",
        [id],
      ),
    ).toMatchObject({ status: "failed", last_error: "Rate limited." });

    await db.query("select * from claim_proof_placements(5)"); // nothing: failed is not queued
    expect(
      await one<{ status: string }>("select status from proof_placements where id = $1", [id]),
    ).toMatchObject({ status: "failed" });
  });

  it("records what went out, and refuses to record anything that was not claimed", async () => {
    const { id } = await approved("k20", "google_business_profile");
    await db.exec("set test.role = 'service_role'");
    await expect(
      db.query("select record_proof_placed($1,$2,$3)", [id, "ext-1", "https://example.com/p/1"]),
    ).rejects.toThrow("not being placed");
    await db.query("select * from claim_proof_placements(5)");
    await db.query("select record_proof_placed($1,$2,$3)", [id, "ext-1", "https://example.com/p/1"]);
    expect(
      await one<{ status: string; external_url: string }>(
        "select status, external_url from proof_placements where id = $1",
        [id],
      ),
    ).toMatchObject({ status: "placed", external_url: "https://example.com/p/1" });
  });
});

describe("the destinations a person performs", () => {
  it("takes a URL and the person's name, and only for an assisted destination", async () => {
    const assisted = await approved("k21", "third_party_directory");
    const api = await approved("k22", "google_business_profile");

    await expect(
      db.query("select mark_proof_placement_placed_v6($1,$2)", [api.id, "https://example.com"]),
    ).rejects.toThrow("assisted destination");
    await expect(
      db.query("select mark_proof_placement_placed_v6($1,$2)", [assisted.id, "not-a-url"]),
    ).rejects.toThrow("Record the URL");

    await db.query("select mark_proof_placement_placed_v6($1,$2)", [
      assisted.id,
      "https://directory.example.com/listing/9",
    ]);
    expect(
      await one<{ status: string; placed_by: string }>(
        "select status, placed_by from proof_placements where id = $1",
        [assisted.id],
      ),
    ).toMatchObject({ status: "placed", placed_by: MANAGER });
  });
});

describe("rights ending", () => {
  it("flags every live placement of a proof whose permission is revoked", async () => {
    const live = await approved("k23", "third_party_directory");
    await db.query("select mark_proof_placement_placed_v6($1,$2)", [
      live.id,
      "https://directory.example.com/listing/9",
    ]);
    const pending = await approved("k24", "google_business_profile");

    await db.exec(`update client_proof_assets set usage_rights = 'restricted' where id = '${PROOF}'`);

    expect(
      await rows<{ status: string }>(
        "select status from proof_placements where id in ($1,$2) order by id",
        [live.id, pending.id],
      ).then((r) => r.map((x) => x.status)),
    ).toEqual(["retraction_required", "retraction_required"]);
    expect(
      await rows("select 1 from proof_placement_events where event = 'retraction_required'"),
    ).toHaveLength(2);
  });

  it("sweeps placements whose permission simply ran out of calendar", async () => {
    const { id } = await approved("k25", "third_party_directory");
    // A date passing writes no row, so the trigger never fires. Suppressing it
    // here is how that is reproduced: the sweep is the only thing that can
    // notice, which is the whole reason it exists.
    await db.exec(`alter table client_proof_assets disable trigger proof_rights_retraction;
      update client_proof_assets set expires_on = current_date - 1 where id = '${PROOF}';
      alter table client_proof_assets enable trigger proof_rights_retraction;`);
    expect(
      await one<{ status: string }>("select status from proof_placements where id = $1", [id]),
    ).toMatchObject({ status: "awaiting_manual_placement" });
    await db.exec("set test.role = 'service_role'");
    expect(await one<{ sweep_expired_proof_placements: number }>(
      "select sweep_expired_proof_placements()",
    )).toMatchObject({ sweep_expired_proof_placements: 1 });
    expect(
      await one<{ status: string }>("select status from proof_placements where id = $1", [id]),
    ).toMatchObject({ status: "retraction_required" });
  });

  it("keeps the event log append-only", async () => {
    await approved("k26");
    await expect(db.exec("update proof_placement_events set detail = 'changed'")).rejects.toThrow(
      "not edited",
    );
    await expect(db.exec("delete from proof_placement_events")).rejects.toThrow("not edited");
  });
});

describe("the destination list", () => {
  it("carries all ten of the playbook's destinations, each with a mode", async () => {
    const all = await rows<{ destination_key: string; mode: string }>(
      "select destination_key, mode from proof_destinations order by destination_key",
    );
    expect(all).toHaveLength(10);
    expect(new Set(all.map((d) => d.mode))).toEqual(
      new Set(["api", "embed", "assisted", "reference"]),
    );
  });

  it("ships inert: nothing is supported and no client is switched on", async () => {
    // A fresh database, without the beforeEach convenience writes.
    const fresh = new PGlite();
    await fresh.exec(`create role authenticated; create role anon; create role service_role;
      create schema auth;
      create function auth.role() returns text language sql as $$select 'authenticated'$$;
      create function auth.uid() returns uuid language sql as $$select null::uuid$$;
      create function is_admin() returns boolean language sql as $$select true$$;
      create function active_video_approval_manager(uuid) returns uuid language sql as $$select null::uuid$$;
      create function can_access_client(uuid) returns boolean language sql as $$select true$$;
      create function integration_usable(uuid, text) returns boolean language sql as $$select true$$;
      create function lock_down_definer_functions() returns integer language sql as $$select 0$$;
      create table clients(id uuid primary key);
      create table profiles(id uuid primary key);
      create table client_campaigns(id uuid primary key, client_id uuid);
      create table client_pages(id uuid primary key, client_id uuid);
      create table client_page_revisions(id uuid primary key, page_id uuid);
      create table campaign_action_approvals(id uuid primary key);
      create table client_engine_settings(client_id uuid primary key, enabled boolean not null default false);
      create table client_proof_assets(id uuid primary key, client_id uuid, title text, body text,
        claim text, evidence text, usage_rights text, expires_on date, permission_basis text);
      create table client_briefs(id uuid primary key, client_id uuid, proof_asset_id uuid);
      create table client_media_assets(id uuid primary key, client_id uuid, brief_id uuid,
        review_status text, human_approved_at timestamptz, render_path text, storage_path text);
      create table proof_production_requests(id uuid primary key);
      create table proof_artifact_versions(id uuid primary key, client_id uuid, source_proof_id uuid,
        content_hash text, supported_claim text);
      create table proof_artifact_signoffs(artifact_version_id uuid primary key, client_id uuid);`);
    await fresh.exec(await migration());
    expect(
      (await fresh.query("select 1 from proof_destinations where supported")).rows,
    ).toHaveLength(0);
    expect((await fresh.query("select 1 from client_proof_destinations")).rows).toHaveLength(0);
    expect(
      (await fresh.query(
        "select 1 from client_engine_settings where proof_publishing_enabled",
      )).rows,
    ).toHaveLength(0);
    await fresh.close();
  });
});
