// Authenticating as the AA GitHub App.
//
// Two credentials, two lifetimes, and the distinction matters:
//
//   The App private key is PLATFORM infrastructure. It lives in the runtime's
//   environment, is read here, and never leaves this process — not into a
//   database row, not into a log line, not into an HTTP response.
//
//   An installation access token is short-lived (GitHub expires it in an hour)
//   and is deliberately NEVER persisted. Minting one is cheap; storing one
//   turns a one-hour exposure into a permanent one.
//
// The App JWT is signed with RS256 using Node's own crypto, rather than pulling
// in a JWT library for one signature. Fewer dependencies in the one module that
// touches the platform's most sensitive credential is worth the twenty lines.

import { createSign } from "node:crypto";

export interface GitHubAppConfig {
  appId: string;
  privateKey: string;
  installationId: string | null;
}

/**
 * A failure that happened HERE, before anything was sent to GitHub.
 *
 * Almost always a private key the runtime cannot read: OpenSSL answers a
 * malformed PEM with `error:1E08010C:DECODER routines::unsupported`, which is
 * accurate, unreadable, and — reported as "GitHub rejected the connection" —
 * points whoever is debugging at entirely the wrong system.
 *
 * `message` is a fixed token rather than prose, so that even a caller who
 * renders `err.message` by accident cannot leak the cause. The cause is kept
 * for the server log and is never part of the safe message.
 */
export class GitHubSigningError extends Error {
  readonly safeMessage = "GitHub App private key could not be parsed by the runtime.";
  constructor(cause: unknown) {
    super("github_signing_failed", { cause });
    this.name = "GitHubSigningError";
  }
}

/**
 * GitHub was reached and answered no.
 *
 * The status code is ours to show — it is what a caller can act on, and it
 * carries nothing about the request. The response body never is: GitHub echoes
 * request detail into it, and detail about a request made with an App JWT is
 * not something to put in a browser.
 */
export class GitHubApiError extends Error {
  readonly status: number | null;
  readonly safeMessage: string;
  constructor(status: number | null, safeMessage?: string) {
    super(status === null ? "github_api_error" : `github_api_${status}`);
    this.name = "GitHubApiError";
    this.status = status;
    this.safeMessage =
      safeMessage ?? `GitHub rejected the connection request (HTTP ${status}).`;
  }
}

/** Base64url, which JWT uses and Buffer does not produce directly. */
function b64url(input: Buffer | string): string {
  return Buffer.from(input)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/**
 * A private key as GitHub gives it, however it survived the journey into an
 * environment variable.
 *
 * Railway and most secret stores turn a PEM's newlines into the two characters
 * `\` and `n`. A key that looks right and fails to sign is a miserable thing to
 * debug, so both forms are accepted, and so is base64 of the whole PEM for
 * stores that refuse multi-line values outright.
 */
export function normalisePrivateKey(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.includes("-----BEGIN")) {
    return trimmed.replace(/\\n/g, "\n");
  }
  // Not a PEM on its face — try base64 of one before giving up.
  try {
    const decoded = Buffer.from(trimmed, "base64").toString("utf8");
    if (decoded.includes("-----BEGIN")) return decoded.replace(/\\n/g, "\n");
  } catch {
    // fall through
  }
  return trimmed;
}

/**
 * A JWT proving we are the App.
 *
 * `iat` is backdated 60 seconds because GitHub rejects a token whose issued-at
 * is in the future, and a small clock skew between here and GitHub is normal.
 * Ten minutes is the maximum expiry GitHub accepts.
 */
export function mintAppJwt(config: GitHubAppConfig, now: number = Date.now()): string {
  const seconds = Math.floor(now / 1000);
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = b64url(
    JSON.stringify({ iat: seconds - 60, exp: seconds + 540, iss: config.appId }),
  );
  try {
    const signer = createSign("RSA-SHA256");
    signer.update(`${header}.${payload}`);
    signer.end();
    const signature = b64url(signer.sign(normalisePrivateKey(config.privateKey)));
    return `${header}.${payload}.${signature}`;
  } catch (cause) {
    // OpenSSL's complaint is about the key, so it is not safe to pass on and
    // not useful if it were. What the caller needs is which of the three
    // things went wrong, and that is what the type says.
    throw new GitHubSigningError(cause);
  }
}

const API = "https://api.github.com";

function headers(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "AA-Console-Sites",
  };
}

export interface InstallationInfo {
  installationId: number;
  account: string;
  targetType: string;
  repositorySelection: string;
  permissions: Record<string, string>;
}

/**
 * The installation this App acts through.
 *
 * Looks up the configured id when there is one, and otherwise asks GitHub which
 * installations exist — so a first connection works before anybody has copied
 * an id into the environment.
 */
export async function resolveInstallation(
  config: GitHubAppConfig,
  fetchImpl: typeof fetch = fetch,
): Promise<InstallationInfo> {
  const jwt = mintAppJwt(config);

  const path = config.installationId
    ? `/app/installations/${encodeURIComponent(config.installationId)}`
    : "/app/installations";
  const res = await fetchImpl(`${API}${path}`, { headers: headers(jwt) });

  if (!res.ok) {
    // The body can echo request details; the status is what a caller can act on.
    throw new GitHubApiError(res.status);
  }

  const body = (await res.json()) as unknown;
  const row = Array.isArray(body) ? body[0] : body;
  if (!row || typeof row !== "object") {
    throw new GitHubApiError(null, "The GitHub App is not installed anywhere.");
  }

  const r = row as Record<string, unknown>;
  const account = (r.account as Record<string, unknown> | undefined) ?? {};
  return {
    installationId: Number(r.id),
    account: String(account.login ?? "unknown"),
    targetType: String(account.type ?? r.target_type ?? "unknown"),
    repositorySelection: String(r.repository_selection ?? "unknown"),
    permissions: (r.permissions as Record<string, string>) ?? {},
  };
}

/**
 * A short-lived installation token, returned to the caller and never stored.
 *
 * Every caller is expected to use it and drop it. There is deliberately no
 * cache: a token in a variable for the length of one operation is a much
 * smaller thing to reason about than a token with a lifecycle.
 */
export async function mintInstallationToken(
  config: GitHubAppConfig,
  installationId: number,
  fetchImpl: typeof fetch = fetch,
): Promise<{ token: string; expiresAt: string }> {
  const jwt = mintAppJwt(config);
  const res = await fetchImpl(`${API}/app/installations/${installationId}/access_tokens`, {
    method: "POST",
    headers: headers(jwt),
  });
  if (!res.ok) {
    throw new GitHubApiError(res.status, `Could not mint an installation token (HTTP ${res.status}).`);
  }
  const body = (await res.json()) as { token?: string; expires_at?: string };
  if (!body.token) throw new GitHubApiError(null, "GitHub returned no installation token.");
  return { token: body.token, expiresAt: String(body.expires_at ?? "") };
}
