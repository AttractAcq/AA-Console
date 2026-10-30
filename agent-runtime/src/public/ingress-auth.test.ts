import { createHash, randomBytes } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { PassThrough, Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { readJsonBody } from "../mcp/http.js";
import {
  authenticatePublicIngress, ingressSignature, isSignedPublicPath, publicBodyLimit,
  signedIngressClientIp,
} from "./ingress-auth.js";

const SECRET = randomBytes(32).toString("hex");
const NOW = 1_800_000_000_000;
const URL = "/public/lead/submit";
const BODY = Buffer.from('{"name":"Ada"}');
const seen = new Set<string>();
const claim = async (hash: string): Promise<boolean> => {
  if (seen.has(hash)) return false;
  seen.add(hash);
  return true;
};

function request(options: {
  method?: string; url?: string; body?: Buffer; bodyHash?: string;
  timestamp?: string; nonce?: string; ip?: string; signature?: string;
  forwarded?: string; peer?: string;
} = {}): IncomingMessage {
  const method = options.method ?? "POST";
  const url = options.url ?? URL;
  const body = options.body ?? BODY;
  const timestamp = options.timestamp ?? String(NOW);
  const nonce = options.nonce ?? randomBytes(16).toString("base64url");
  const ip = options.ip ?? "203.0.113.9";
  const bodyHash = options.bodyHash ?? createHash("sha256").update(body).digest("hex");
  const signature = options.signature ?? ingressSignature(SECRET, method, url, ip, timestamp, nonce, bodyHash);
  const req = Readable.from([body]) as IncomingMessage;
  req.method = method;
  req.url = url;
  req.headers = {
    "x-aa-ingress-timestamp": timestamp,
    "x-aa-ingress-nonce": nonce,
    "x-aa-ingress-ip": ip,
    "x-aa-ingress-body-sha256": bodyHash,
    "x-aa-ingress-signature": signature,
    "x-forwarded-for": options.forwarded ?? "198.51.100.200",
  };
  Object.defineProperty(req, "socket", { value: { remoteAddress: options.peer ?? "10.0.0.2" } });
  return req;
}

describe("isolated public ingress envelope", () => {
  it("accepts a complete signed body and binds quota identity to signed client IP", async () => {
    const authenticated = await authenticatePublicIngress(request(), SECRET, claim, NOW);
    expect(signedIngressClientIp(authenticated)).toBe("203.0.113.9");
    expect(authenticated.headers["x-aa-ingress-ip"]).toBeUndefined();
    expect(await readJsonBody(authenticated, 8192)).toEqual({ name: "Ada" });
  });

  it("refuses a direct call before reading its body", async () => {
    const req = request();
    delete req.headers["x-aa-ingress-signature"];
    await expect(authenticatePublicIngress(req, SECRET, claim, NOW)).rejects.toMatchObject({ status: 403 });
    expect(req.readableEnded).toBe(false);
  });

  it("refuses forged forwarding, changed body, path, method and old timestamp", async () => {
    const forged = request({ forwarded: "1.2.3.4", peer: "100.64.0.1" });
    forged.headers["x-aa-ingress-ip"] = "1.2.3.4";
    await expect(authenticatePublicIngress(forged, SECRET, claim, NOW)).rejects.toMatchObject({ status: 403 });
    const changedBody = request({ bodyHash: createHash("sha256").update("different").digest("hex") });
    let nonceClaims = 0;
    await expect(authenticatePublicIngress(changedBody, SECRET, async () => { nonceClaims += 1; return true; }, NOW))
      .rejects.toMatchObject({ status: 403 });
    expect(nonceClaims).toBe(0);
    const changedPath = request(); changedPath.url = "/public/proof/config";
    await expect(authenticatePublicIngress(changedPath, SECRET, claim, NOW)).rejects.toMatchObject({ status: 403 });
    const changedMethod = request(); changedMethod.method = "GET";
    await expect(authenticatePublicIngress(changedMethod, SECRET, claim, NOW)).rejects.toMatchObject({ status: 403 });
    await expect(authenticatePublicIngress(request({ timestamp: String(NOW - 31_000) }), SECRET, claim, NOW))
      .rejects.toMatchObject({ status: 403 });
  });

  it("refuses a replayed nonce and an oversized body before dispatch", async () => {
    const nonce = randomBytes(16).toString("base64url");
    await authenticatePublicIngress(request({ nonce }), SECRET, claim, NOW);
    await expect(authenticatePublicIngress(request({ nonce }), SECRET, claim, NOW)).rejects.toMatchObject({ status: 403 });
    const tooLarge = request({ body: Buffer.alloc(16 * 1024 + 1) });
    await expect(authenticatePublicIngress(tooLarge, SECRET, claim, NOW)).rejects.toMatchObject({ status: 413 });
    await expect(authenticatePublicIngress(request(), SECRET, async () => { throw new Error("db down"); }, NOW))
      .rejects.toMatchObject({ status: 503 });
  });

  it("times out a signed request whose body never completes", async () => {
    const prepared = request({ body: Buffer.alloc(0) });
    const hanging = new PassThrough() as unknown as IncomingMessage;
    hanging.method = prepared.method;
    hanging.url = prepared.url;
    hanging.headers = prepared.headers;
    Object.defineProperty(hanging, "socket", { value: prepared.socket });
    await expect(authenticatePublicIngress(hanging, SECRET, claim, NOW, 15))
      .rejects.toMatchObject({ status: 408 });
  });

  it("guards every anonymous route family, including the static widget", () => {
    for (const path of ["/public/proof", "/public/lead/submit", "/public/book/v1/token/slots",
      "/public/sales/v1/widget.js", "/public/sales/v1/d/id/config", "/public/unknown",
      "/public/future-route/v2/alias", "/public", "/public?future=1"]) {
      expect(isSignedPublicPath(path)).toBe(true);
    }
    expect(isSignedPublicPath("/admin/system-readiness")).toBe(false);
    // The existing proof handler accepts this exact URL only. A query-suffixed
    // variant is a 404, not a valid large proof submission.
    expect(publicBodyLimit("/public/proof/submit")).toBe(36 * 1024 * 1024);
    expect(publicBodyLimit("/public/proof/submit?x=1")).toBe(16 * 1024);
  });
});
