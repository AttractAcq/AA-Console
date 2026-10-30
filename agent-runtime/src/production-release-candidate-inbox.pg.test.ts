import { PGlite } from "@electric-sql/pglite";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const ADMIN = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const MEMBER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const HEAD = "a".repeat(40);
const BASE = "b".repeat(40);
const HASH = "c".repeat(64);
const CHECK_NAMES = [
  "Agent runtime (typecheck, test, build)",
  "Frontend (lint, typecheck, test, build)",
  "MCP gateway (typecheck, test, build)",
  "Schema replay (clean, upgrade, catalog, types)",
];
let db: PGlite;

const migration = (name: string) =>
  readFile(new URL(`../../supabase/migrations/${name}`, import.meta.url), "utf8");

function candidate(overrides: Record<string, unknown> = {}) {
  return {
    repository: "AttractAcq/AA-Console",
    pr: {
      number: "271",
      url: "https://github.com/AttractAcq/AA-Console/pull/271",
      head_sha: HEAD,
      base_sha: BASE,
      merge_method: "squash",
    },
    checks: CHECK_NAMES.map((name) => ({
      name, head_sha: HEAD, run_id: "41005193831", conclusion: "success",
    })),
    migrations: [{
      version: "20261101040000",
      filename: "20261101040000_287_organic_schedule_route.sql",
      sha256: HASH,
    }],
    schema: { current_head: "20261101033000", target_head: "20261101040000" },
    deployment: {
      browser_pr_head_sha: HEAD,
      runtime_pin_sha: HEAD,
      gateway_pin_sha: HEAD,
      railway_environment_id: "prod-env",
      runtime_service_id: "runtime-svc",
      gateway_service_id: "gateway-svc",
      manifest_sha256: HASH,
    },
    switch_plan: [],
    rollback: { strategy: "forward_fix" },
    ...overrides,
  };
}

function canonical(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean"
    || typeof value === "number") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map((key) =>
    `${JSON.stringify(key)}:${canonical(object[key])}`).join(",")}}`;
}

function packet(source = candidate(), overrides: Record<string, unknown> = {}) {
  const body = {
    schemaVersion: 1,
    kind: "github_premerge_release_evidence",
    repository: { id: 12345, fullName: source.repository },
    pr: {
      number: Number((source.pr as { number: string }).number),
      url: (source.pr as { url: string }).url,
      head: { sha: HEAD, ref: "codex/release", repositoryId: 12345 },
      base: { sha: BASE, ref: "main", repositoryId: 12345 },
    },
    checks: {
      workflowRunId: "41005193831", workflowSha256: HASH,
      required: CHECK_NAMES.map((name, index) => ({
        name, headSha: HEAD, runId: "41005193831", checkRunId: 100 + index,
      })),
    },
    migrations: {
      sourceMarkerHead: (source.schema as { current_head: string }).current_head,
      targetHead: (source.schema as { target_head: string }).target_head,
      pending: source.migrations,
    },
    premergePrHeadSha: HEAD,
    futureDeploymentSha: null,
    productionSchemaVerified: false,
    releaseAuthorized: false,
    ...overrides,
  };
  return { ...body, packetSha256: createHash("sha256").update(canonical(body)).digest("hex") };
}

async function asRole<T extends Record<string, unknown>>(
  role: "authenticated" | "service_role" | "anon",
  userId: string | null,
  aal: "aal1" | "aal2",
  sql: string,
  params: unknown[] = [],
): Promise<T[]> {
  await db.query("select set_config('request.jwt.claim.role',$1,false)", [role]);
  await db.query("select set_config('request.jwt.claim.sub',$1,false)", [userId ?? ""]);
  await db.query("select set_config('test.aal',$1,false)", [aal]);
  await db.exec(`set role ${role}`);
  try {
    return (await db.query<T>(sql, params)).rows;
  } finally {
    await db.exec("reset role");
    await db.exec("select set_config('request.jwt.claim.role','',false)");
    await db.exec("select set_config('request.jwt.claim.sub','',false)");
    await db.exec("select set_config('test.aal','',false)");
  }
}

async function submit(packet: Record<string, unknown>,
  role: "authenticated" | "service_role" | "anon" = "authenticated",
  userId: string | null = ADMIN, aal: "aal1" | "aal2" = "aal2") {
  return (await asRole<{ id: string }>(role, userId, aal,
    "select public.submit_production_release_candidate_v6($1::jsonb,$2::timestamptz) as id",
    [JSON.stringify(packet), new Date(Date.now() + 60 * 60_000).toISOString()],
  ))[0]!.id;
}

async function cloneRequest(sourceId: string, replacementSourceId: string,
  replacementVersion: string | null = null, replacementExpiry: string | null = null,
  replacementArtifactHash: string | null = null) {
  const { rows } = await db.query<{ id: string }>(`
    insert into public.approval_requests_v6 (
      client_id,source_system,source_kind,source_id,source_version,title,
      artifact_hash,preview,destination,account_ref,budget,scope,owner_role,
      expires_at,preview_blocker,owning_path,requested_by,requester_kind,
      requester_ref,requested_at,payload_hash
    ) select
      client_id,source_system,source_kind,$2::text,
      coalesce($3::text,source_version),title,
      coalesce($5::text,artifact_hash),preview,destination,account_ref,budget,scope,owner_role,
      coalesce($4::timestamptz,expires_at),preview_blocker,owning_path,requested_by,requester_kind,
      requester_ref,requested_at,payload_hash
    from public.approval_requests_v6 where source_id=$1
    order by requested_at desc limit 1 returning id
  `, [sourceId, replacementSourceId, replacementVersion,
    replacementExpiry, replacementArtifactHash]);
  return rows[0]!.id;
}

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    create role anon;
    create role authenticated;
    create role service_role bypassrls;
    create schema auth;
    create function auth.uid() returns uuid language sql stable as
      $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
    create function auth.role() returns text language sql stable as
      $$ select nullif(current_setting('request.jwt.claim.role',true),'') $$;
    create function auth.jwt() returns jsonb language sql stable as
      $$ select jsonb_build_object('aal',current_setting('test.aal',true)) $$;
    create table public.clients (id uuid primary key);
    create table public.campaign_action_approvals
      (id uuid primary key, client_id uuid, campaign_id uuid,
       manifest_id uuid, status text, request_hash text);
    create table public.campaign_manifest_versions
      (id uuid primary key, campaign_id uuid, version integer);
    create table public.client_sales_entitlement_requests
      (id uuid primary key, client_id uuid, status text, scope_hash text);
    create table public.client_briefs
      (id uuid primary key, client_id uuid, status text,
       archived_at timestamptz, body_hash text);
    create function public.recruitment_brief_snapshot_hash_v6(
      public.client_briefs) returns text language sql stable as
      $$ select $1.body_hash $$;
    create table public.google_review_replies
      (id uuid primary key, client_id uuid, status text, payload jsonb);
    create function public.google_reply_inbox_payload_v6(
      public.google_review_replies) returns jsonb language sql stable as
      $$ select $1.payload $$;
    create table public.content_slots (
      id uuid primary key, client_id uuid, asset_id uuid,
      platform text, scheduled_at timestamptz, format text, stage text);
    create table public.slot_events
      (id uuid primary key, slot_id uuid, to_stage text, created_at timestamptz);
    create table public.profiles (id uuid primary key, role text not null);
    insert into public.profiles values ('${ADMIN}','admin'),('${MEMBER}','client');
    create function public.current_role_of() returns text language sql stable
      security definer set search_path=public as $$
        select role from public.profiles where id=auth.uid()
      $$;
    create function public.is_admin() returns boolean language sql stable
      security definer set search_path=public as $$
        select coalesce(public.current_role_of()='admin',false)
      $$;
    create function public.active_video_approval_manager(uuid) returns uuid
      language sql stable as $$ select null::uuid $$;
    create function public.lock_down_definer_functions() returns integer
      language sql as $$ select 0 $$;
    grant usage on schema public,auth to authenticated,service_role,anon;
    grant execute on function auth.uid(),auth.role(),auth.jwt(),
      public.current_role_of(),public.is_admin() to authenticated,service_role,anon;
  `);
  for (const name of [
    "20261030110000_273_canonical_approval_ledger.sql",
    "20261030160000_279_approval_class_coverage.sql",
    "20261101050000_288_production_release_candidate_inbox.sql",
  ]) await db.exec(await migration(name));
  // Migration 290 defines this adapter. The focused PGlite fixture does not
  // replay Meta tables, so provide the unrelated branch of the 293 view.
  await db.exec(`create function public.recruitment_meta_build_source_state_v6(uuid)
    returns text language sql stable as $$ select 'unverified'::text $$`);
  await db.exec(await migration(
    "20261101100000_293_trusted_production_release_decision.sql"));
  await db.exec("set timezone='UTC'");
}, 60_000);

afterAll(async () => { await db?.close(); });

describe("production release candidate Inbox migration 288", () => {
  it("requires a provisioned admin at AAL2, even through the granted RPC", async () => {
    await expect(submit(candidate(), "authenticated", MEMBER, "aal2"))
      .rejects.toThrow(/provisioned admin with AAL2/);
    await expect(submit(candidate(), "authenticated", ADMIN, "aal1"))
      .rejects.toThrow(/provisioned admin with AAL2/);
    await expect(submit(candidate(), "service_role", ADMIN, "aal2"))
      .rejects.toThrow(/permission denied|provisioned admin with AAL2/);
    await expect(submit(candidate(), "anon", ADMIN, "aal2"))
      .rejects.toThrow(/permission denied|provisioned admin with AAL2/);
  });

  it("requires the four named successful checks on the exact PR head", async () => {
    const valid = candidate();
    await expect(submit(candidate({ checks: valid.checks.slice(0, 3) })))
      .rejects.toThrow(/four successful checks/);
    await expect(submit(candidate({ checks: valid.checks.map((check, index) =>
      index === 0 ? { ...check, head_sha: BASE } : check) })))
      .rejects.toThrow(/four successful checks/);
    await expect(submit(candidate({ checks: valid.checks.map((check, index) =>
      index === 0 ? { ...check, name: "Unprotected check" } : check) })))
      .rejects.toThrow(/check names/);
    await expect(submit(candidate({ checks: valid.checks.map((check, index) =>
      index === 0 ? { ...check, conclusion: "failure" } : check) })))
      .rejects.toThrow(/four successful checks/);
  });

  it("rejects old, duplicate, unordered and mismatched migration plans", async () => {
    const old = {
      version: "20261101000000", filename: "20261101000000_280_old.sql", sha256: HASH,
    };
    const next = candidate().migrations[0]!;
    await expect(submit(candidate({ migrations: "20261101040000" })))
      .rejects.toThrow(/migrations and schema must have the required shape/);
    await expect(submit(candidate({ migrations: [{ ...next, filename: "287.sql" }] })))
      .rejects.toThrow(/migration plan is incomplete or invalid/);
    await expect(submit(candidate({ migrations: [{ ...next, sha256: "not-a-hash" }] })))
      .rejects.toThrow(/migration plan is incomplete or invalid/);
    await expect(submit(candidate({ migrations: [old, next] })))
      .rejects.toThrow(/versions must be distinct and ordered/);
    await expect(submit(candidate({ migrations: [next, next] })))
      .rejects.toThrow(/versions must be distinct and ordered/);
    await expect(submit(candidate({ migrations: [next, old] })))
      .rejects.toThrow(/versions must be distinct and ordered/);
    await expect(submit(candidate({ schema: {
      current_head: "20261101033000", target_head: "20261101050000",
    } }))).rejects.toThrow(/versions must be distinct and ordered/);
  });

  it("registers only a held agency-wide card and append-only source record", async () => {
    const packet = candidate();
    const id = await submit(packet);
    const [row] = await asRole<{
      id: string; client_id: string | null; source_kind: string; source_version: string;
      status: string; source_state: string; preview_blocker: string | null;
    }>("authenticated", ADMIN, "aal2",
      "select id,client_id,source_kind,source_version,status,source_state,preview_blocker from public.approval_inbox_v6 where source_id=$1",
      [id]);
    expect(row).toMatchObject({
      client_id: null, source_kind: "production_release", status: "source_held",
      source_state: "source_held",
    });
    expect(row!.preview_blocker).toMatch(/not independently attested/);
    expect(row!.source_version).toMatch(/^[0-9a-f]{64}$/);
    // A later evidence attachment must not silently clear this class's
    // separate GitHub, schema, deployment and external-effect blockers.
    await db.query(`
      insert into public.approval_request_evidence_v6 (
        request_id,source_version,evidence_ref,artifact_hash,preview,scope,evidence_hash
      ) values ($1,$2,'test-only-untrusted-attachment',$2,$3::jsonb,
        '{"repository":"AttractAcq/AA-Console"}'::jsonb,$4)
    `, [row!.id, row!.source_version, JSON.stringify(packet), HASH]);
    const [afterEvidence] = await asRole<{ preview_blocker: string | null }>(
      "authenticated", ADMIN, "aal2",
      "select preview_blocker from public.approval_inbox_v6 where id=$1", [row!.id]);
    expect(afterEvidence!.preview_blocker).toMatch(/not independently attested/);
    const hidden = await asRole<{ id: string }>("authenticated", MEMBER, "aal2",
      "select id from public.approval_inbox_v6 where source_id=$1", [id]);
    expect(hidden).toEqual([]);
    const [coverage] = await asRole<{
      revision: number; source_state: string; decision_state: string;
      executor_state: string; overall_status: string;
    }>("authenticated", ADMIN, "aal2",
      "select revision,source_state,decision_state,executor_state,overall_status from public.approval_class_coverage_v6 where class_id=32");
    expect(coverage).toMatchObject({ revision: 3, source_state: "blocked",
      decision_state: "blocked", executor_state: "missing", overall_status: "blocked" });
    await expect(db.query("update public.production_release_candidates_v6 set expires_at=now() where id=$1", [id]))
      .rejects.toThrow(/append-only/);
    await expect(db.query("delete from public.production_release_candidates_v6 where id=$1", [id]))
      .rejects.toThrow(/append-only/);
    await expect(db.query("truncate public.production_release_candidates_v6"))
      .rejects.toThrow(/append-only/);
  });

  it("fails closed when the owning source is missing or its version changes", async () => {
    const sourceId = await submit(candidate({ pr: {
      ...candidate().pr, number: "272",
      url: "https://github.com/AttractAcq/AA-Console/pull/272",
    } }));
    const missingId = await cloneRequest(sourceId,
      "dddddddd-dddd-4ddd-8ddd-dddddddddddd");
    const mismatchId = await cloneRequest(sourceId, sourceId, "d".repeat(64));
    const rows = await asRole<{ id: string; status: string; source_state: string }>(
      "authenticated", ADMIN, "aal2",
      "select id,status,source_state from public.approval_inbox_v6 where id=any($1::uuid[])",
      [[missingId, mismatchId]],
    );
    expect(rows.find((row) => row.id === missingId)).toMatchObject({
      status: "cancelled", source_state: "cancelled",
    });
    expect(rows.find((row) => row.id === mismatchId)).toMatchObject({
      status: "superseded", source_state: "superseded",
    });
  });

  it("shows an expired matching source as expired while retaining its blocker", async () => {
    const sourceId = await submit(candidate({ pr: {
      ...candidate().pr, number: "273",
      url: "https://github.com/AttractAcq/AA-Console/pull/273",
    } }));
    const expiredAt = new Date(Date.now() - 60_000).toISOString();
    const expiredVersion = "e".repeat(64);
    const { rows: sources } = await db.query<{ id: string }>(`
      insert into public.production_release_candidates_v6 (
        candidate,expires_at,version_hash,submitted_by
      ) select candidate,$2::timestamptz,$3,submitted_by
        from public.production_release_candidates_v6 where id=$1 returning id
    `, [sourceId, expiredAt, expiredVersion]);
    const requestId = await cloneRequest(sourceId, sources[0]!.id,
      expiredVersion, expiredAt, expiredVersion);
    const [row] = await asRole<{
      status: string; source_state: string; preview_blocker: string | null;
    }>("authenticated", ADMIN, "aal2",
      "select status,source_state,preview_blocker from public.approval_inbox_v6 where id=$1",
      [requestId]);
    expect(row).toMatchObject({ status: "expired", source_state: "source_held" });
    expect(row!.preview_blocker).toMatch(/not independently attested/);
  });
});

describe("trusted exact-version production release decision migration 293", () => {
  async function submitted(number: string) {
    const source = candidate({ pr: {
      ...candidate().pr, number,
      url: `https://github.com/AttractAcq/AA-Console/pull/${number}`,
    } });
    const sourceId = await submit(source);
    const [card] = await asRole<{ id: string; status: string; source_state: string;
      source_version: string; artifact_hash: string }>(
      "authenticated", ADMIN, "aal2",
      "select id,status,source_state,source_version,artifact_hash from public.approval_inbox_v6 where source_id=$1",
      [sourceId],
    );
    return { source, card: card! };
  }

  async function attest(requestId: string, proof: Record<string, unknown>,
    role: "authenticated" | "service_role" = "service_role") {
    return asRole<{ id: string }>(role, ADMIN, "aal2",
      "select public.record_trusted_production_release_attestation_v6($1,$2::jsonb) as id",
      [requestId, JSON.stringify(proof)]);
  }

  it("keeps an unverified card held and denies browser and Bot proof submission", async () => {
    const { source, card } = await submitted("294");
    expect(card).toMatchObject({ status: "source_held", source_state: "source_held" });
    await expect(attest(card.id, packet(source), "authenticated"))
      .rejects.toThrow(/permission denied|Only the release attester service/);
    const [after] = await asRole<{ status: string; preview_blocker: string }>(
      "authenticated", ADMIN, "aal2",
      "select status,preview_blocker from public.approval_inbox_v6 where id=$1",
      [card.id]);
    expect(after!.status).toBe("source_held");
    expect(after!.preview_blocker).toMatch(/Refresh trusted GitHub evidence/);
  });

  it("rejects forged CI claims, SQL bytes, PR head and packet digest", async () => {
    const { source, card } = await submitted("295");
    const good = packet(source);
    await expect(attest(card.id, { ...good, packetSha256: HASH }))
      .rejects.toThrow(/digest does not match/);
    await expect(attest(card.id, packet(source, { premergePrHeadSha: BASE })))
      .rejects.toThrow(/malformed or overclaims/);
    await expect(attest(card.id, packet(source, { checks: {
      ...(good.checks as Record<string, unknown>), workflowRunId: "41005193832",
    } }))).rejects.toThrow(/CI job differs/);
    await expect(attest(card.id, packet(source, { migrations: {
      ...(good.migrations as Record<string, unknown>), pending: [{
        ...(source.migrations as Array<Record<string, unknown>>)[0], sha256: "d".repeat(64),
      }],
    } }))).rejects.toThrow(/committed SQL differs/);
    await expect(attest(card.id, packet(source, { pr: {
      ...(good.pr as Record<string, unknown>), head: {
        sha: BASE, ref: "codex/release", repositoryId: 12345,
      },
    } }))).rejects.toThrow(/repository or PR/);
  });

  it("binds trusted proof to one exact AAL2 human decision and supports revocation", async () => {
    const { source, card } = await submitted("296");
    const proof = packet(source);
    const [written] = await attest(card.id, proof);
    expect(written!.id).toMatch(/^[0-9a-f-]{36}$/);
    const [ready] = await asRole<{ status: string; source_state: string;
      preview_blocker: string | null; preview: Record<string, unknown> }>(
      "authenticated", ADMIN, "aal2",
      "select status,source_state,preview_blocker,preview from public.approval_inbox_v6 where id=$1",
      [card.id]);
    expect(ready).toMatchObject({ status: "pending", source_state: "pending",
      preview_blocker: null });
    expect((ready!.preview.trusted_github_evidence as { packetSha256: string }).packetSha256)
      .toBe(proof.packetSha256);

    const decision = "select public.decide_production_release_candidate_v6($1,$2,$3,$4,$5) as id";
    const approveArgs = [card.id, card.source_version, card.artifact_hash,
      "approved", null];
    await expect(asRole("authenticated", ADMIN, "aal1", decision, approveArgs))
      .rejects.toThrow(/provisioned admin with AAL2/);
    await expect(asRole("authenticated", MEMBER, "aal2", decision, approveArgs))
      .rejects.toThrow(/provisioned admin with AAL2/);
    await expect(asRole("service_role", ADMIN, "aal2", decision, approveArgs))
      .rejects.toThrow(/permission denied|provisioned admin with AAL2/);
    await expect(asRole("authenticated", ADMIN, "aal2", decision,
      [card.id, "f".repeat(64), card.artifact_hash, "approved", null]))
      .rejects.toThrow(/version changed/);
    await asRole("authenticated", ADMIN, "aal2", decision, approveArgs);
    const [approved] = await asRole<{ status: string }>("authenticated", ADMIN,
      "aal2", "select status from public.approval_inbox_v6 where id=$1", [card.id]);
    expect(approved!.status).toBe("approved");
    await expect(asRole("authenticated", ADMIN, "aal2", decision,
      [card.id, card.source_version, card.artifact_hash, "rejected", "Changed my mind"]))
      .rejects.toThrow(/already been decided/);
    await asRole("authenticated", ADMIN, "aal2", decision,
      [card.id, card.source_version, card.artifact_hash, "revoked", "Superseded plan"]);
    const [revoked] = await asRole<{ status: string }>("authenticated", ADMIN,
      "aal2", "select status from public.approval_inbox_v6 where id=$1", [card.id]);
    expect(revoked!.status).toBe("revoked");
  });

  it("preserves reasoned rejection of a held source and cannot approve it later", async () => {
    const { card } = await submitted("297");
    const decision = "select public.decide_production_release_candidate_v6($1,$2,$3,$4,$5) as id";
    await expect(asRole("authenticated", ADMIN, "aal2", decision,
      [card.id, card.source_version, card.artifact_hash, "approved", null]))
      .rejects.toThrow(/stale, held or expired/);
    await asRole("authenticated", ADMIN, "aal2", decision,
      [card.id, card.source_version, card.artifact_hash, "rejected", "No verified CI"]);
    const [rejected] = await asRole<{ status: string }>("authenticated", ADMIN,
      "aal2", "select status from public.approval_inbox_v6 where id=$1", [card.id]);
    expect(rejected!.status).toBe("rejected");
  });

  it("holds a stale verifier observation until the server refreshes that exact packet", async () => {
    const { source, card } = await submitted("298");
    await attest(card.id, packet(source));
    await db.query(`
      insert into public.production_release_attestations_v6 (
        request_id,source_version,packet,packet_sha256,attested_at
      ) select request_id,source_version,packet,packet_sha256,
          now() - interval '1 hour'
        from public.production_release_attestations_v6
        where request_id=$1 order by event_order desc limit 1
    `, [card.id]);
    const [held] = await asRole<{ status: string; source_state: string }>(
      "authenticated", ADMIN, "aal2",
      "select status,source_state from public.approval_inbox_v6 where id=$1", [card.id]);
    expect(held).toMatchObject({ status: "source_held", source_state: "source_held" });
    await expect(asRole("authenticated", ADMIN, "aal2",
      "select public.decide_production_release_candidate_v6($1,$2,$3,'approved',null)",
      [card.id, card.source_version, card.artifact_hash]))
      .rejects.toThrow(/stale, held or expired/);
    await attest(card.id, packet(source));
    const [ready] = await asRole<{ status: string }>(
      "authenticated", ADMIN, "aal2",
      "select status from public.approval_inbox_v6 where id=$1", [card.id]);
    expect(ready!.status).toBe("pending");
  });
});
