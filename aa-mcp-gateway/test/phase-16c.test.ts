import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { AAApiAdapter } from "../src/adapters/aa-api.js";
import { ActionEngine } from "../src/policy/engine.js";
import { Store } from "../src/audit/store.js";
import { registry } from "../src/registry/tools.js";
import { allowed, grants } from "../src/policy/permissions.js";
import { bots } from "../src/shared/types.js";
import { marketingDirector } from "../src/onboarding/marketing-director.js";
import { salesOps } from "../src/onboarding/sales-ops.js";
import { distributionManager } from "../src/onboarding/distribution-manager.js";

const client = "11111111-1111-4111-8111-111111111111";
const page = "33333333-3333-4333-8333-333333333333";
const marketing = { bot: "bot_marketing" as const, clients: [client] };
const sales = { bot: "bot_sales_ops" as const, clients: [client] };
const production = { bot: "bot_production" as const, clients: [client] };
const engineering = { bot: "bot_engineering" as const, clients: [client] };

const emptyFunnel = {
  client_id: client,
  projection: "acquisition_funnel_v1",
  days: 30,
  funnel: {
    leads: 0,
    conversations: 0,
    appointments: 0,
    sales: 0,
    lost: 0,
    pipeline_value: 0,
    sale_value: 0,
    cash_collected: 0,
    spend: 0,
    lead_to_sale_pct: null,
    cost_per_lead: null,
    return_on_spend: null,
  },
};

async function mockAa(
  t: { after: (fn: () => Promise<void> | void) => void },
  handler: (req: { url?: string; body: any }) => { status: number; body: unknown },
) {
  const received: { url?: string; method?: string; body: any }[] = [];
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : {};
    received.push({ url: req.url, method: req.method, body });
    const result = handler({ url: req.url, body });
    res.writeHead(result.status, { "content-type": "application/json" });
    res.end(JSON.stringify(result.body));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  });
  return {
    received,
    adapter: new AAApiAdapter({
      url: `http://127.0.0.1:${(server.address() as any).port}`,
      token: "service-secret",
      timeoutMs: 1000,
    }),
  };
}

test("Phase 16c: registry is 103 post-A+B+C; funnel/content/brand/sites are real; generate_report stays stub", () => {
  assert.equal(registry.length, 103);
  for (const name of [
    "attribution.get_conversion_funnel",
    "attribution.get_content_performance",
    "brand.get_profile",
    "sites.provision",
    "sites.publish_page",
  ]) {
    const tool = registry.find((x) => x.name === name)!;
    assert.equal(tool.implementation, "real", name);
  }
  assert.equal(registry.find((x) => x.name === "attribution.generate_report")?.implementation, "stub");
  assert.equal(registry.find((x) => x.name === "attribution.get_revenue_attribution")?.implementation, "real");
  const publish = registry.find((x) => x.name === "sites.publish_page")!;
  assert.equal(publish.risk, "HIGH");
  assert.equal(publish.approval, true);
  assert.equal(publish.reversible, false);
  const provision = registry.find((x) => x.name === "sites.provision")!;
  assert.equal(provision.risk, "HIGH");
  assert.equal(provision.approval, true);
  assert.equal(provision.reversible, false);
  assert.equal(registry.find((x) => x.name === "campaign.provision")?.approval, false);
  assert.equal(marketingDirector.reads.length, 22);
  assert.equal(marketingDirector.writes.length, 23);
  assert.equal(marketingDirector.grants.length, 45);
  assert.equal(marketingDirector.expectedDiscovery.length, 45);
  assert.equal(salesOps.grants.length, 28);
  assert.equal(distributionManager.reads.length, 7);
  assert.equal(distributionManager.stubs.length, 1);
  for (const name of [
    "conversion.audit_page",
    "conversion.revise_page",
    "conversion.revert_page",
    "campaign.plan",
    "campaign.launch",
    "campaign.get_readiness",
    "sales_agents.attach_to_page",
    "sales_agents.set_deployment_enabled",
    "sales_agents.build",
  ]) {
    assert.ok(registry.some((x) => x.name === name), name);
  }
});

test("Phase 16c: Marketing/Sales Ops/Production brand reads; sites only Marketing/Sales Ops", () => {
  const brand = registry.find((x) => x.name === "brand.get_profile")!;
  const provision = registry.find((x) => x.name === "sites.provision")!;
  const publish = registry.find((x) => x.name === "sites.publish_page")!;
  assert.equal(allowed(marketing, brand), true);
  assert.equal(allowed(sales, brand), true);
  assert.equal(allowed(production, brand), true);
  assert.equal(allowed(marketing, provision), true);
  assert.equal(allowed(sales, publish), true);
  assert.equal(allowed(production, provision), false);
  assert.equal(allowed(engineering, provision), false);
  assert.equal(allowed(engineering, brand), false);
  for (const bot of bots.filter((b) => !["bot_marketing", "bot_sales_ops"].includes(b))) {
    assert.equal(
      allowed(
        { bot, clients: [client], permissions: ["sites.*", "brand.*"] },
        provision,
      ),
      false,
      bot,
    );
  }
  assert.ok(!grants.bot_engineering.includes("sites.provision"));
  assert.ok(!grants.bot_engineering.some((g) => g.startsWith("sites")));
});

test("Phase 16c: CoS discovers realized attribution reads and is denied brand/sites", () => {
  const engine = new ActionEngine(new Store(":memory:"), registry, new AAApiAdapter());
  const names = engine.discover({ bot: "bot_chief_of_staff", clients: [client] }).map((t) => t.name);
  assert.ok(names.includes("attribution.get_conversion_funnel"));
  assert.ok(names.includes("attribution.get_content_performance"));
  assert.ok(names.includes("attribution.get_revenue_attribution"));
  assert.ok(!names.includes("attribution.generate_report"));
  assert.ok(!names.includes("brand.get_profile"));
  assert.ok(!names.includes("sites.provision"));
  engine.store.close();
});

test("Phase 16c: empty funnel and content performance pass adapter validation", async (t) => {
  const { adapter, received } = await mockAa(t, ({ url, body }) => {
    if (url === "/internal/mcp/attribution/get-conversion-funnel")
      return { status: 200, body: { ...emptyFunnel, days: body.days ?? 30 } };
    if (url === "/internal/mcp/attribution/get-content-performance")
      return {
        status: 200,
        body: { client_id: body.client_id, projection: "content_attribution_v1", items: [] },
      };
    if (url === "/internal/mcp/brand/get-profile")
      return { status: 200, body: { client_id: body.client_id, found: false, profile: null } };
    throw new Error(url);
  });
  const engine = new ActionEngine(new Store(":memory:"), registry, adapter);
  t.after(() => engine.store.close());
  const funnel = await engine.call(marketing, "attribution.get_conversion_funnel", { client_id: client });
  assert.equal(funnel.status, "completed");
  assert.equal((funnel.data as any).funnel.leads, 0);
  assert.equal((funnel.data as any).funnel.lead_to_sale_pct, null);
  const content = await engine.call(marketing, "attribution.get_content_performance", { client_id: client });
  assert.equal(content.status, "completed");
  assert.deepEqual((content.data as any).items, []);
  const brand = await engine.call(production, "brand.get_profile", { client_id: client });
  assert.equal(brand.status, "completed");
  assert.equal((brand.data as any).found, false);
  assert.equal(received.length, 3);
});

test("Phase 16c: sites.provision and publish_page require approval before GitHub", async (t) => {
  const { adapter, received } = await mockAa(t, ({ url, body }) => {
    if (url === "/internal/mcp/sites/provision")
      return {
        status: 200,
        body: {
          client_id: body.client_id,
          created: true,
          owner: "attractacq",
          repo: body.repo,
          pages_url: "https://attractacq.github.io/harbour/",
          status: "ready",
        },
      };
    if (url === "/internal/mcp/sites/publish-page")
      return {
        status: 200,
        body: {
          client_id: body.client_id,
          page_id: body.page_id,
          url: "https://attractacq.github.io/harbour/page/",
          commit: "abc1234",
          changed: true,
        },
      };
    throw new Error(url);
  });
  const store = new Store(":memory:");
  t.after(() => store.close());
  const engine = new ActionEngine(store, registry, adapter);
  const pendingProvision = await engine.call(marketing, "sites.provision", {
    client_id: client,
    repo: "harbour",
    idempotency_key: "provision-0001",
  });
  assert.equal(pendingProvision.status, "approval_required");
  assert.equal(received.length, 0, "GitHub provision must not run before approval");
  engine.decide(pendingProvision.approval_id!, "alex", "approved");
  const provisioned = await engine.executeApproval(pendingProvision.approval_id!, [marketing]);
  assert.equal(provisioned.status, "completed");
  assert.equal(received.length, 1);
  const pending = await engine.call(marketing, "sites.publish_page", {
    client_id: client,
    page_id: page,
    idempotency_key: "publish-0001",
  });
  assert.equal(pending.status, "approval_required");
  assert.equal(received.length, 1, "GitHub publish must not run before approval");
  engine.decide(pending.approval_id!, "alex", "approved");
  const executed = await engine.executeApproval(pending.approval_id!, [marketing]);
  assert.equal(executed.status, "completed");
  assert.equal(received.length, 2);
  assert.equal(received[1]?.url, "/internal/mcp/sites/publish-page");
});

test("Phase 16c: sites replay re-checks authorization after a revoked grant", async (t) => {
  let forbidden = false;
  const { adapter } = await mockAa(t, ({ body }) => {
    if (forbidden)
      return { status: 403, body: { error: { code: "client_forbidden" } } };
    return {
      status: 200,
      body: {
        client_id: body.client_id,
        created: false,
        owner: "attractacq",
        repo: body.repo,
        pages_url: null,
        status: "ready",
      },
    };
  });
  const store = new Store(":memory:");
  t.after(() => store.close());
  const engine = new ActionEngine(store, registry, adapter);
  const pending = await engine.call(sales, "sites.provision", {
    client_id: client,
    repo: "harbour",
    idempotency_key: "replay-sites-1",
  });
  assert.equal(pending.status, "approval_required");
  engine.decide(pending.approval_id!, "alex", "approved");
  const first = await engine.executeApproval(pending.approval_id!, [sales]);
  assert.equal(first.status, "completed");
  forbidden = true;
  const pendingReplay = await engine.call(sales, "sites.provision", {
    client_id: client,
    repo: "harbour",
    idempotency_key: "replay-sites-1",
  });
  assert.equal(pendingReplay.status, "approval_required");
  engine.decide(pendingReplay.approval_id!, "alex", "approved");
  const replay = await engine.executeApproval(pendingReplay.approval_id!, [sales]);
  assert.equal(replay.status, "failed");
  assert.equal(replay.error?.code, "client_forbidden");
});

test("Phase 16c: Engineering cannot call sites even with a stale sites.* credential", async () => {
  const engine = new ActionEngine(new Store(":memory:"), registry, {
    execute: async () => {
      throw new Error("AA must not be reached");
    },
  });
  const caller = {
    ...engineering,
    permissions: ["sites.*", "sites.provision", "sites.publish_page", "engineering.*"],
  };
  assert.equal(engine.discover(caller).some((t) => t.name.startsWith("sites.")), false);
  const result = await engine.call(caller, "sites.provision", {
    client_id: client,
    repo: "harbour",
    idempotency_key: "eng-denied",
  });
  assert.equal(result.status, "rejected");
  engine.store.close();
});
