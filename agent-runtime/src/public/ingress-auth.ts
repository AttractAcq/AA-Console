import type { IncomingMessage } from "node:http";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { Readable } from "node:stream";
import { normalizeIp } from "./client-ip.js";

const MAX_SKEW_MS = 30_000;
const authenticatedClients = new WeakMap<object, string>();

export class IngressRefusal extends Error {
  constructor(readonly status: 403 | 408 | 413 | 503, reason: string) { super(reason); }
}

export function isSignedPublicPath(url: string | undefined): boolean {
  // Protect the namespace, not today's route list. A future /public/ route
  // must fail closed until the facade explicitly allowlists it.
  return !!url && (url === "/public" || url.startsWith("/public?") || url.startsWith("/public/"));
}

export function publicBodyLimit(url: string): number {
  if (url === "/public/proof/submit") return 36 * 1024 * 1024;
  if (url.split("?")[0] === "/public/webhooks/meta") return 256 * 1024;
  return 16 * 1024;
}

function keyBytes(secret: string): Buffer {
  return /^[a-f0-9]{64,}$/i.test(secret) && secret.length % 2 === 0
    ? Buffer.from(secret, "hex") : Buffer.from(secret, "base64url");
}

export function ingressSignature(
  secret: string, method: string, url: string, clientIp: string,
  timestamp: string, nonce: string, bodyHash: string,
): string {
  const canonical = ["v1", timestamp, nonce, method, url, clientIp, bodyHash].join("\n");
  return `v1=${createHmac("sha256", keyBytes(secret)).update(canonical).digest("hex")}`;
}

function single(req: IncomingMessage, name: string): string | null {
  const value = req.headers[name];
  return typeof value === "string" ? value : null;
}

export type ClaimNonce = (nonceHash: string, issuedAt: string) => Promise<boolean>;

function readBoundedBody(req: IncomingMessage, limit: number, timeoutMs: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    let done = false;
    const finish = (error?: Error): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      req.off("data", onData);
      req.off("end", onEnd);
      req.off("error", onError);
      req.off("aborted", onAbort);
      if (error) { req.pause(); reject(error); }
      else resolve(Buffer.concat(chunks));
    };
    const onData = (chunk: Buffer | Uint8Array): void => {
      const part = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += part.length;
      if (bytes > limit) finish(new IngressRefusal(413, "body_too_large"));
      else chunks.push(part);
    };
    const onEnd = (): void => finish();
    const onError = (): void => finish(new IngressRefusal(503, "body_stream_error"));
    const onAbort = (): void => finish(new IngressRefusal(408, "body_aborted"));
    const timer = setTimeout(() => finish(new IngressRefusal(408, "body_timeout")), timeoutMs);
    req.on("data", onData);
    req.once("end", onEnd);
    req.once("error", onError);
    req.once("aborted", onAbort);
  });
}

/**
 * The isolated ingress signs the request target and a body digest. Verify the
 * HMAC before reading a possibly large body, then verify the body before a
 * public handler can touch the quota store or any client data.
 */
export async function authenticatePublicIngress(
  req: IncomingMessage, secret: string, claimNonce: ClaimNonce, now = Date.now(),
  bodyTimeoutMs = 120_000,
): Promise<IncomingMessage> {
  const method = req.method ?? "";
  const url = req.url ?? "";
  const timestamp = single(req, "x-aa-ingress-timestamp");
  const nonce = single(req, "x-aa-ingress-nonce");
  const clientIp = single(req, "x-aa-ingress-ip");
  const bodyHash = single(req, "x-aa-ingress-body-sha256");
  const signature = single(req, "x-aa-ingress-signature");
  const normalized = normalizeIp(clientIp ?? undefined);
  if (!/^[A-Z]{3,8}$/.test(method) || !url.startsWith("/") || url.length > 4096 ||
      !timestamp || !/^\d{10,13}$/.test(timestamp) ||
      Math.abs(now - Number(timestamp)) > MAX_SKEW_MS ||
      !nonce || !/^[A-Za-z0-9_-]{22}$/.test(nonce) ||
      !clientIp || normalized !== clientIp ||
      !bodyHash || !/^[a-f0-9]{64}$/.test(bodyHash) ||
      !signature || !/^v1=[a-f0-9]{64}$/.test(signature)) {
    throw new IngressRefusal(403, "invalid_envelope");
  }
  const expected = ingressSignature(secret, method, url, clientIp, timestamp, nonce, bodyHash);
  if (!timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) {
    throw new IngressRefusal(403, "bad_signature");
  }
  const limit = publicBodyLimit(url);
  if (Number(req.headers["content-length"]) > limit) throw new IngressRefusal(413, "body_too_large");
  const body = await readBoundedBody(req, limit, bodyTimeoutMs);
  const actualHash = createHash("sha256").update(body).digest("hex");
  if (!timingSafeEqual(Buffer.from(bodyHash), Buffer.from(actualHash))) {
    throw new IngressRefusal(403, "body_mismatch");
  }
  let claimed = false;
  try {
    claimed = await claimNonce(createHash("sha256").update(nonce).digest("hex"),
      new Date(Number(timestamp)).toISOString());
  } catch {
    throw new IngressRefusal(503, "nonce_store_unavailable");
  }
  if (!claimed) throw new IngressRefusal(403, "replayed_nonce");
  const replay = Readable.from(body.length ? [body] : []) as IncomingMessage;
  replay.method = method;
  replay.url = url;
  replay.headers = { ...req.headers };
  for (const name of Object.keys(replay.headers)) if (name.startsWith("x-aa-ingress-")) delete replay.headers[name];
  Object.defineProperty(replay, "socket", { value: req.socket });
  authenticatedClients.set(replay, clientIp);
  return replay;
}

export function signedIngressClientIp(req: IncomingMessage): string | null {
  return authenticatedClients.get(req) ?? null;
}
