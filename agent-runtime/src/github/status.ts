// What the console is told about the GitHub connection.
//
// The operator needs to know whether publishing will work before they try it,
// which today means reading Railway. That is the gap this closes. It closes it
// with metadata only: the App id and installation id are identifiers, the
// permission set is a fact about configuration, and none of it is a credential.
//
// The shape is allow-listed rather than filtered. Anything not named here does
// not reach a browser, so adding a field to the GitHub response later cannot
// quietly start leaking it.

import {
  GitHubApiError,
  GitHubSigningError,
  resolveInstallation,
  type GitHubAppConfig,
  type InstallationInfo,
} from "./app-auth.js";

/** What Phase 10.6 needs, and the level it needs. */
export const REQUIRED_PERMISSIONS: Record<string, string> = {
  administration: "write",
  contents: "write",
  pages: "write",
  metadata: "read",
};

/**
 * Where the connection actually broke.
 *
 * Three of these look identical on a status screen that only has "failing",
 * and each needs a different person to do a different thing:
 *
 *   configuration_error — nobody has given the runtime credentials yet.
 *   auth_signing_error  — the key is there and the runtime cannot read it.
 *                         Nothing was sent to GitHub; GitHub has no opinion.
 *   github_api_error    — GitHub was asked and said no, or was unreachable.
 *   permission_error    — GitHub answered perfectly well. The grants are short.
 *
 * The last one is not a failure of the connection at all, which is why it
 * carries no error message: the permission matrix is the explanation.
 */
export type GitHubErrorKind =
  | "configuration_error"
  | "auth_signing_error"
  | "github_api_error"
  | "permission_error";

export interface PermissionCheck {
  permission: string;
  current: string | null;
  required: string;
  sufficient: boolean;
}

export interface GitHubStatus {
  configured: boolean;
  /** Present only when the env is incomplete — names of what is missing, never values. */
  missing: string[];
  appId: string | null;
  installationId: number | null;
  owner: string | null;
  targetType: string | null;
  repositorySelection: string | null;
  permissions: PermissionCheck[];
  ready: boolean;
  verifiedAt: string | null;
  /** Which of the four things went wrong, or null when nothing did. */
  errorKind: GitHubErrorKind | null;
  /** A whole sentence, safe to render. Never a raw error from anywhere. */
  error: string | null;
}

/** `write` satisfies a `read` requirement; `read` does not satisfy `write`. */
export function satisfies(current: string | null, required: string): boolean {
  if (!current) return false;
  if (required === "read") return current === "read" || current === "write" || current === "admin";
  if (required === "write") return current === "write" || current === "admin";
  return current === required;
}

export function checkPermissions(granted: Record<string, string>): PermissionCheck[] {
  return Object.entries(REQUIRED_PERMISSIONS).map(([permission, required]) => {
    const current = granted[permission] ?? null;
    return { permission, current, required, sufficient: satisfies(current, required) };
  });
}

/**
 * An unknown error, rendered as a fixed sentence.
 *
 * The classification is by TYPE, not by reading the message: a thrown error's
 * text is unknown text, and unknown text is not safe to put in a browser. So
 * anything the auth layer did not raise deliberately — a DNS failure carrying a
 * hostname, a TLS error, an unexpected throw — collapses to one safe line, and
 * only the two typed errors get to supply their own wording.
 */
export function classifyError(err: unknown): { kind: GitHubErrorKind; message: string } {
  if (err instanceof GitHubSigningError) {
    return { kind: "auth_signing_error", message: err.safeMessage };
  }
  if (err instanceof GitHubApiError) {
    return { kind: "github_api_error", message: err.safeMessage };
  }
  return { kind: "github_api_error", message: "Could not reach GitHub." };
}

/**
 * Which env names are absent.
 *
 * Names only. A status screen that says "GITHUB_APP_PRIVATE_KEY is missing" is
 * useful; one that shows any part of its value is a leak with a helpful label.
 */
export function missingConfig(config: Partial<GitHubAppConfig>): string[] {
  const missing: string[] = [];
  if (!config.appId) missing.push("GITHUB_APP_ID");
  if (!config.privateKey) missing.push("GITHUB_APP_PRIVATE_KEY");
  return missing;
}

/** The status when the runtime has not been given credentials at all. */
export function unconfiguredStatus(missing: string[]): GitHubStatus {
  return {
    configured: false,
    missing,
    errorKind: missing.length > 0 ? "configuration_error" : null,
    appId: null,
    installationId: null,
    owner: null,
    targetType: null,
    repositorySelection: null,
    permissions: checkPermissions({}),
    ready: false,
    verifiedAt: null,
    error: null,
  };
}

/** A live installation turned into the console's view of it. */
export function statusFromInstallation(
  appId: string,
  info: InstallationInfo,
  now: Date = new Date(),
): GitHubStatus {
  const permissions = checkPermissions(info.permissions);
  const ready = permissions.every((p) => p.sufficient);
  return {
    configured: true,
    missing: [],
    // Reached GitHub, read the grants, and they fall short. That is a
    // permission problem and must not be dressed up as a connection one.
    errorKind: ready ? null : "permission_error",
    appId,
    installationId: info.installationId,
    owner: info.account,
    targetType: info.targetType,
    repositorySelection: info.repositorySelection,
    permissions,
    ready,
    verifiedAt: now.toISOString(),
    error: null,
  };
}

/**
 * Ask GitHub, and turn whatever comes back into something safe to render.
 *
 * A failure is reported as a status with an error rather than thrown, because
 * "our credentials are wrong" is exactly what the screen exists to show. What
 * it shows is a safe sentence chosen by classifyError — never a raw error, and
 * never anything from a GitHub response body, which can echo request details.
 */
export async function readGitHubStatus(
  config: Partial<GitHubAppConfig>,
  fetchImpl: typeof fetch = fetch,
  now: Date = new Date(),
): Promise<GitHubStatus> {
  const missing = missingConfig(config);
  if (missing.length > 0) return unconfiguredStatus(missing);

  const full: GitHubAppConfig = {
    appId: config.appId as string,
    privateKey: config.privateKey as string,
    installationId: config.installationId ?? null,
  };

  try {
    const info = await resolveInstallation(full, fetchImpl);
    return statusFromInstallation(full.appId, info, now);
  } catch (err) {
    const { kind, message } = classifyError(err);
    return {
      ...unconfiguredStatus([]),
      configured: true,
      appId: full.appId,
      errorKind: kind,
      error: message,
      verifiedAt: now.toISOString(),
    };
  }
}
