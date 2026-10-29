import { createHmac } from "node:crypto";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, it, vi } from "vitest";

import {
  handleMetaWebhook, inboundMessages, isMetaWebhookRequest, signatureMatches,
} from "./webhook.js";
import type { RuntimeConfig } from "../config.js";

/**
 * The Meta messaging webhook — G01.
 *
 * The only unauthenticated doorway a third party pushes through, so the
 * tests are mostly adversarial: a forged signature, a missing secret, a
 * payload for a page we do not own, and the echo of our own reply coming
 * back. Plus the rule that keeps Meta from retrying for hours — once the
 * signature is good, the answer is 200 whatever happens next.
 */
const SECRET = "app-secret";

const config = (over: Partial<RuntimeConfig> = {}) =>
  ({ metaAppSecret: SECRET, metaWebhookVerifyToken: "verify-me", ...over }) as RuntimeConfig;

function sign(body: string): string {
  return `sha256=${createHmac("sha256", SECRET).update(Buffer.from(body)).digest("hex")}`;
}

function request(opts: {
  method?: string; url?: string; body?: string; signature?: string | null;
} = {}): IncomingMessage {
  const body = opts.body ?? "";
  const req = Readable.from(body ? [Buffer.from(body)] : []) as IncomingMessage;
  req.method = opts.method ?? "POST";
  req.url = opts.url ?? "/public/webhooks/meta";
  req.headers = {};
  if (opts.signature !== null) {
    req.headers["x-hub-signature-256"] = opts.signature ?? sign(body);
  }
  return req;
}

function response() {
  const out = { status: 0, body: "" };
  const res = {
    writeHead: (status: number) => { out.status = status; },
    end: (body?: string) => { out.body = body ?? ""; },
  } as unknown as ServerResponse;
  return { res, out };
}

const db = (over: Record<string, unknown> = {}) => {
  const rpc = vi.fn(async (name: string, _args?: unknown) => {
    if (name in over) return over[name] as { data: unknown; error: unknown };
    if (name === "client_for_meta_recipient_v6") return { data: "client-1", error: null };
    return { data: [{ conversation_id: "conv-1", lead_id: "lead-1", is_new: true }], error: null };
  });
  return { sb: { rpc } as never, rpc };
};

const payload = (over: Record<string, unknown> = {}) => JSON.stringify({
  object: "instagram",
  entry: [{
    id: "page-1",
    messaging: [{
      sender: { id: "igsid-9" },
      recipient: { id: "page-1" },
      timestamp: 1_793_000_000_000,
      message: { mid: "mid-1", text: "Do you do garage conversions?" },
      ...over,
    }],
  }],
});

describe("the signature", () => {
  it("accepts the real one", () => {
    const body = Buffer.from(payload());
    expect(signatureMatches(sign(payload()), body, SECRET)).toBe(true);
  });

  it("rejects a forgery, a wrong prefix, a short hex and a missing header", () => {
    const body = Buffer.from(payload());
    expect(signatureMatches(`sha256=${"0".repeat(64)}`, body, SECRET)).toBe(false);
    expect(signatureMatches(`sha1=${"0".repeat(64)}`, body, SECRET)).toBe(false);
    expect(signatureMatches("sha256=abc", body, SECRET)).toBe(false);
    expect(signatureMatches(undefined, body, SECRET)).toBe(false);
  });

  it("rejects a signature over different bytes", () => {
    // Re-serialising a parsed body changes whitespace, which is exactly why
    // the HMAC is taken over the raw bytes.
    const original = payload();
    const reserialised = JSON.stringify(JSON.parse(original), null, 2);
    expect(signatureMatches(sign(original), Buffer.from(reserialised), SECRET)).toBe(false);
  });
});

describe("the handshake", () => {
  it("echoes the challenge for the right token", async () => {
    const { res, out } = response();
    await handleMetaWebhook(
      request({ method: "GET", url: "/public/webhooks/meta?hub.mode=subscribe&hub.verify_token=verify-me&hub.challenge=12345", signature: null }),
      res, db().sb, config());
    expect(out.status).toBe(200);
    expect(out.body).toBe("12345");
  });

  it("refuses the wrong token", async () => {
    const { res, out } = response();
    await handleMetaWebhook(
      request({ method: "GET", url: "/public/webhooks/meta?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=1", signature: null }),
      res, db().sb, config());
    expect(out.status).toBe(403);
  });
});

describe("accepting a delivery", () => {
  it("refuses an unsigned delivery and stores nothing", async () => {
    const { res, out } = response();
    const { sb, rpc } = db();
    const body = payload();
    await handleMetaWebhook(request({ body, signature: `sha256=${"1".repeat(64)}` }), res, sb, config());
    expect(out.status).toBe(401);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("refuses everything when no app secret is configured", async () => {
    const { res, out } = response();
    const { sb, rpc } = db();
    await handleMetaWebhook(request({ body: payload() }), res, sb, config({ metaAppSecret: null }));
    expect(out.status).toBe(503);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("stores a signed message against the right client", async () => {
    const { res, out } = response();
    const { sb, rpc } = db();
    await handleMetaWebhook(request({ body: payload() }), res, sb, config());
    expect(out.status).toBe(200);
    expect(rpc).toHaveBeenCalledWith("record_inbound_dm_v6", expect.objectContaining({
      p_client_id: "client-1",
      p_platform: "instagram",
      p_external_user_id: "igsid-9",
      p_external_message_id: "mid-1",
      p_body: "Do you do garage conversions?",
    }));
  });

  it("answers 200 and stores nothing for a page we do not own", async () => {
    const { res, out } = response();
    const { sb, rpc } = db({ client_for_meta_recipient_v6: { data: null, error: null } });
    await handleMetaWebhook(request({ body: payload() }), res, sb, config());
    // Not a 404: Meta would retry it for hours, and a disconnected page is
    // not a failure.
    expect(out.status).toBe(200);
    expect(rpc.mock.calls.some((c) => c[0] === "record_inbound_dm_v6")).toBe(false);
  });

  it("answers 200 when the store fails, rather than inviting a retry storm", async () => {
    const { res, out } = response();
    const { sb } = db({ record_inbound_dm_v6: { data: null, error: { message: "deadlock" } } });
    await handleMetaWebhook(request({ body: payload() }), res, sb, config());
    expect(out.status).toBe(200);
  });

  it("answers 200 for a signed body it cannot parse", async () => {
    const { res, out } = response();
    const { sb, rpc } = db();
    await handleMetaWebhook(request({ body: "not json" }), res, sb, config());
    expect(out.status).toBe(200);
    expect(rpc).not.toHaveBeenCalled();
  });
});

describe("reading a payload", () => {
  it("ignores the echo of our own reply", () => {
    // Storing echoes would double every outbound message in the thread.
    expect(inboundMessages(JSON.parse(payload({ message: { mid: "m", text: "hi", is_echo: true } })))).toHaveLength(0);
  });

  it("ignores read receipts and deliveries, which arrive on the same endpoint", () => {
    const noMessage = { object: "instagram", entry: [{ messaging: [{ sender: { id: "a" }, recipient: { id: "b" }, read: { watermark: 1 } }] }] };
    expect(inboundMessages(noMessage)).toHaveLength(0);
  });

  it("skips an event with no sender or no recipient", () => {
    const partial = { object: "page", entry: [{ messaging: [{ sender: {}, recipient: { id: "b" }, message: { mid: "m" } }] }] };
    expect(inboundMessages(partial)).toHaveLength(0);
  });

  it("tells Instagram and Messenger apart by the payload object", () => {
    expect(inboundMessages(JSON.parse(payload()))[0]!.platform).toBe("instagram");
    const page = JSON.parse(payload());
    page.object = "page";
    expect(inboundMessages(page)[0]!.platform).toBe("facebook");
  });

  it("survives a shape it has never seen", () => {
    for (const junk of [null, {}, { entry: "nope" }, { entry: [{}] }, { entry: [{ messaging: {} }] }]) {
      expect(inboundMessages(junk)).toEqual([]);
    }
  });

  it("carries the timestamp through as an instant", () => {
    const got = inboundMessages(JSON.parse(payload()))[0]!;
    expect(got.occurredAt).toBe(new Date(1_793_000_000_000).toISOString());
  });
});

describe("which requests are ours", () => {
  it("claims only the webhook path", () => {
    expect(isMetaWebhookRequest("/public/webhooks/meta")).toBe(true);
    expect(isMetaWebhookRequest("/public/webhooks/meta?hub.mode=subscribe")).toBe(true);
    expect(isMetaWebhookRequest("/public/webhooks/other")).toBe(false);
    expect(isMetaWebhookRequest(undefined)).toBe(false);
  });
});
