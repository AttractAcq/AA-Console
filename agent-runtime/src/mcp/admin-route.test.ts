import { PGlite } from "@electric-sql/pglite";
import { readFile } from "node:fs/promises";
import { Readable } from "node:stream";
import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { handleMcpAdmin } from "./admin-route.js";

const CLIENT = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const LEAD = "33333333-3333-4333-8333-333333333333";
const LEAD_B = "44444444-4444-4444-8444-444444444444";
const AGENT = "55555555-5555-4555-8555-555555555555";
const SECRET = "test-only-service-credential";
let db: PGlite;
const migration = async (file: string) =>
  readFile(
    new URL(`../../../supabase/migrations/${file}`, import.meta.url),
    "utf8",
  );

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    create role anon; create role authenticated; create role service_role bypassrls;
    create schema auth;
    create table auth.users (id uuid primary key, email text, raw_user_meta_data jsonb default '{}');
    create function auth.uid() returns uuid language sql stable as
      $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    create function auth.role() returns text language sql stable as
      $$ select current_setting('request.jwt.claim.role', true) $$;
    grant usage on schema public, auth to authenticated, service_role, anon;
  `);
  for (const file of [
    "20260903104450_01_foundations_roles_clients.sql",
    "20260903104529_02_team_and_operations.sql",
    "20260903104615_03_agent_registry_and_job_queue.sql",
    "20260903104816_05_content_chain_proof_ideas_briefs_media.sql",
    "20260903104850_06_distribution_conversion_leads.sql",
    "20260904080405_14_campaigns.sql",
    "20260904083559_15_brief_refs_and_job_link.sql",
    "20260904203418_23_idea_provenance_fields.sql",
    "20260907170000_55_structured_briefs.sql",
  ])
    await db.exec(await migration(file));
  await db.exec(`
    alter table agents add column archived_at timestamptz;
    alter table agents add column requires_input boolean not null default false;
    alter table agent_jobs add column params jsonb not null default '{}';
    revoke execute on all functions in schema public from public, anon;
    grant execute on function enqueue_agent_job(text,uuid,text,uuid) to authenticated;
    -- Same minimal stand-in as isolation-rls.test.ts: migration 19 is not
    -- loaded by this partial fixture, but 60/67's client-read policies need it.
    create or replace function is_client_user(target uuid)
    returns boolean language sql stable security definer set search_path = public as $$
      select exists (select 1 from client_users cu where cu.user_id = auth.uid() and cu.client_id = target);
    $$;
    revoke execute on function is_client_user(uuid) from anon, public;
    grant execute on function is_client_user(uuid) to authenticated;
  `);
  for (const file of [
    "20260908030000_60_revenue_pipeline.sql",
    "20260908040000_61_lead_operations.sql",
    "20260908220000_67_sales_agents.sql",
    "20260907190000_56_repurposing.sql",
    "20260908080000_63_mcp_brief_enqueue.sql",
    "20260908080100_64_brief_job_idempotency.sql",
    "20260908190000_65_mcp_bot_auth_registry.sql",
    "20260908200000_66_mcp_domain_rls_bot_isolation.sql",
    "20260908230000_68_mcp_production_manager.sql",
    "20260908240000_69_mcp_phase5_read_rpc_volatile.sql",
    "20260909000000_70_mcp_approval_engine.sql",
    "20260909040000_74_mcp_production_bot_decide.sql",
    "20260909050000_75_mcp_distribution_manager.sql",
    "20260910000000_76_mcp_sales_ops.sql",
    "20260909010000_71_mcp_client_delivery.sql",
    "20260909020000_72_mcp_cos_orchestration.sql",
    "20260910120000_78_mcp_admin_calendar.sql",
  ])
    await db.exec(await migration(file));
}, 60_000);
afterAll(async () => {
  await db?.close();
});
beforeEach(async () => {
  await db.exec(`reset role;
    truncate mcp_internal.mcp_pipeline_requests, mcp_bot_clients,
      lead_events, client_leads, sales_agent_conversations, client_sales_agents,
      ref_counters, clients, profiles, auth.users cascade;
    update mcp_internal.mcp_bots set status = 'active';
    insert into clients (id,name,initials) values ('${CLIENT}','First','FI'),('${OTHER}','Other','OT');
    insert into client_leads (id,client_id,name,email,stage) values
      ('${LEAD}','${CLIENT}','Alpha Lead','a@example.com','lead'),
      ('${LEAD_B}','${OTHER}','Other Lead','b@example.com','lead');
    insert into client_sales_agents (id,client_id,name,purpose,status) values
      ('${AGENT}','${CLIENT}','Closer','Qualify and book','live');
    insert into mcp_bot_clients (bot_id,client_id) values ('bot_admin','${CLIENT}');
    select set_config('request.jwt.claim.role','service_role',false);
    select set_config('request.jwt.claim.sub','',false);
  `);
});

function rpcAdapter() {
  const rpc = vi.fn((name: string, p: Record<string, unknown>) => ({
    abortSignal: async () => {
      try {
        const keys = Object.keys(p);
        const named = keys.map((k, i) => `${k} := $${i + 1}`).join(", ");
        const result = await db.query<{ result: unknown }>(
          `select ${name}(${named}) as result`,
          keys.map((k) => p[k]),
        );
        return { data: result.rows[0]?.result, error: null };
      } catch (e) {
        const error = e as { code: string; message: string };
        return {
          data: null,
          error: { code: error.code, message: error.message },
        };
      }
    },
  }));
  return { rpc, sb: { rpc } as unknown as SupabaseClient };
}

async function call(
  handler: typeof handleMcpAdmin,
  path: string,
  body: unknown,
  options: {
    headers?: Record<string, string | undefined>;
    secret?: string | null;
    method?: string;
  } = {},
) {
  const headers = {
    authorization: `Bearer ${SECRET}`,
    "x-aa-bot-id": "bot_admin",
    "x-request-id": "request-1",
    "idempotency-key": "execution-1",
    "content-type": "application/json",
    ...options.headers,
  };
  const req = Readable.from([
    Buffer.from(JSON.stringify(body)),
  ]) as IncomingMessage;
  req.headers = headers;
  req.rawHeaders = Object.entries(headers).flatMap(([k, v]) =>
    v === undefined ? [] : [k, v],
  );
  req.method = options.method ?? "POST";
  (req as IncomingMessage).url = path;
  let status = 0;
  let jsonBody: any;
  const res = Object.assign(new EventEmitter(), {
    writeHead: (code: number) => {
      status = code;
    },
    setHeader: vi.fn(),
    end: (data: string) => {
      jsonBody = JSON.parse(data);
    },
  }) as unknown as ServerResponse;
  const { sb, rpc } = rpcAdapter();
  await handler(
    req,
    res,
    sb,
    options.secret === undefined ? SECRET : options.secret,
  );
  return { status, body: jsonBody, rpc };
}
const admin = (
  path: string,
  body: unknown,
  options?: Parameters<typeof call>[3],
) => call(handleMcpAdmin, `/internal/mcp/admin/${path}`, body, options);
const event = {
  client_id: CLIENT,
  event_type: "meeting",
  title: "Fixture meeting",
  notes: null,
  starts_at: "2026-10-01T10:00:00Z",
  ends_at: "2026-10-01T10:30:00Z",
};
const update = (id: string) => ({
  client_id: CLIENT,
  event_id: id,
  expected_version: 1,
  status: "cancelled",
  title: event.title,
  notes: null,
  starts_at: event.starts_at,
  ends_at: event.ends_at,
});
const key = (k: string) => ({ headers: { "idempotency-key": k } });

it("Admin creates, lists, reads, updates and replays through runtime and real SQL", async () => {
  const made = await admin("create-event", event);
  expect(made.status).toBe(200);
  const id = made.body.event.id;
  expect((await admin("create-event", event)).body.event).toEqual(
    made.body.event,
  );
  expect(
    (await admin("list-events", { client_id: CLIENT })).body.events,
  ).toHaveLength(1);
  expect(
    (await admin("get-event", { client_id: CLIENT, event_id: id })).body.event,
  ).toEqual(made.body.event);
  const changed = await admin("update-event", update(id), key("update-1"));
  expect(changed.status).toBe(200);
  expect(changed.body.event.status).toBe("cancelled");
  expect(changed.body.event.version).toBe(2);
  expect(
    (await admin("update-event", update(id), key("update-1"))).body.event,
  ).toEqual(changed.body.event);
  expect(
    (await admin("update-event", update(id), key("update-2"))).status,
  ).toBe(409);
});
for (const type of ["reminder", "admin"])
  it(`supports ${type} without end time`, async () => {
    const result = await admin("create-event", {
      ...event,
      event_type: type,
      ends_at: null,
    });
    expect(result.status).toBe(200);
    expect(result.body.event.event_type).toBe(type);
  });
it("cross-client get/update and absent IDs are indistinguishable", async () => {
  const made = await admin("create-event", event);
  await db.exec(
    `insert into mcp_bot_clients(bot_id,client_id) values('bot_admin','${OTHER}')`,
  );
  for (const id of [made.body.event.id, OTHER]) {
    const got = await admin("get-event", { client_id: OTHER, event_id: id });
    expect(got.status).toBe(404);
    const changed = await admin(
      "update-event",
      { ...update(id), client_id: OTHER },
      key("foreign"),
    );
    expect(changed.status).toBe(404);
  }
  expect(
    (
      await admin("get-event", {
        client_id: CLIENT,
        event_id: made.body.event.id,
      })
    ).body.event.version,
  ).toBe(1);
});
for (const action of [
  "list-events",
  "get-event",
  "create-event",
  "update-event",
])
  it(`denies ungranted client for ${action}`, async () => {
    const body =
      action === "list-events"
        ? { client_id: OTHER }
        : action === "get-event"
          ? { client_id: OTHER, event_id: LEAD }
          : action === "create-event"
            ? { ...event, client_id: OTHER }
            : { ...update(LEAD), client_id: OTHER };
    expect((await admin(action, body)).status).toBe(403);
  });
it("revoked client grant and suspended identity deny replay", async () => {
  await admin("create-event", event);
  await db.exec(`delete from mcp_bot_clients where bot_id='bot_admin'`);
  expect((await admin("create-event", event)).status).toBe(403);
  await db.exec(
    `insert into mcp_bot_clients(bot_id,client_id) values('bot_admin','${CLIENT}'); update mcp_internal.mcp_bots set status='suspended' where bot_id='bot_admin'`,
  );
  expect((await admin("create-event", event)).status).toBe(403);
});
it("changed payload conflicts and does not duplicate", async () => {
  await admin("create-event", event);
  expect(
    (await admin("create-event", { ...event, title: "changed" })).status,
  ).toBe(409);
  expect(
    (await admin("list-events", { client_id: CLIENT })).body.events,
  ).toHaveLength(1);
});
it("invalid service credential is 401 without invoking RPC", async () => {
  const result = await admin(
    "list-events",
    { client_id: CLIENT },
    { headers: { authorization: "Bearer invalid-test-only" } },
  );
  expect(result.status).toBe(401);
  expect(result.rpc).not.toHaveBeenCalled();
});
it("pagination and due/status filtering are scoped", async () => {
  for (let i = 0; i < 3; i++)
    expect(
      (
        await admin(
          "create-event",
          { ...event, title: `meeting ${i}` },
          key(`create-${i}`),
        )
      ).status,
    ).toBe(200);
  const first = await admin("list-events", { client_id: CLIENT, limit: 2 });
  expect(first.body.events).toHaveLength(2);
  expect(
    (
      await admin("list-events", {
        client_id: CLIENT,
        limit: 2,
        after: first.body.next_cursor,
      })
    ).body.events,
  ).toHaveLength(1);
  expect(
    (
      await admin("list-events", {
        client_id: CLIENT,
        status: "scheduled",
        due_before: "2026-09-01T00:00:00Z",
      })
    ).body.events,
  ).toHaveLength(0);
  expect(
    (await admin("list-events", { client_id: CLIENT, after: OTHER })).status,
  ).toBe(404);
});
for (const patch of [
  { title: "" },
  { title: "x".repeat(201) },
  { notes: 5 },
  { notes: "x".repeat(2001) },
  { event_type: "external" },
  { starts_at: "2026-02-30T10:00:00Z" },
  { starts_at: "2026-10-01T10:00:00" },
  { ends_at: null },
  { ends_at: "2026-10-01T09:00:00Z" },
  { client_id: "invalid" },
  { attendees: [] },
  { created_by_bot: "bot_production" },
  { task_id: OTHER },
])
  it(`rejects malformed create ${Object.keys(patch)[0]} ${JSON.stringify(patch).slice(0, 70)}`, async () => {
    const result = await admin("create-event", { ...event, ...patch });
    expect(result.status).toBe(400);
    expect(result.rpc).not.toHaveBeenCalled();
  });
it("invalid update status and version reject before SQL", async () => {
  for (const patch of [
    { status: "published" },
    { expected_version: 0 },
    { expected_version: "1" },
  ]) {
    const result = await admin("update-event", { ...update(LEAD), ...patch });
    expect(result.status).toBe(400);
    expect(result.rpc).not.toHaveBeenCalled();
  }
});

it("accepts bounded Unicode notes without widening legacy route limits", async () => {
  const result = await admin("create-event", {
    ...event,
    notes: "界".repeat(2000),
  });
  expect(result.status).toBe(200);
  expect(result.body.event.notes).toHaveLength(2000);
});
for (const patch of [
  { event_type: ["meeting"] },
  { starts_at: "2026-10-01T24:00:00Z" },
  { status: ["scheduled"] },
]) {
  it(`rejects coerced enums/invalid clock ${Object.keys(patch)[0]}`, async () => {
    const result = await admin("create-event", { ...event, ...patch });
    expect(result.status).toBe(400);
    expect(result.rpc).not.toHaveBeenCalled();
  });
}
