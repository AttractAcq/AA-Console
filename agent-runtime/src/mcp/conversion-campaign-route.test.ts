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
import { handleMcpCampaign } from "./campaign-route.js";
import { handleMcpConversion } from "./conversion-route.js";

const CLIENT = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const PAGE = "33333333-3333-4333-8333-333333333333";
const PAGE_B = "44444444-4444-4444-8444-444444444444";
const CAMP = "55555555-5555-4555-8555-555555555555";
const CAMP_B = "66666666-6666-4666-8666-666666666666";
const FINDING = "77777777-7777-4777-8777-777777777777";
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
  await db.exec(await migration("20260908010000_59_page_html.sql"));
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
    "20260909030000_73_mcp_marketing_director.sql",
    "20260909040000_74_mcp_production_bot_decide.sql",
    "20260909050000_75_mcp_distribution_manager.sql",
    "20260910000000_76_mcp_sales_ops.sql",
    "20260909010000_71_mcp_client_delivery.sql",
    "20260909020000_72_campaign_execution.sql",
    "20260909020100_72_mcp_cos_orchestration.sql",
    "20260911210000_78_mcp_admin_calendar.sql",
    "20260915120000_84_mcp_sales_agent_factory.sql",
    "20260911205529_79_client_marketing_spend.sql",
    "20260915180000_85_mcp_finance_controller.sql",
    "20260915200000_86_mcp_engineering_ops.sql",
    "20260915220000_87_mcp_security_devops.sql",
    "20260913000000_82_page_revisions.sql",
    "20260913010000_83_page_polish_agents.sql",
    "20260916130000_89_mcp_conversion_campaign.sql",
  ])
    await db.exec(await migration(file));
}, 90_000);
afterAll(async () => {
  await db?.close();
});
beforeEach(async () => {
  await db.exec(`reset role;
    truncate mcp_bot_clients, agent_job_events, agent_jobs,
      mcp_internal.mcp_conversion_requests, mcp_internal.mcp_campaign_requests,
      client_page_findings, client_page_revisions, campaign_artifacts,
      client_pages, client_campaigns, client_sales_agents,
      clients, profiles, auth.users cascade;
    update mcp_internal.mcp_bots set status = 'active';
    update agents set paused = false, archived_at = null, requires_upstream = '{}';
    insert into clients (id,name,initials) values ('${CLIENT}','First','FI'),('${OTHER}','Other','OT');
    insert into client_pages (id,client_id,page_type,title,brief,status,html,body,current_revision,published_url) values
      ('${PAGE}','${CLIENT}','landing','Harbour Home','A brief','approved','<html>SECRET</html>','SECRET BODY',1,'https://example.test/h'),
      ('${PAGE_B}','${OTHER}','landing','Other Home','Other brief','draft',null,'OTHER SECRET',null,null);
    insert into client_page_revisions (client_id,page_id,revision_number,html,body,source,summary) values
      ('${CLIENT}','${PAGE}',1,'<html>SECRET</html>','SECRET BODY','initial_generation','Original');
    insert into client_page_findings (id,client_id,page_id,revision_number,category,severity,title,explanation,classification,status) values
      ('${FINDING}','${CLIENT}','${PAGE}',1,'copy','medium','Tighten headline','Do it','FIXABLE','open');
    insert into client_campaigns (id,client_id,name,brief,status,built_at,needs_landing_page) values
      ('${CAMP}','${CLIENT}','Harbour launch','Win winter','planning',now(),true),
      ('${CAMP_B}','${OTHER}','Other launch','Secret','planning',null,false);
    insert into mcp_bot_clients (bot_id,client_id) values
      ('bot_marketing','${CLIENT}'),
      ('bot_chief_of_staff','${CLIENT}'),
      ('bot_client_delivery','${CLIENT}');
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
  domain: "conversion" | "campaign",
  path: string,
  body: unknown,
  options: {
    headers?: Record<string, string | undefined>;
    secret?: string | null;
    method?: string;
    bot?: string;
  } = {},
) {
  const headers = {
    authorization: `Bearer ${SECRET}`,
    "x-aa-bot-id": options.bot ?? (domain === "conversion" ? "bot_marketing" : "bot_chief_of_staff"),
    "x-request-id": "request-1",
    "idempotency-key": "execution-1",
    "content-type": "application/json",
    ...options.headers,
  };
  const req = Readable.from([Buffer.from(JSON.stringify(body))]) as IncomingMessage;
  req.headers = headers;
  req.rawHeaders = Object.entries(headers).flatMap(([k, v]) =>
    v === undefined ? [] : [k, v],
  );
  req.method = options.method ?? "POST";
  (req as IncomingMessage).url = `/internal/mcp/${domain}/${path}`;
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
  const handler = domain === "conversion" ? handleMcpConversion : handleMcpCampaign;
  await handler(
    req,
    res,
    sb,
    options.secret === undefined ? SECRET : options.secret,
  );
  return { status, body: jsonBody, rpc };
}
const key = (k: string) => ({ headers: { "idempotency-key": k } });

describe("Phase 16 Conversion HTTP", () => {
  it("lists and gets pages without HTML, body or secrets", async () => {
    const listed = await call("conversion", "list-pages", { client_id: CLIENT });
    expect(listed.status).toBe(200);
    expect(listed.body.pages).toHaveLength(1);
    expect(listed.body.pages[0].id).toBe(PAGE);
    expect(listed.body.pages[0].html_present).toBe(true);
    expect(JSON.stringify(listed.body)).not.toMatch(/SECRET|<html>/);
    const got = await call("conversion", "get-page", {
      client_id: CLIENT,
      page_id: PAGE,
    });
    expect(got.status).toBe(200);
    expect(got.body.page.id).toBe(PAGE);
    expect(got.body.findings[0].id).toBe(FINDING);
    expect(got.body.revisions).toHaveLength(1);
    expect(JSON.stringify(got.body)).not.toMatch(/SECRET|<html>/);
    const perf = await call("conversion", "get-performance", {
      client_id: CLIENT,
      page_id: PAGE,
    });
    expect(perf.body.findings.open).toBe(1);
    expect(perf.body.metrics.availability).toBe("unknown");
  });

  it("creates a page, queues landing_page, and replays the same key", async () => {
    const made = await call(
      "conversion",
      "create-page",
      { client_id: CLIENT, title: "Winter offer", brief: "Sell the plan" },
      key("create-page"),
    );
    expect(made.status).toBe(202);
    expect(made.body.job_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
    expect(made.body.page.title).toBe("Winter offer");
    const replay = await call(
      "conversion",
      "create-page",
      { client_id: CLIENT, title: "Winter offer", brief: "Sell the plan" },
      key("create-page"),
    );
    expect(replay.status).toBe(200);
    expect(replay.body.page.id).toBe(made.body.page.id);
    expect(replay.body.job_id).toBe(made.body.job_id);
    const jobs = await db.query<{ agent_key: string }>(
      "select agent_key from agent_jobs where id = $1",
      [made.body.job_id],
    );
    expect(jobs.rows[0]?.agent_key).toBe("landing_page");
  });

  it("audits a built page, revises selected findings, reverts append-only", async () => {
    const audit = await call(
      "conversion",
      "audit-page",
      { client_id: CLIENT, page_id: PAGE },
      key("audit"),
    );
    expect(audit.status).toBe(202);
    const revise = await call(
      "conversion",
      "revise-page",
      { client_id: CLIENT, page_id: PAGE, finding_ids: [FINDING] },
      key("revise"),
    );
    expect(revise.status).toBe(202);
    const selected = await db.query<{ status: string }>(
      "select status from client_page_findings where id = $1",
      [FINDING],
    );
    expect(selected.rows[0]?.status).toBe("selected");
    const reverted = await call(
      "conversion",
      "revert-page",
      { client_id: CLIENT, page_id: PAGE, revision_number: 1 },
      key("revert"),
    );
    expect(reverted.status).toBe(200);
    expect(reverted.body.page.current_revision).toBe(2);
    const count = await db.query<{ n: number }>(
      "select count(*)::int n from client_page_revisions where page_id = $1",
      [PAGE],
    );
    expect(count.rows[0]?.n).toBe(2);
  });

  it("request_approval queues Console review and never publishes", async () => {
    const r = await call(
      "conversion",
      "request-approval",
      { client_id: CLIENT, page_id: PAGE, summary: "Please review" },
      key("approve"),
    );
    expect(r.status).toBe(200);
    expect(r.body.queue).toBe("console_page_review");
    expect(r.body.published_url).toBeUndefined();
  });

  it("audit without HTML is invalid_page_status; foreign page is mismatch", async () => {
    const draft = await call(
      "conversion",
      "create-page",
      { client_id: CLIENT, title: "Empty", brief: "No html yet" },
      key("empty"),
    );
    expect(
      (
        await call(
          "conversion",
          "audit-page",
          { client_id: CLIENT, page_id: draft.body.page.id },
          key("audit-empty"),
        )
      ).body.error.code,
    ).toBe("invalid_page_status");
    expect(
      (
        await call("conversion", "get-page", {
          client_id: CLIENT,
          page_id: PAGE_B,
        })
      ).body.error.code,
    ).toBe("client_mismatch");
  });

  it("CoS cannot call conversion; Marketing cannot use another client", async () => {
    expect(
      (
        await call(
          "conversion",
          "list-pages",
          { client_id: CLIENT },
          { bot: "bot_chief_of_staff" },
        )
      ).body.error.code,
    ).toBe("bot_forbidden");
    expect(
      (
        await call("conversion", "list-pages", { client_id: OTHER })
      ).body.error.code,
    ).toBe("client_forbidden");
  });

  it("unauthenticated conversion is 401 before RPC", async () => {
    const r = await call(
      "conversion",
      "list-pages",
      { client_id: CLIENT },
      { secret: null },
    );
    expect(r.status).toBe(401);
    expect(r.rpc).not.toHaveBeenCalled();
  });
});

describe("Phase 16 Campaign Execution HTTP", () => {
  it("lists client_campaigns, not public.campaigns, without leaking other clients", async () => {
    await db.exec(
      `insert into campaigns(id,client_id,campaign_ref,target_role) values
        ('${PAGE}','${CLIENT}','ad-tracker','lead')`,
    );
    const listed = await call("campaign", "list", { client_id: CLIENT });
    expect(listed.status).toBe(200);
    expect(listed.body.projection).toBe("client_campaigns_execution_v1");
    expect(listed.body.campaigns.map((c: any) => c.id)).toEqual([CAMP]);
    expect(listed.body.campaigns[0].name).toBe("Harbour launch");
    const got = await call("campaign", "get", {
      client_id: CLIENT,
      campaign_id: CAMP,
    });
    expect(got.body.campaign.id).toBe(CAMP);
    const status = await call("campaign", "get-status", {
      client_id: CLIENT,
      campaign_id: CAMP,
    });
    expect(status.body.status).toBe("planning");
    const ready = await call("campaign", "get-readiness", {
      client_id: CLIENT,
      campaign_id: CAMP,
    });
    expect(ready.body.ready).toBe(false);
    expect(ready.body.readiness.some((r: any) => r.requirement === "Landing page")).toBe(
      true,
    );
  });

  it("creates, plans, updates and requests launch approval", async () => {
    const made = await call(
      "campaign",
      "create",
      { client_id: CLIENT, name: "Spring", brief: "New season" },
      { bot: "bot_marketing", ...key("camp-create") },
    );
    expect(made.status).toBe(202);
    expect(made.body.campaign.name).toBe("Spring");
    const plan = await call(
      "campaign",
      "plan",
      { client_id: CLIENT, campaign_id: made.body.campaign.id },
      { bot: "bot_marketing", ...key("camp-plan") },
    );
    expect(plan.status).toBe(202);
    const updated = await call(
      "campaign",
      "update",
      {
        client_id: CLIENT,
        campaign_id: made.body.campaign.id,
        name: "Spring renamed",
      },
      { bot: "bot_marketing", ...key("camp-update") },
    );
    expect(updated.status).toBe(200);
    expect(updated.body.campaign.name).toBe("Spring renamed");
    const approval = await call(
      "campaign",
      "request-approval",
      {
        client_id: CLIENT,
        campaign_id: CAMP,
        summary: "Ready for review",
      },
      { bot: "bot_marketing", ...key("camp-approve") },
    );
    expect(approval.body.queue).toBe("console_campaign_launch");
  });

  it("provisions a landing page from a planned campaign and launch refuses unmet readiness", async () => {
    const provisioned = await call(
      "campaign",
      "provision",
      { client_id: CLIENT, campaign_id: CAMP, kind: "landing_page" },
      key("provision"),
    );
    expect(provisioned.status).toBe(200);
    expect(provisioned.body.created[0].created).toBe("landing_page");
    const launch = await call(
      "campaign",
      "launch",
      { client_id: CLIENT, campaign_id: CAMP },
      key("launch"),
    );
    expect(launch.body.error.code).toBe("not_ready");
  });

  it("CDM may read execution campaigns but cannot write", async () => {
    expect(
      (
        await call(
          "campaign",
          "get",
          { client_id: CLIENT, campaign_id: CAMP },
          { bot: "bot_client_delivery" },
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await call(
          "campaign",
          "create",
          { client_id: CLIENT, name: "Nope", brief: "Forbidden" },
          { bot: "bot_client_delivery", ...key("cdm-create") },
        )
      ).body.error.code,
    ).toBe("bot_forbidden");
  });

  it("foreign campaign is mismatch; missing is campaign_not_found", async () => {
    expect(
      (
        await call("campaign", "get", {
          client_id: CLIENT,
          campaign_id: CAMP_B,
        })
      ).body.error.code,
    ).toBe("client_mismatch");
    expect(
      (
        await call("campaign", "get", {
          client_id: CLIENT,
          campaign_id: PAGE,
        })
      ).body.error.code,
    ).toBe("campaign_not_found");
  });

  it("anon and authenticated cannot execute public wrappers", async () => {
    for (const role of ["anon", "authenticated"]) {
      await db.exec(`set role ${role}`);
      await expect(
        db.query(
          `select public.mcp_conversion('bot_marketing','${CLIENT}','list_pages')`,
        ),
      ).rejects.toThrow(/permission denied/);
      await expect(
        db.query(
          `select public.mcp_campaign_execution('bot_chief_of_staff','${CLIENT}','list')`,
        ),
      ).rejects.toThrow(/permission denied/);
      await db.exec("reset role");
    }
  });
});
