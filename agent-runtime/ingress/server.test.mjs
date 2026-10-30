import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import http from "node:http";
import { once } from "node:events";
import { PassThrough } from "node:stream";
import { after, before, test } from "node:test";
import { createIngressServer, isPublicPath, readBounded, signIngress, validateConfig } from "./server.mjs";

const secret = randomBytes(32).toString("hex");
let core, facade, corePort, facadePort;
const received = [];

before(async () => {
  core = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    received.push({ method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks) });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
  }).listen(0, "127.0.0.1");
  await once(core, "listening");
  corePort = core.address().port;
  facade = createIngressServer({ upstream: new URL(`http://127.0.0.1:${corePort}`), secret })
    .listen(0, "127.0.0.1");
  await once(facade, "listening");
  facadePort = facade.address().port;
});

after(async () => {
  await Promise.all([new Promise((resolve) => facade.close(resolve)), new Promise((resolve) => core.close(resolve))]);
});

function call(path, headers = {}, body = "", method = "POST") {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: "127.0.0.1", port: facadePort, path, method, headers }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }));
    });
    req.on("error", reject);
    req.end(body);
  });
}

test("public route strips caller-supplied ingress fields and signs exact body/path/IP", async () => {
  const body = '{"name":"Ada"}';
  const beforeCount = received.length;
  const reply = await call("/public/lead/submit?utm=one", {
    "x-real-ip": "203.0.113.9", "x-aa-ingress-ip": "1.2.3.4",
    "x-aa-ingress-signature": "v1=forged", "x-forwarded-for": "1.2.3.4",
    authorization: "Bearer example", origin: "https://client.example",
  }, body);
  assert.equal(reply.status, 200);
  assert.equal(received.length, beforeCount + 1);
  const item = received.at(-1);
  assert.equal(item.body.toString(), body);
  assert.equal(item.url, "/public/lead/submit?utm=one");
  assert.equal(item.headers["x-aa-ingress-ip"], "203.0.113.9");
  assert.equal(item.headers["x-forwarded-for"], undefined);
  assert.equal(item.headers.authorization, "Bearer example");
  assert.equal(item.headers.origin, "https://client.example");
  const bodyHash = createHash("sha256").update(body).digest("hex");
  assert.equal(item.headers["x-aa-ingress-body-sha256"], bodyHash);
  assert.equal(item.headers["x-aa-ingress-signature"], signIngress(secret, "POST", item.url,
    "203.0.113.9", item.headers["x-aa-ingress-timestamp"], item.headers["x-aa-ingress-nonce"], bodyHash));
});

test("public ingress refuses a missing client identity and oversized body before forwarding", async () => {
  const beforeCount = received.length;
  assert.equal((await call("/public/lead/submit", {}, "{} ")).status, 503);
  assert.equal((await call("/public/lead/submit", { "x-real-ip": "203.0.113.9" }, "x".repeat(16 * 1024 + 1))).status, 413);
  assert.equal((await call("/public/unknown", { "x-real-ip": "203.0.113.9" }, "{} ")).status, 404);
  assert.equal((await call("/public/future-route/v2/alias", { "x-real-ip": "203.0.113.9" }, "{} ")).status, 404);
  assert.equal((await call("/public", { "x-real-ip": "203.0.113.9" }, "{} ")).status, 404);
  assert.equal((await call("/public?future=1", { "x-real-ip": "203.0.113.9" }, "{} ")).status, 404);
  assert.equal(received.length, beforeCount);
});

test("nonpublic proxy carries auth but strips spoofed ingress fields", async () => {
  const reply = await call("/admin/system-readiness", {
    authorization: "Bearer example", "x-aa-ingress-ip": "1.2.3.4", "x-real-ip": "1.2.3.4",
  }, "{}", "POST");
  assert.equal(reply.status, 200);
  const item = received.at(-1);
  assert.equal(item.headers.authorization, "Bearer example");
  assert.equal(item.headers["x-aa-ingress-ip"], undefined);
  assert.equal(item.headers["x-real-ip"], undefined);
});

test("production config requires HTTPS and a high-entropy dedicated key", () => {
  const config = { NODE_ENV: "production", PUBLIC_INGRESS_UPSTREAM_URL: "https://example.com",
    PUBLIC_INGRESS_HMAC_KEY: secret, RAILWAY_PROJECT_ID: "ingress-project",
    PUBLIC_INGRESS_EXPECTED_PROJECT_ID: "ingress-project",
    PUBLIC_INGRESS_CORE_PROJECT_ID: "core-project" };
  assert.throws(() => validateConfig({ ...config, PUBLIC_INGRESS_UPSTREAM_URL: "http://example.com" }), /HTTPS/);
  assert.throws(() => validateConfig({ ...config, PUBLIC_INGRESS_UPSTREAM_URL: "https://runtime.attractacq.com" }), /cannot point/);
  assert.throws(() => validateConfig({ ...config, PUBLIC_INGRESS_HMAC_KEY: "short" }), /32 random bytes/);
  assert.throws(() => validateConfig({ ...config, PUBLIC_INGRESS_CORE_PROJECT_ID: "ingress-project" }), /separate Railway project/);
  assert.throws(() => validateConfig({ ...config, RAILWAY_TCP_PROXY_DOMAIN: "proxy.example" }), /TCP proxy/);
  assert.equal(validateConfig(config).upstream.origin, "https://example.com");
  assert.equal(isPublicPath("/public/sales/v1/widget.js"), true);
});

test("a slowly held public body has an absolute read deadline", async () => {
  const hanging = new PassThrough();
  hanging.headers = {};
  await assert.rejects(readBounded(hanging, 8192, 15), (error) => error.status === 408);
});
