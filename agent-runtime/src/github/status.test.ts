import { describe, expect, it } from "vitest";
import {
  checkPermissions,
  missingConfig,
  readGitHubStatus,
  satisfies,
  statusFromInstallation,
  unconfiguredStatus,
  REQUIRED_PERMISSIONS,
} from "./status.js";
import { mintAppJwt, normalisePrivateKey } from "./app-auth.js";
import { generateKeyPairSync } from "node:crypto";

const { privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});

const GRANTED = { administration: "write", contents: "write", pages: "write", metadata: "read" };

const installation = (over: Record<string, unknown> = {}) => ({
  installationId: 12345678,
  account: "AttractAcq",
  targetType: "Organization",
  repositorySelection: "all",
  permissions: GRANTED,
  ...over,
});

describe("satisfies", () => {
  it("lets write satisfy a read requirement", () => {
    expect(satisfies("write", "read")).toBe(true);
    expect(satisfies("admin", "write")).toBe(true);
  });
  it("does not let read satisfy write — the mistake that fails at push time", () => {
    expect(satisfies("read", "write")).toBe(false);
  });
  it("treats a missing permission as insufficient", () => {
    expect(satisfies(null, "read")).toBe(false);
  });
});

describe("checkPermissions", () => {
  it("reports every permission Phase 10.6 needs", () => {
    const checks = checkPermissions(GRANTED);
    expect(checks.map((c) => c.permission).sort()).toEqual(
      Object.keys(REQUIRED_PERMISSIONS).sort(),
    );
    expect(checks.every((c) => c.sufficient)).toBe(true);
  });

  it("names the one that is short rather than failing as a whole", () => {
    const checks = checkPermissions({ ...GRANTED, pages: "read" });
    const pages = checks.find((c) => c.permission === "pages");
    expect(pages?.sufficient).toBe(false);
    expect(pages?.current).toBe("read");
    expect(checks.filter((c) => !c.sufficient)).toHaveLength(1);
  });

  it("does not require Workflows, which branch publishing does not need", () => {
    expect(Object.keys(REQUIRED_PERMISSIONS)).not.toContain("workflows");
  });
});

describe("missingConfig", () => {
  it("returns env NAMES, never values", () => {
    const missing = missingConfig({});
    expect(missing).toEqual(["GITHUB_APP_ID", "GITHUB_APP_PRIVATE_KEY"]);
  });
  it("does not require an installation id, which can be discovered", () => {
    expect(missingConfig({ appId: "1", privateKey: "k" })).toEqual([]);
  });

  it("still reports only names when the OTHER variable is set", () => {
    // The empty-config case cannot catch a leak: with nothing set, a value and
    // a name are indistinguishable. This is the case that can.
    expect(missingConfig({ privateKey: "-----BEGIN PRIVATE KEY-----secret" }))
      .toEqual(["GITHUB_APP_ID"]);
    expect(missingConfig({ appId: "123456" })).toEqual(["GITHUB_APP_PRIVATE_KEY"]);
    expect(JSON.stringify(missingConfig({ privateKey: "sensitive" }))).not.toContain("sensitive");
  });
});

describe("what reaches the browser", () => {
  it("never contains the private key, a token, or anything key-shaped", () => {
    const status = statusFromInstallation("123456", installation());
    const serialised = JSON.stringify(status);
    for (const forbidden of ["BEGIN", "PRIVATE KEY", "ghs_", "ghu_", "token", "privateKey", "secret"]) {
      expect(serialised).not.toContain(forbidden);
    }
  });

  it("carries only identifiers and configuration facts", () => {
    const status = statusFromInstallation("123456", installation());
    expect(Object.keys(status).sort()).toEqual([
      "appId", "configured", "error", "installationId", "missing", "owner",
      "permissions", "ready", "repositorySelection", "targetType", "verifiedAt",
    ]);
  });

  it("is not ready when a permission is short", () => {
    const status = statusFromInstallation("1", installation({ permissions: { ...GRANTED, contents: "read" } }));
    expect(status.ready).toBe(false);
    expect(status.configured).toBe(true);
  });

  it("is unconfigured, not broken, when env vars are absent", () => {
    const status = unconfiguredStatus(["GITHUB_APP_ID"]);
    expect(status.configured).toBe(false);
    expect(status.ready).toBe(false);
    expect(status.error).toBeNull();
    expect(status.missing).toEqual(["GITHUB_APP_ID"]);
  });
});

describe("readGitHubStatus", () => {
  it("reports missing configuration without calling GitHub", async () => {
    let called = false;
    const status = await readGitHubStatus({}, (async () => { called = true; return new Response("{}"); }) as never);
    expect(called).toBe(false);
    expect(status.missing).toContain("GITHUB_APP_ID");
  });

  it("turns a GitHub rejection into a status, not a crash", async () => {
    const status = await readGitHubStatus(
      { appId: "1", privateKey, installationId: "99" },
      (async () => new Response("nope", { status: 401 })) as never,
    );
    expect(status.configured).toBe(true);
    expect(status.ready).toBe(false);
    expect(status.error).toMatch(/401/);
    // The body is never echoed — it can carry request detail.
    expect(status.error).not.toContain("nope");
  });

  it("reports a healthy installation", async () => {
    const status = await readGitHubStatus(
      { appId: "123456", privateKey, installationId: "12345678" },
      (async () =>
        new Response(
          JSON.stringify({
            id: 12345678,
            account: { login: "AttractAcq", type: "Organization" },
            repository_selection: "all",
            permissions: GRANTED,
          }),
          { status: 200 },
        )) as never,
    );
    expect(status.ready).toBe(true);
    expect(status.owner).toBe("AttractAcq");
    expect(status.installationId).toBe(12345678);
  });
});

describe("app JWT", () => {
  it("signs with the App id as issuer and stays inside GitHub's ten-minute limit", () => {
    const now = 1_760_000_000_000;
    const jwt = mintAppJwt({ appId: "123456", privateKey, installationId: null }, now);
    const [, payload] = jwt.split(".");
    const claims = JSON.parse(Buffer.from(payload as string, "base64url").toString("utf8"));
    expect(claims.iss).toBe("123456");
    // Backdated, because GitHub rejects a future iat and clocks drift.
    expect(claims.iat).toBeLessThan(Math.floor(now / 1000));
    expect(claims.exp - claims.iat).toBeLessThanOrEqual(600);
  });

  it("accepts a key whose newlines survived as literal backslash-n", () => {
    // Railway and most secret stores do this. A key that looks right and will
    // not sign is a miserable thing to debug.
    const escaped = privateKey.replace(/\n/g, "\\n");
    // Compared trimmed: a PEM's trailing newline is harmless and signing works
    // either way, so the assertion is about the newlines that matter.
    expect(normalisePrivateKey(escaped).trim()).toBe(privateKey.trim());
    expect(() => mintAppJwt({ appId: "1", privateKey: escaped, installationId: null })).not.toThrow();
  });

  it("accepts a base64-wrapped PEM for stores that refuse multi-line values", () => {
    const b64 = Buffer.from(privateKey).toString("base64");
    expect(normalisePrivateKey(b64).trim()).toBe(privateKey.trim());
    expect(() => mintAppJwt({ appId: "1", privateKey: b64, installationId: null })).not.toThrow();
  });
});

describe("nothing secret can reach the browser by construction", () => {
  it("the status shape has no field that could hold a credential", async () => {
    // Allow-listed, not filtered: a new field on GitHub's response cannot
    // quietly start flowing through.
    const status = await readGitHubStatus(
      { appId: "123456", privateKey, installationId: "1" },
      (async () =>
        new Response(
          JSON.stringify({
            id: 1,
            account: { login: "AttractAcq", type: "Organization" },
            repository_selection: "all",
            permissions: GRANTED,
            // Things GitHub does or might return that must not pass through:
            access_tokens_url: "https://api.github.com/app/installations/1/access_tokens",
            token: "ghs_supersecret",
            client_secret: "abc123",
          }),
          { status: 200 },
        )) as never,
    );
    const serialised = JSON.stringify(status);
    expect(serialised).not.toContain("ghs_");
    expect(serialised).not.toContain("abc123");
    expect(serialised).not.toContain("access_tokens_url");
    expect(serialised).not.toContain("client_secret");
  });
});
