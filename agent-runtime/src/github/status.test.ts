import { describe, expect, it } from "vitest";
import {
  checkPermissions,
  classifyError,
  missingConfig,
  readGitHubStatus,
  satisfies,
  statusFromInstallation,
  unconfiguredStatus,
  REQUIRED_PERMISSIONS,
} from "./status.js";
import {
  GitHubApiError,
  GitHubSigningError,
  mintAppJwt,
  normalisePrivateKey,
} from "./app-auth.js";
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
      "appId", "configured", "error", "errorKind", "installationId", "missing",
      "owner", "permissions", "ready", "repositorySelection", "targetType",
      "verifiedAt",
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
    expect(status.errorKind).toBe("github_api_error");
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


// The bug this suite exists for: a private key the runtime could not read was
// reported to the operator as "GitHub rejected the connection", naming the one
// system that had not been contacted. Three failures that look alike on a
// status screen need three different people to do three different things, so
// the status has to say which one it is.
describe("classifying what went wrong", () => {
  const MALFORMED = "-----BEGIN RSA PRIVATE KEY-----\nnot actually a key\n-----END RSA PRIVATE KEY-----";

  it("calls an unreadable private key a signing error, not a GitHub refusal", async () => {
    let reached = false;
    const status = await readGitHubStatus(
      { appId: "123456", privateKey: MALFORMED, installationId: "1" },
      (async () => {
        reached = true;
        return new Response("{}");
      }) as never,
    );

    // Nothing was sent, so GitHub cannot have rejected anything.
    expect(reached).toBe(false);
    expect(status.errorKind).toBe("auth_signing_error");
    expect(status.error).toBe("GitHub App private key could not be parsed by the runtime.");
    expect(status.ready).toBe(false);
    expect(status.configured).toBe(true);
  });

  it("does not put OpenSSL's complaint in front of the operator", async () => {
    const status = await readGitHubStatus(
      { appId: "123456", privateKey: MALFORMED, installationId: "1" },
      (async () => new Response("{}")) as never,
    );
    const serialised = JSON.stringify(status);
    // The exact string that shipped to production, and the shape of its family.
    expect(serialised).not.toContain("DECODER");
    expect(serialised).not.toContain("1E08010C");
    expect(serialised).not.toMatch(/error:[0-9A-F]{8}:/);
    expect(serialised).not.toContain("routines");
    // Nor the key that failed to parse.
    expect(serialised).not.toContain("BEGIN");
    expect(serialised).not.toContain("not actually a key");
  });

  it("keeps the raw cause on the server, where it is worth having", () => {
    // Dropping it entirely would trade one debugging problem for another.
    let caught: unknown;
    try {
      mintAppJwt({ appId: "1", privateKey: MALFORMED, installationId: null });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(GitHubSigningError);
    expect((caught as GitHubSigningError).cause).toBeDefined();
    // Even the Error's own message is safe, in case a caller renders it.
    expect((caught as Error).message).not.toContain("DECODER");
  });

  it("calls a GitHub 403 an API error and shows the status, never the body", async () => {
    const status = await readGitHubStatus(
      { appId: "123456", privateKey, installationId: "1" },
      (async () =>
        new Response(JSON.stringify({ message: "Resource not accessible", token: "ghs_leak" }), {
          status: 403,
        })) as never,
    );
    expect(status.errorKind).toBe("github_api_error");
    expect(status.error).toContain("403");
    expect(status.error).not.toContain("Resource not accessible");
    expect(JSON.stringify(status)).not.toContain("ghs_leak");
  });

  it("does not call a permission shortfall a connection failure", async () => {
    const status = await readGitHubStatus(
      { appId: "123456", privateKey, installationId: "1" },
      (async () =>
        new Response(
          JSON.stringify({
            id: 12345678,
            account: { login: "AttractAcq", type: "Organization" },
            repository_selection: "selected",
            permissions: { ...GRANTED, pages: "read", administration: undefined },
          }),
          { status: 200 },
        )) as never,
    );

    // The connection resolved. The installation is real and readable.
    expect(status.configured).toBe(true);
    expect(status.errorKind).toBe("permission_error");
    expect(status.error).toBeNull();
    expect(status.owner).toBe("AttractAcq");
    expect(status.installationId).toBe(12345678);
    expect(status.repositorySelection).toBe("selected");
    // And the matrix is the real one, not four blank rows.
    expect(status.ready).toBe(false);
    expect(status.permissions.find((p) => p.permission === "pages")?.current).toBe("read");
    expect(status.permissions.find((p) => p.permission === "contents")?.sufficient).toBe(true);
    expect(status.permissions.filter((p) => !p.sufficient).map((p) => p.permission).sort()).toEqual([
      "administration",
      "pages",
    ]);
  });

  it("calls absent env vars a configuration error, by name and never by value", async () => {
    const status = await readGitHubStatus({ privateKey: "-----BEGIN PRIVATE KEY-----shhh" });
    expect(status.errorKind).toBe("configuration_error");
    expect(status.missing).toEqual(["GITHUB_APP_ID"]);
    expect(status.error).toBeNull();
    const serialised = JSON.stringify(status);
    expect(serialised).not.toContain("shhh");
    expect(serialised).not.toContain("BEGIN");
  });

  it("reports a healthy connection as no error at all", async () => {
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
    expect(status.errorKind).toBeNull();
    expect(status.ready).toBe(true);
  });
});

describe("classifyError", () => {
  it("classifies by type, so an unknown throw cannot choose its own wording", () => {
    // A DNS failure carries a hostname; a TLS error carries a chain. Neither is
    // ours to render, and neither is predictable enough to sanitise by reading.
    const leaky = new Error("getaddrinfo ENOTFOUND internal-proxy.attractacq.local");
    const { kind, message } = classifyError(leaky);
    expect(kind).toBe("github_api_error");
    expect(message).toBe("Could not reach GitHub.");
    expect(message).not.toContain("internal-proxy");
  });

  it("lets only the two deliberate errors supply their own message", () => {
    expect(classifyError(new GitHubSigningError(new Error("x")))).toEqual({
      kind: "auth_signing_error",
      message: "GitHub App private key could not be parsed by the runtime.",
    });
    expect(classifyError(new GitHubApiError(401))).toEqual({
      kind: "github_api_error",
      message: "GitHub rejected the connection request (HTTP 401).",
    });
  });

  it("survives something that is not an Error at all", () => {
    expect(classifyError("boom").message).toBe("Could not reach GitHub.");
    expect(classifyError(undefined).kind).toBe("github_api_error");
  });
});
