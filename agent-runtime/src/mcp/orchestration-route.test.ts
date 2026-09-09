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
import { handleMcpContent } from "./content-route.js";
import { handleMcpDelivery } from "./delivery-route.js";
import { handleMcpOrchestration } from "./orchestration-route.js";

const CLIENT = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const IDEA = "33333333-3333-4333-8333-333333333333";
const IDEA_B = "44444444-4444-4444-8444-444444444444";
const BRIEF = "55555555-5555-4555-8555-555555555555";
const ASSET = "66666666-6666-4666-8666-666666666666";
const ASSET_B = "77777777-7777-4777-8777-777777777777";
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
    "20260904083559_15_brief_refs_and_job_link.sql",
    "20260903104939_07_account_and_admin.sql",
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
  `);
  for (const file of [
    "20260907190000_56_repurposing.sql",
    "20260908080000_63_mcp_brief_enqueue.sql",
    "20260908080100_64_brief_job_idempotency.sql",
    "20260908190000_65_mcp_bot_auth_registry.sql",
    "20260908200000_66_mcp_domain_rls_bot_isolation.sql",
    "20260908230000_68_mcp_production_manager.sql",
    "20260908240000_69_mcp_phase5_read_rpc_volatile.sql",
    "20260909000000_70_mcp_approval_engine.sql",
    "20260909010000_71_mcp_client_delivery.sql",
    "20260904080405_14_campaigns.sql",
    "20260908240000_69_mcp_phase5_read_rpc_volatile.sql",
  ])
    await db.exec(await migration(file));
  // Minimal ingest schema from migration 32: scheduler/external connectors are out of scope.
  const metrics = await migration(
    "20260905090029_32_metrics_ingest_foundations.sql",
  );
  await db.exec("create table scheduled_posts(id uuid primary key)");
  await db.exec(
    metrics.slice(
      metrics.indexOf("create type metric_surface"),
      metrics.indexOf(
        "-- ---------------------------------------------------------------------------",
      ),
    ),
  );
  await db.exec(await migration("20260909020000_72_mcp_cos_orchestration.sql"));
}, 60_000);
afterAll(async () => {
  await db?.close();
});
beforeEach(async () => {
  await db.exec(`reset role;
    truncate mcp_internal.mcp_content_requests, mcp_brief_requests, mcp_bot_clients,
      client_media_assets, client_briefs, client_ideas, agent_job_events, agent_jobs,
      ref_counters, clients, profiles, auth.users cascade;
    update agents set paused = false, archived_at = null, requires_upstream = '{}';
    update mcp_internal.mcp_bots set status = 'active';
    insert into clients (id,name,initials) values ('${CLIENT}','First','FI'),('${OTHER}','Other','OT');
    insert into client_ideas (id,client_id,title,source,status,strategic_reason)
      values ('${IDEA}','${CLIENT}','A real idea','manual','approved','Say this'),
             ('${IDEA_B}','${OTHER}','Other idea','manual','approved','Secret');
    insert into client_briefs (id,client_id,source_idea_id,title,body,status,hook)
      values ('${BRIEF}','${CLIENT}','${IDEA}','Brief','Body text','draft','A hook');
    insert into client_media_assets (id,client_id,brief_id,media_type,title,storage_path,review_status)
      values ('${ASSET}','${CLIENT}','${BRIEF}','image','Cut','path/a.png','pending'),
             ('${ASSET_B}','${OTHER}',null,'image','Leak','path/b.png','approved');
    insert into mcp_bot_clients (bot_id,client_id) values ('bot_chief_of_staff','${CLIENT}');
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
  path: string,
  body: unknown,
  options: {
    headers?: Record<string, string | undefined>;
    secret?: string | null;
    method?: string;
    handler?: typeof handleMcpContent;
  } = {},
) {
  const headers = {
    authorization: `Bearer ${SECRET}`,
    "x-aa-bot-id": "bot_chief_of_staff",
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
  const handler = options.handler ?? handleMcpOrchestration;
  await handler(
    req,
    res,
    sb,
    options.secret === undefined ? SECRET : options.secret,
  );
  return { status, body: jsonBody, rpc };
}

const path = (s: string) => `/internal/mcp/${s}`;
const task = (
  action: string,
  body: Record<string, unknown> = {},
  key = action,
) =>
  call(
    path(`workflow/${action}`),
    { client_id: CLIENT, ...body },
    { headers: { "idempotency-key": key } },
  );
const readCases = [
  ["workflow/list-tasks", {}],
  ["workflow/get-task", { task_id: ASSET }],
  ["campaign/list", {}],
  ["campaign/get", { campaign_id: IDEA }],
  ["campaign/get-status", { campaign_id: IDEA }],
  ["attribution/get-campaign-performance", { campaign_id: IDEA }],
] as const;
beforeEach(async () => {
  await db.exec(`insert into campaigns(id,client_id,campaign_ref,target_role) values
    ('${IDEA}','${CLIENT}','A','lead'),('${IDEA_B}','${OTHER}','B','secret');
    insert into mcp_internal.mcp_delivery_tasks(id,bot_id,execution_id,request_id,client_id,title)
    values ('${ASSET}','bot_chief_of_staff','seed','seed','${CLIENT}','Task'),
           ('${ASSET_B}','bot_chief_of_staff','other','other','${OTHER}','Secret');`);
});
for (const [route, body] of readCases) {
  it(`${route}: allowed, other-client, revoked and suspended isolation`, async () => {
    expect(
      (await call(path(route), { client_id: CLIENT, ...body })).status,
    ).toBe(200);
    expect(
      (await call(path(route), { client_id: OTHER, ...body })).body.error.code,
    ).toBe("client_forbidden");
    await db.exec("delete from mcp_bot_clients");
    expect(
      (await call(path(route), { client_id: CLIENT, ...body })).body.error.code,
    ).toBe("client_forbidden");
    await db.exec(
      `update mcp_internal.mcp_bots set status='suspended' where bot_id='bot_chief_of_staff'`,
    );
    expect(
      (await call(path(route), { client_id: CLIENT, ...body })).body.error.code,
    ).toBe("bot_not_active");
  });
}
it("durable create, assign, complete, replay and conflict; completion clears delivery plan", async () => {
  const created = await task("create-task", { title: "Follow up" });
  expect(created.status).toBe(200);
  const id = created.body.task.id;
  expect((await task("create-task", { title: "Follow up" })).body.task.id).toBe(
    id,
  );
  expect(
    (await task("create-task", { title: "Different" })).body.error.code,
  ).toBe("idempotency_conflict");
  const assigned = await task("assign-task", {
    task_id: id,
    assignee: "bot_client_delivery",
  });
  expect(assigned.body.task.assignee).toBe("bot_client_delivery");
  expect(
    (
      await task("assign-task", {
        task_id: id,
        assignee: "bot_client_delivery",
      })
    ).body.replayed,
  ).toBe(true);
  expect(
    (await task("assign-task", { task_id: id, assignee: "bot_production" }))
      .body.error.code,
  ).toBe("idempotency_conflict");
  expect(
    (await task("list-tasks")).body.tasks.some((t: any) => t.id === id),
  ).toBe(true);
  const done = await task("complete-task", { task_id: id });
  expect(done.body.task.status).toBe("complete");
  expect((await task("complete-task", { task_id: id })).body.replayed).toBe(
    true,
  );
  expect((await task("get-task", { task_id: id })).body.task.status).toBe(
    "complete",
  );
  const plan = await call(
    "/internal/mcp/delivery/get-plan",
    { client_id: CLIENT },
    { handler: handleMcpDelivery },
  );
  expect(plan.body.plan.some((t: any) => t.id === id)).toBe(false);
  expect(
    (
      await db.query(
        "select count(*)::int n from mcp_internal.mcp_task_mutations",
      )
    ).rows[0],
  ).toEqual({ n: 3 });
});
for (const action of ["create-task", "assign-task", "complete-task"]) {
  it(`${action}: scope and lifecycle denial before mutation including replay`, async () => {
    const body =
      action === "create-task"
        ? { title: "Track" }
        : action === "assign-task"
          ? { task_id: ASSET, assignee: "bot_client_delivery" }
          : { task_id: ASSET };
    expect((await task(action, body)).status).toBe(200);
    expect(
      (await task(action, { ...body, client_id: OTHER })).body.error.code,
    ).toBe("client_forbidden");
    await db.exec("delete from mcp_bot_clients");
    expect((await task(action, body)).body.error.code).toBe("client_forbidden");
    await db.exec(
      `update mcp_internal.mcp_bots set status='suspended' where bot_id='bot_chief_of_staff'`,
    );
    expect((await task(action, body)).body.error.code).toBe("bot_not_active");
  });
}
it("denies cross-client resources for every resource path", async () => {
  for (const action of ["get-task", "assign-task", "complete-task"]) {
    expect(
      (
        await task(action, {
          task_id: ASSET_B,
          ...(action === "assign-task"
            ? { assignee: "bot_client_delivery" }
            : {}),
        })
      ).body.error.code,
    ).toBe("client_mismatch");
  }
  for (const route of [
    "campaign/get",
    "campaign/get-status",
    "attribution/get-campaign-performance",
  ]) {
    expect(
      (await call(path(route), { client_id: CLIENT, campaign_id: IDEA_B })).body
        .error.code,
    ).toBe("client_mismatch");
  }
});
it("paginates tasks and campaigns; only granted client rows", async () => {
  await task("create-task", { title: "Second" });
  const first = await task("list-tasks", { limit: 1 });
  expect(first.body.tasks).toHaveLength(1);
  expect(first.body.next_cursor).toBeTruthy();
  const second = await task("list-tasks", {
    limit: 1,
    after: first.body.next_cursor,
  });
  expect(second.body.tasks).toHaveLength(1);
  expect(second.body.next_cursor).toBeNull();
  expect(
    (
      await call(path("campaign/list"), { client_id: CLIENT })
    ).body.campaigns.map((c: any) => c.id),
  ).toEqual([IDEA]);
});
it("honest metrics exclude other-client mapped rows, account/post rows, organic and raw/spend", async () => {
  const read = () =>
    call(path("attribution/get-campaign-performance"), {
      client_id: CLIENT,
      campaign_id: IDEA,
      start_date: "2026-09-01",
      end_date: "2026-09-09",
    });
  expect((await read()).body.performance).toMatchObject({
    availability: "unknown",
    impressions: null,
  });
  await db.exec(`insert into metrics_daily(client_id,surface,entity_type,external_id,metric_date,campaign_id,impressions,clicks,conversions,spend,raw) values
    ('${CLIENT}','paid','campaign','a','2026-09-09','${IDEA}',100,10,2,999,'{"secret":true}'),
    ('${OTHER}','paid','campaign','b','2026-09-09','${IDEA}',999,999,999,999,null),
    ('${CLIENT}','paid','account','c','2026-09-09','${IDEA}',999,999,999,999,null),
    ('${CLIENT}','organic','campaign','d','2026-09-09','${IDEA}',999,999,999,999,null);`);
  const r = await read();
  expect(r.body.performance).toMatchObject({
    availability: "observed",
    observations: 1,
    impressions: 100,
    clicks: 10,
    conversions: 2,
  });
  expect(JSON.stringify(r.body)).not.toMatch(/secret|spend|revenue/);
});
it("validates malformed requests before RPC and assignees against AA records", async () => {
  for (const [route, body] of [
    ["workflow/create-task", { title: " " }],
    [
      "workflow/assign-task",
      { task_id: ASSET, assignee: "someone@example.com" },
    ],
    ["campaign/get", {}],
    [
      "attribution/get-campaign-performance",
      { campaign_id: IDEA, start_date: "2026-02-30" },
    ],
  ]) {
    const r = await call(path(route as string), {
      client_id: CLIENT,
      ...(body as object),
    });
    expect(r.status).toBe(400);
    expect(r.rpc).not.toHaveBeenCalled();
  }
  expect(
    (await task("assign-task", { task_id: ASSET, assignee: "bot_missing" }))
      .body.error.code,
  ).toBe("invalid_assignee");
  const r = await call(
    path("campaign/list"),
    { client_id: CLIENT },
    { secret: null },
  );
  expect(r.status).toBe(401);
  expect(r.rpc).not.toHaveBeenCalled();
});
it("all new functions volatile, service-role only, and mutation ledger forces RLS", async () => {
  const rows = (
    await db.query<{ signature: string; provolatile: string }>(
      `select oid::regprocedure::text signature,provolatile from pg_proc where proname in ('workflow_task','mcp_workflow_task','campaign_read','mcp_campaign_read')`,
    )
  ).rows;
  expect(rows).toHaveLength(4);
  for (const r of rows) {
    expect(r.provolatile).toBe("v");
    for (const role of ["anon", "authenticated"]) {
      expect(
        (
          await db.query<{ ok: boolean }>(
            "select has_function_privilege($1,$2,'EXECUTE') ok",
            [role, r.signature],
          )
        ).rows[0]?.ok,
      ).toBe(false);
    }
  }
  for (const role of ["anon", "authenticated"]) {
    await db.exec(`set role ${role}`);
    await expect(
      db.query(
        `select public.mcp_workflow_task('bot_chief_of_staff','${CLIENT}','list_tasks')`,
      ),
    ).rejects.toThrow(/permission denied/);
    await expect(
      db.query(
        `select public.mcp_campaign_read('bot_chief_of_staff','${CLIENT}','list')`,
      ),
    ).rejects.toThrow(/permission denied/);
    await db.exec("reset role");
  }
  expect(
    (
      await db.query(
        `select relrowsecurity,relforcerowsecurity from pg_class where oid='mcp_internal.mcp_task_mutations'::regclass`,
      )
    ).rows,
  ).toEqual([{ relrowsecurity: true, relforcerowsecurity: true }]);
});
it("CoS rollup enumerates grants only and reuses Phase 7 operational reads", async () => {
  const list = () =>
    call(
      "/internal/mcp/delivery/list-clients",
      {},
      { handler: handleMcpDelivery },
    );
  expect((await list()).body.clients.map((c: any) => c.id)).toEqual([CLIENT]);
  for (const view of [
    "get-client",
    "get-status",
    "get-blockers",
    "get-next-action",
    "get-client-health",
  ]) {
    expect(
      (
        await call(
          `/internal/mcp/delivery/${view}`,
          { client_id: CLIENT },
          { handler: handleMcpDelivery },
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await call(
          `/internal/mcp/delivery/${view}`,
          { client_id: OTHER },
          { handler: handleMcpDelivery },
        )
      ).body.error.code,
    ).toBe("client_forbidden");
  }
  await db.exec(
    `insert into mcp_bot_clients(bot_id,client_id) values ('bot_chief_of_staff','${OTHER}')`,
  );
  expect((await list()).body.clients.map((c: any) => c.id)).toEqual([
    CLIENT,
    OTHER,
  ]);
  await db.exec(`delete from mcp_bot_clients where client_id='${OTHER}'`);
  expect((await list()).body.clients.map((c: any) => c.id)).toEqual([CLIENT]);
});
it("campaign cursor pages and attribution range reject unbounded scans", async () => {
  await db.exec(
    `insert into campaigns(id,client_id,campaign_ref,target_role) values ('${BRIEF}','${CLIENT}','C','lead')`,
  );
  const first = await call(path("campaign/list"), {
    client_id: CLIENT,
    limit: 1,
  });
  expect(first.body.next_cursor).toBe(IDEA);
  const second = await call(path("campaign/list"), {
    client_id: CLIENT,
    limit: 1,
    after: IDEA,
  });
  expect(second.body.campaigns.map((c: any) => c.id)).toEqual([BRIEF]);
  expect(second.body.next_cursor).toBeNull();
  const r = await call(path("attribution/get-campaign-performance"), {
    client_id: CLIENT,
    campaign_id: IDEA,
    start_date: "2020-01-01",
    end_date: "2026-09-09",
  });
  expect(r.body.error.code).toBe("invalid_request");
});
it("accepts an active AA member label and refuses inactive or arbitrary assignees", async () => {
  await db.exec(
    `insert into team_members(id,category,name,initials) values ('${BRIEF}','editors','Editor','ED')`,
  );
  expect(
    (await task("assign-task", { task_id: ASSET, assignee: `member:${BRIEF}` }))
      .body.task.assignee,
  ).toBe(`member:${BRIEF}`);
  await db.exec(`update team_members set active=false where id='${BRIEF}'`);
  expect(
    (
      await task(
        "assign-task",
        { task_id: ASSET, assignee: `member:${BRIEF}` },
        "inactive",
      )
    ).body.error.code,
  ).toBe("invalid_assignee");
});
