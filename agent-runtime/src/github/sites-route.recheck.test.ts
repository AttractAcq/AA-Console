import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { SupabaseClient } from "@supabase/supabase-js";
import { beforeEach, expect, it, vi } from "vitest";

const { requireHumanAdmin, approvedPageCaptureToken, probePageForm } = vi.hoisted(() => ({
  requireHumanAdmin: vi.fn(), approvedPageCaptureToken: vi.fn(), probePageForm: vi.fn(),
}));
vi.mock("../master/auth.js", () => ({ requireHumanAdmin, BOT_FORBIDDEN_CODE: "bot_forbidden", AuthError: class AuthError extends Error { status = 401; } }));
vi.mock("../sites/store.js", () => ({ supabaseSiteStore: () => ({}) }));
vi.mock("../campaigns/actions/page-deploy.js", () => ({ approvedPageCaptureToken, probePageForm }));

import { handleSitesRoute } from "./sites-route.js";

const PAGE = "<!doctype html><body><!-- aa-page-capture-form --><form></form></body>";
const publication = { id: "11111111-1111-4111-8111-111111111111", client_id: "client-1",
  page_id: "page-1", approval_id: "approval-1", probe_kind: "endpoint",
  rendered_sha256: createHash("sha256").update(PAGE).digest("hex") };

function setup(sha = publication.rendered_sha256) {
  const rpc = vi.fn(async () => ({ error: null }));
  const from = vi.fn((table: string) => {
    const chain = {
      select: () => chain,
      eq: () => chain,
      maybeSingle: async () => ({ data: table === "campaign_page_publications"
        ? { ...publication, rendered_sha256: sha }
        : table === "client_pages" ? { html: PAGE, client_id: "client-1" }
          : { campaign_id: "campaign-1", client_id: "client-1" }, error: null }),
    };
    return chain;
  });
  const req = Readable.from([Buffer.from(JSON.stringify({ publicationId: publication.id }))]) as IncomingMessage;
  req.headers = { authorization: "Bearer admin" };
  let status = 0;
  let body: Record<string, unknown> = {};
  const res = { writeHead: (code: number) => { status = code; },
    end: (value: string) => { body = JSON.parse(value) as Record<string, unknown>; } } as unknown as ServerResponse;
  const call = async () => {
    await handleSitesRoute(req, res, { from, rpc } as unknown as SupabaseClient,
      { publicRuntimeBase: "https://runtime.example.test" } as never, "recheck-page-capture");
    return { status, body };
  };
  return { call, rpc };
}

beforeEach(() => {
  vi.clearAllMocks();
  requireHumanAdmin.mockResolvedValue({});
  approvedPageCaptureToken.mockReturnValue("a".repeat(64));
  probePageForm.mockResolvedValue({ passed: true, detail: "Capture endpoint passed.", leadId: "lead-1" });
});

it("refuses to recheck if current HTML no longer matches the published approval", async () => {
  const { call, rpc } = setup("f".repeat(64));
  const result = await call();
  expect(result.status).toBe(422);
  expect(probePageForm).not.toHaveBeenCalled();
  expect(rpc).not.toHaveBeenCalled();
});

it("checks capture without a second page publish and records the observed lead", async () => {
  const { call, rpc } = setup();
  const result = await call();
  expect(result.status).toBe(200);
  expect(result.body).toMatchObject({ ok: true, passed: true });
  expect(probePageForm).toHaveBeenCalledWith(expect.anything(), expect.anything(), {
    clientId: "client-1", campaignId: "campaign-1", pageId: "page-1", token: "a".repeat(64),
  });
  expect(rpc).toHaveBeenCalledWith("record_campaign_page_probe_v6", {
    p_publication_id: publication.id, p_passed: true, p_detail: "Capture endpoint passed.", p_lead_id: "lead-1",
  });
});
