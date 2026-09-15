import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer as mockServer } from "node:http";
import { once } from "node:events";
import { AAApiAdapter } from "../src/adapters/aa-api.js";
import { ActionEngine } from "../src/policy/engine.js";
import { Store } from "../src/audit/store.js";
import { registry } from "../src/registry/tools.js";
import { marketingDirector } from "../src/onboarding/marketing-director.js";
import { chiefOfStaff } from "../src/onboarding/chief-of-staff.js";
import { allowed, grants } from "../src/policy/permissions.js";
import { bots } from "../src/shared/types.js";

const client = "11111111-1111-4111-8111-111111111111";
const other = "22222222-2222-4222-8222-222222222222";
const pageId = "33333333-3333-4333-8333-333333333333";
const campaignId = "44444444-4444-4444-8444-444444444444";
const jobId = "55555555-5555-4555-8555-555555555555";
const marketing = { bot: "bot_marketing" as const, clients: [client] };
const cos = { bot: "bot_chief_of_staff" as const, clients: [client] };

function engine(t: any, adapter: any = new AAApiAdapter()) {
  const e = new ActionEngine(new Store(":memory:"), registry, adapter);
  t.after(() => e.store.close());
  return e;
}
async function mockAa(
  t: any,
  handler: (body: any, path: string) => { status?: number; body: unknown },
) {
  const seen: any[] = [];
  const server = mockServer(async (req, res) => {
    let raw = "";
    for await (const c of req) raw += c;
    const body = JSON.parse(raw);
    seen.push({ path: req.url, body, headers: req.headers });
    const result = handler(body, req.url!);
    res.writeHead(result.status ?? 200, { "content-type": "application/json" });
    res.end(JSON.stringify(result.body));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  return {
    seen,
    adapter: new AAApiAdapter({
      url: `http://127.0.0.1:${(server.address() as any).port}`,
      token: "test-only-service-credential",
    }),
  };
}

test("Phase 16 registry: conversion and campaign execution tools are real", () => {
  // Catalog size after #48 only. Sibling PRs #46/#47 may add names and must
  // update their own registry.length asserts; do not treat 97 as a final ceiling.
  assert.equal(registry.length, 97);
  assert.equal(marketingDirector.grants.length, 40);
  assert.equal(marketingDirector.phase16Owned.length, 17);
  for (const name of [
    ...marketingDirector.grants.filter((n) => n.startsWith("conversion.") || n.startsWith("campaign.")),
    "campaign.list",
    "campaign.get",
    "campaign.get_status",
  ]) {
    assert.equal(registry.find((t) => t.name === name)?.implementation, "real", name);
  }
  assert.equal(registry.find((t) => t.name.startsWith("sites."))?.implementation, undefined);
  assert.equal(registry.find((t) => t.name === "pipeline.record_sale")?.implementation, "stub");
});

test("campaign.launch cannot spend ad budget; stays MEDIUM without approval", () => {
  const launch = registry.find((t) => t.name === "campaign.launch")!;
  assert.equal(launch.implementation, "real");
  assert.equal(launch.risk, "MEDIUM");
  assert.equal(launch.approval, false);
});

test("conversion tools are Marketing-only even with stale wildcards", () => {
  const tool = registry.find((t) => t.name === "conversion.list_pages")!;
  assert.equal(allowed(marketing, tool), true);
  for (const bot of bots.filter((b) => b !== "bot_marketing")) {
    assert.equal(
      allowed({ bot, clients: [client], permissions: ["conversion.*"] }, tool),
      false,
      bot,
    );
  }
});

test("CoS discovers campaign execution writes via campaign.* and never conversion", (t) => {
  const e = engine(t);
  const names = e.discover(cos).map((x) => x.name);
  for (const name of [
    "campaign.create",
    "campaign.update",
    "campaign.request_approval",
    "campaign.plan",
    "campaign.provision",
    "campaign.launch",
    "campaign.get_readiness",
  ])
    assert.ok(names.includes(name), name);
  assert.ok(!names.includes("conversion.list_pages"));
  assert.deepEqual([...chiefOfStaff.grants], grants.bot_chief_of_staff);
});

test("CDM reads execution campaigns and cannot create", (t) => {
  const e = engine(t);
  const names = e.discover({ bot: "bot_client_delivery", clients: [client] }).map((x) => x.name);
  assert.ok(names.includes("campaign.get"));
  assert.ok(names.includes("campaign.get_status"));
  assert.ok(!names.includes("campaign.create"));
  assert.ok(!names.includes("campaign.launch"));
});

test("conversion adapter queues landing_page jobs and routes exact paths", async (t) => {
  const { adapter, seen } = await mockAa(t, (_body, path) => ({
    status: path.includes("create-page") || path.includes("generate-") || path.includes("audit") || path.includes("revise")
      ? 202
      : 200,
    body: {
      client_id: client,
      job_id: jobId,
      page: { id: pageId, client_id: client },
      queue: "console_page_review",
    },
  }));
  const e = engine(t, adapter);
  assert.equal(
    (await e.call(marketing, "conversion.create_page", {
      client_id: client,
      title: "Winter",
      brief: "Sell the plan",
      idempotency_key: "conv-create",
    })).status,
    "accepted",
  );
  assert.equal(
    (await e.call(marketing, "conversion.get_page", { client_id: client, page_id: pageId })).status,
    "completed",
  );
  assert.equal(
    (await e.call(marketing, "conversion.request_approval", {
      client_id: client,
      page_id: pageId,
      summary: "Review",
      idempotency_key: "conv-approve",
    })).status,
    "completed",
  );
  assert.deepEqual(
    seen.map((x) => x.path),
    [
      "/internal/mcp/conversion/create-page",
      "/internal/mcp/conversion/get-page",
      "/internal/mcp/conversion/request-approval",
    ],
  );
  assert.equal(seen[0].headers["x-aa-bot-id"], "bot_marketing");
  assert.equal(seen[0].body.idempotency_key, undefined);
});

test("campaign adapter routes Execution OS writes and readiness", async (t) => {
  const { adapter, seen } = await mockAa(t, (_body, path) => ({
    status: path.endsWith("/create") || path.endsWith("/plan") ? 202 : 200,
    body: {
      client_id: client,
      job_id: jobId,
      campaign: { id: campaignId, client_id: client },
      queue: "console_campaign_launch",
      readiness: [],
      ready: false,
    },
  }));
  const e = engine(t, adapter);
  assert.equal(
    (await e.call(cos, "campaign.create", {
      client_id: client,
      name: "Spring",
      brief: "New season",
      idempotency_key: "camp-create",
    })).status,
    "accepted",
  );
  assert.equal(
    (await e.call(cos, "campaign.get_readiness", {
      client_id: client,
      campaign_id: campaignId,
    })).status,
    "completed",
  );
  assert.equal(
    (await e.call(marketing, "campaign.launch", {
      client_id: client,
      campaign_id: campaignId,
      idempotency_key: "camp-launch",
    })).status,
    "completed",
  );
  assert.ok(seen.some((x) => x.path === "/internal/mcp/campaign/create"));
  assert.ok(seen.some((x) => x.path === "/internal/mcp/campaign/get-readiness"));
  assert.ok(seen.some((x) => x.path === "/internal/mcp/campaign/launch"));
});

test("conversion and campaign deny other-client before adapter", async (t) => {
  let calls = 0;
  const e = engine(t, {
    execute: async () => {
      calls++;
      throw Error("unexpected");
    },
  });
  assert.equal(
    (
      await e.call(marketing, "conversion.get_page", {
        client_id: other,
        page_id: pageId,
      })
    ).message,
    "Client scope denied.",
  );
  assert.equal(
    (
      await e.call(cos, "campaign.launch", {
        client_id: other,
        campaign_id: campaignId,
        idempotency_key: "nope-launch",
      })
    ).message,
    "Client scope denied.",
  );
  assert.equal(calls, 0);
});
