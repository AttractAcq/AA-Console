/**
 * Public ingress facade. Deploy this as the sole service in a separate
 * Railway project/environment; see README.md before attaching a domain.
 * It holds only a dedicated signing key and never a Supabase or runtime key.
 */
import http from "node:http";
import https from "node:https";
import { createHash, createHmac, randomBytes } from "node:crypto";
import { isIP } from "node:net";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const PUBLIC_FAMILIES = ["/public/proof", "/public/lead", "/public/book/v1/", "/public/sales/v1/"];
const HOP_HEADERS = new Set(["connection", "content-length", "transfer-encoding", "upgrade", "keep-alive",
  "proxy-authorization", "proxy-authenticate", "te", "trailer", "host", "forwarded",
  "x-real-ip", "x-forwarded-for", "x-forwarded-proto", "x-forwarded-host", "cf-connecting-ip",
  "fastly-client-ip"]);

export function isPublicPath(url) {
  return typeof url === "string" && PUBLIC_FAMILIES.some((prefix) => url.startsWith(prefix));
}

export function normalizeIp(raw) {
  if (typeof raw !== "string" || raw.trim() !== raw || raw.includes("%")) return null;
  if (isIP(raw) === 4) return raw;
  if (isIP(raw) !== 6) return null;
  let canonical;
  try { canonical = new URL(`http://[${raw}]/`).hostname.slice(1, -1).toLowerCase(); }
  catch { return null; }
  const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(canonical);
  if (!mapped) return canonical;
  const high = Number.parseInt(mapped[1], 16), low = Number.parseInt(mapped[2], 16);
  return `${high >>> 8}.${high & 255}.${low >>> 8}.${low & 255}`;
}

function keyBytes(secret) {
  return /^[a-f0-9]{64,}$/i.test(secret) && secret.length % 2 === 0
    ? Buffer.from(secret, "hex") : Buffer.from(secret, "base64url");
}

export function signIngress(secret, method, url, clientIp, timestamp, nonce, bodyHash) {
  const canonical = ["v1", timestamp, nonce, method, url, clientIp, bodyHash].join("\n");
  return `v1=${createHmac("sha256", keyBytes(secret)).update(canonical).digest("hex")}`;
}

export function scrubHeaders(input) {
  const headers = {};
  const connectionTokens = String(input.connection ?? "").toLowerCase().split(",").map((v) => v.trim());
  for (const [name, value] of Object.entries(input)) {
    if (HOP_HEADERS.has(name) || connectionTokens.includes(name) || name.startsWith("x-aa-ingress-") ||
        name.startsWith("x-railway-") || value === undefined) continue;
    headers[name] = value;
  }
  return headers;
}

function bodyLimit(url) { return url === "/public/proof/submit" ? 36 * 1024 * 1024 : 16 * 1024; }

export function readBounded(req, limit, timeoutMs = 120_000) {
  if (Number(req.headers["content-length"]) > limit) {
    return Promise.reject(Object.assign(new Error("body_too_large"), { status: 413 }));
  }
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let done = false;
    const finish = (error) => {
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
    const onData = (part) => {
      size += part.length;
      if (size > limit) finish(Object.assign(new Error("body_too_large"), { status: 413 }));
      else chunks.push(part);
    };
    const onEnd = () => finish();
    const onError = () => finish(Object.assign(new Error("body_stream_error"), { status: 503 }));
    const onAbort = () => finish(Object.assign(new Error("body_aborted"), { status: 408 }));
    const timer = setTimeout(() => finish(Object.assign(new Error("body_timeout"), { status: 408 })), timeoutMs);
    req.on("data", onData);
    req.once("end", onEnd);
    req.once("error", onError);
    req.once("aborted", onAbort);
  });
}

export function validateConfig(env = process.env) {
  const upstream = new URL(env.PUBLIC_INGRESS_UPSTREAM_URL ?? "");
  if ((env.NODE_ENV === "production" && upstream.protocol !== "https:") ||
      !["http:", "https:"].includes(upstream.protocol) || upstream.username || upstream.password ||
      upstream.pathname !== "/" || upstream.search || upstream.hash) {
    throw new Error("PUBLIC_INGRESS_UPSTREAM_URL must be a bare HTTPS origin in production");
  }
  if (env.NODE_ENV === "production" && upstream.hostname === "runtime.attractacq.com") {
    throw new Error("PUBLIC_INGRESS_UPSTREAM_URL cannot point at the public facade domain");
  }
  const secret = env.PUBLIC_INGRESS_HMAC_KEY ?? "";
  const hex = /^[a-f0-9]{64,}$/i.test(secret) && secret.length % 2 === 0;
  const b64 = /^[A-Za-z0-9_-]{43,}$/.test(secret) &&
    Buffer.from(secret, "base64url").length >= 32 &&
    Buffer.from(secret, "base64url").toString("base64url") === secret;
  if ((!hex && !b64) || new Set(secret).size < 12) throw new Error("PUBLIC_INGRESS_HMAC_KEY needs 32 random bytes");
  if (env.NODE_ENV === "production") {
    if (!env.RAILWAY_PROJECT_ID || !env.PUBLIC_INGRESS_EXPECTED_PROJECT_ID ||
        !env.PUBLIC_INGRESS_CORE_PROJECT_ID ||
        env.RAILWAY_PROJECT_ID !== env.PUBLIC_INGRESS_EXPECTED_PROJECT_ID ||
        env.RAILWAY_PROJECT_ID === env.PUBLIC_INGRESS_CORE_PROJECT_ID) {
      throw new Error("Public ingress must run in its reviewed separate Railway project");
    }
    if (env.RAILWAY_TCP_PROXY_DOMAIN || env.RAILWAY_TCP_PROXY_PORT) {
      throw new Error("Public ingress must not expose a TCP proxy");
    }
  }
  const port = Number(env.PORT ?? 8788);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("PORT must be 1–65535");
  return { upstream, secret, port };
}

export function createIngressServer({ upstream, secret }) {
  const transport = upstream.protocol === "https:" ? https : http;
  return http.createServer((req, res) => {
    void (async () => {
      const url = req.url ?? "";
      const method = req.method ?? "";
      if (!url.startsWith("/") || url.startsWith("//") || url.length > 4096 || !/^[A-Z]{3,8}$/.test(method)) {
        res.writeHead(400, { "connection": "close" }).end(); return;
      }
      const isPublic = isPublicPath(url);
      if ((url === "/public" || url.startsWith("/public?") || url.startsWith("/public/")) && !isPublic) {
        res.writeHead(404, { "connection": "close" }).end(); return;
      }
      const headers = scrubHeaders(req.headers);
      let body;
      if (isPublic) {
        // Railway's public HTTP edge overwrites this header. This service must
        // have no private-network siblings that could set it themselves.
        const rawIp = req.headers["x-real-ip"];
        const clientIp = typeof rawIp === "string" ? normalizeIp(rawIp) : null;
        if (!clientIp) { res.writeHead(503, { "connection": "close" }).end(); return; }
        body = await readBounded(req, bodyLimit(url));
        const timestamp = String(Date.now());
        const nonce = randomBytes(16).toString("base64url");
        const bodyHash = createHash("sha256").update(body).digest("hex");
        headers["x-aa-ingress-timestamp"] = timestamp;
        headers["x-aa-ingress-nonce"] = nonce;
        headers["x-aa-ingress-ip"] = clientIp;
        headers["x-aa-ingress-body-sha256"] = bodyHash;
        headers["x-aa-ingress-signature"] = signIngress(secret, method, url, clientIp, timestamp, nonce, bodyHash);
        headers["content-length"] = String(body.length);
      }
      const upstreamReq = transport.request({
        protocol: upstream.protocol, hostname: upstream.hostname, port: upstream.port || undefined,
        path: url, method, headers, timeout: 120_000,
      }, (upstreamRes) => {
        const responseHeaders = scrubHeaders(upstreamRes.headers);
        // Response length is determined by Node while streaming.
        res.writeHead(upstreamRes.statusCode ?? 502, responseHeaders);
        upstreamRes.pipe(res);
      });
      upstreamReq.on("timeout", () => upstreamReq.destroy(new Error("upstream_timeout")));
      upstreamReq.on("error", () => { if (!res.headersSent) res.writeHead(502).end(); else res.destroy(); });
      if (body) upstreamReq.end(body);
      else req.pipe(upstreamReq);
    })().catch((error) => {
      if (!res.headersSent) res.writeHead([408, 413].includes(error?.status) ? error.status : 503,
        { "connection": "close" }).end();
      else res.destroy();
    });
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const config = validateConfig();
  createIngressServer(config).listen(config.port, "0.0.0.0", () => {
    process.stdout.write(`public_ingress_listening port=${config.port}\n`);
  });
}
