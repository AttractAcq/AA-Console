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
import { handleMcpEngineering } from "./engineering-route.js";

const CLIENT = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const PAGE = "33333333-3333-4333-8333-333333333333";
const PAGE_B = "44444444-4444-4444-8444-444444444444";
const JOB = "55555555-5555-4555-8555-555555555555";
const JOB_B = "66666666-6666-4666-8666-666666666666";
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
    // 04 defines client_business_context (table + composite type). Migration 84
    // declares `v_ctx client_business_context` and will fail without it.
    "20260903104724_04_intelligence_and_strategy.sql",
    "20260903104816_05_content_chain_proof_ideas_briefs_media.sql",
    "20260903104850_06_distribution_conversion_leads.sql",
    "20260903104939_07_account_and_admin.sql",
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
    "20260908192515_67_sales_agents.sql",
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
    "20260909020100_72_mcp_cos_orchestration.sql",
    "20260911210000_78_mcp_admin_calendar.sql",
    "20260915120000_84_mcp_sales_agent_factory.sql",
  ])
    await db.exec(await migration(file));
  // Same stub as isolation-rls / economics-route: 79 needs client_campaigns
  // for the FK, but 72_campaign_execution is not in this partial fixture.
  await db.exec(`
    create table if not exists client_campaigns (
      id uuid primary key default gen_random_uuid(),
      client_id uuid not null references clients (id) on delete cascade
    );
  `);
  for (const file of [
    "20260911205529_79_client_marketing_spend.sql",
    "20260915180000_85_mcp_finance_controller.sql",
    "20260915200000_86_mcp_engineering_ops.sql",
  ])
    await db.exec(await migration(file));
}, 60_000);
afterAll(async () => {
  await db?.close();
});
beforeEach(async () => {
  await db.exec(`reset role;
    truncate mcp_bot_clients, agent_job_events, agent_jobs, client_pages,
      clients, profiles, auth.users cascade;
    update mcp_internal.mcp_bots set status = 'active';
    insert into clients (id,name,initials) values ('${CLIENT}','First','FI'),('${OTHER}','Other','OT');
    insert into client_pages (id,client_id,page_type,title,status,published_url,body) values
      ('${PAGE}','${CLIENT}','landing','Harbour Home','approved','https://example.test/h','SECRET BODY'),
      ('${PAGE_B}','${OTHER}','landing','Other Home','draft',null,'OTHER SECRET');
    insert into agent_jobs (id,agent_key,client_id,status,params,cost_usd,error) values
      ('${JOB}','landing_page','${CLIENT}','completed','{"secret":true}',9.99,'SECRET ERR'),
      ('${JOB_B}','landing_page','${OTHER}','queued','{"secret":true}',1.00,'OTHER ERR');
    insert into mcp_bot_clients (bot_id,client_id) values
      ('bot_engineering','${CLIENT}'),
      ('bot_security_devops','${CLIENT}');
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
  } = {},
) {
  const headers = {
    authorization: `Bearer ${SECRET}`,
    "x-aa-bot-id": "bot_engineering",
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
  (req as IncomingMessage).url = `/internal/mcp/engineering/${path}`;
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
  await handleMcpEngineering(
    req,
    res,
    sb,
    options.secret === undefined ? SECRET : options.secret,
  );
  return { status, body: jsonBody, rpc };
}
const key = (k: string) => ({ headers: { "idempotency-key": k } });

describe("Phase 14 Engineering HTTP", () => {
  it("creates, reads and replays an issue without leaking page/job secrets", async () => {
    const made = await call("create-issue", {
      client_id: CLIENT,
      title: "Broken publish",
      notes: null,
    });
    expect(made.status).toBe(200);
    expect(made.body.issue.created_by_bot).toBe("bot_engineering");
    expect(
      (await call("create-issue", {
        client_id: CLIENT,
        title: "Broken publish",
        notes: null,
      })).body.issue,
    ).toEqual(made.body.issue);
    const got = await call("get-issue", {
      client_id: CLIENT,
      issue_id: made.body.issue.id,
    });
    expect(got.body.issue.id).toBe(made.body.issue.id);
    const pages = await call("get-release-status", { client_id: CLIENT });
    expect(pages.status).toBe(200);
    expect(pages.body.pages).toHaveLength(1);
    expect(pages.body.pages[0].id).toBe(PAGE);
    expect(JSON.stringify(pages.body)).not.toMatch(/SECRET/);
    const jobs = await call("get-deployment-status", { client_id: CLIENT });
    expect(jobs.body.jobs).toHaveLength(1);
    expect(jobs.body.jobs[0].id).toBe(JOB);
    expect(JSON.stringify(jobs.body)).not.toMatch(/SECRET|9\.99/);
  });
  it("cross-client get is indistinguishable from missing", async () => {
    const made = await call("create-issue", {
      client_id: CLIENT,
      title: "Scoped",
      notes: null,
    });
    await db.exec(
      `insert into mcp_bot_clients(bot_id,client_id) values('bot_engineering','${OTHER}')`,
    );
    for (const id of [made.body.issue.id, OTHER]) {
      expect(
        (await call("get-issue", { client_id: OTHER, issue_id: id })).status,
      ).toBe(404);
    }
    expect(
      (
        await call("get-release-status", {
          client_id: OTHER,
          page_id: PAGE,
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await call("get-deployment-status", {
          client_id: OTHER,
          job_id: JOB,
        })
      ).status,
    ).toBe(404);
  });
  it("denies ungranted client", async () => {
    expect(
      (await call("get-release-status", { client_id: OTHER })).status,
    ).toBe(403);
    expect(
      (
        await call("create-issue", {
          client_id: OTHER,
          title: "Nope",
          notes: null,
        })
      ).status,
    ).toBe(403);
  });
  it("Security may read status but not create issues", async () => {
    const status = await call("get-release-status", { client_id: CLIENT }, {
      headers: { "x-aa-bot-id": "bot_security_devops" },
    });
    expect(status.status).toBe(200);
    expect(
      (
        await call(
          "create-issue",
          { client_id: CLIENT, title: "Sec write", notes: null },
          { headers: { "x-aa-bot-id": "bot_security_devops" } },
        )
      ).status,
    ).toBe(403);
  });
  it("revoked grant and suspended identity deny replay", async () => {
    await call("create-issue", {
      client_id: CLIENT,
      title: "Replay",
      notes: null,
    });
    await db.exec(`delete from mcp_bot_clients where bot_id='bot_engineering'`);
    expect(
      (
        await call("create-issue", {
          client_id: CLIENT,
          title: "Replay",
          notes: null,
        })
      ).status,
    ).toBe(403);
    await db.exec(
      `insert into mcp_bot_clients(bot_id,client_id) values('bot_engineering','${CLIENT}');
       update mcp_internal.mcp_bots set status='suspended' where bot_id='bot_engineering'`,
    );
    expect(
      (
        await call("create-issue", {
          client_id: CLIENT,
          title: "Replay",
          notes: null,
        })
      ).status,
    ).toBe(403);
  });
  it("changed payload conflicts", async () => {
    await call("create-issue", {
      client_id: CLIENT,
      title: "Original",
      notes: null,
    });
    expect(
      (
        await call("create-issue", {
          client_id: CLIENT,
          title: "Changed",
          notes: null,
        })
      ).status,
    ).toBe(409);
  });
  it("invalid service credential is 401 without invoking RPC", async () => {
    const result = await call(
      "get-release-status",
      { client_id: CLIENT },
      { headers: { authorization: "Bearer invalid-test-only" } },
    );
    expect(result.status).toBe(401);
    expect(result.rpc).not.toHaveBeenCalled();
  });
  for (const patch of [
    { title: "" },
    { title: "x".repeat(201) },
    { notes: 5 },
    { notes: "x".repeat(2001) },
    { client_id: "invalid" },
    { railway_token: "nope" },
  ])
    it(`rejects malformed create ${Object.keys(patch)[0]}`, async () => {
      const result = await call("create-issue", {
        client_id: CLIENT,
        title: "Ok",
        notes: null,
        ...patch,
      });
      expect(result.status).toBe(400);
      expect(result.rpc).not.toHaveBeenCalled();
    });
});
