import { describe, expect, it } from "vitest";
import { provisionBlockerFromStatus, type GitHubStatus } from "./useGitHubStatus";

const GRANTED = [
  { permission: "administration", current: "write", required: "write", sufficient: true },
  { permission: "contents", current: "write", required: "write", sufficient: true },
  { permission: "pages", current: "write", required: "write", sufficient: true },
  { permission: "metadata", current: "read", required: "read", sufficient: true },
];

const connected = (over: Partial<GitHubStatus> = {}): GitHubStatus => ({
  configured: true,
  missing: [],
  appId: "4932777",
  installationId: 161987579,
  owner: "AttractAcq-Sites",
  targetType: "Organization",
  repositorySelection: "all",
  permissions: GRANTED,
  ready: true,
  verifiedAt: "2026-09-15T19:57:46.000Z",
  errorKind: null,
  error: null,
  ...over,
});

// The bug this replaces: Sites → Overview gated on a row in
// github_app_installations that nothing ever wrote, so it said "connect the AA
// GitHub App" while Sites → Settings, asking GitHub, said Connected. The gate
// now asks the same question the Settings tab does.
describe("provisionBlockerFromStatus", () => {
  it("allows provisioning when GitHub says the org installation is good", () => {
    expect(provisionBlockerFromStatus(connected(), false)).toBeNull();
  });

  it("does not block on a table, which is what went wrong before", () => {
    // Nothing about the answer depends on local state — only on GitHub.
    expect(provisionBlockerFromStatus(connected(), false)).toBeNull();
  });

  it("says so while the check is still running, rather than reading as broken", () => {
    expect(provisionBlockerFromStatus(null, true)).toMatch(/checking/i);
  });

  it("names the missing variables when the runtime has no credentials", () => {
    const blocker = provisionBlockerFromStatus(
      connected({ configured: false, missing: ["GITHUB_APP_ID"], ready: false }),
      false,
    );
    expect(blocker).toContain("GITHUB_APP_ID");
  });

  it("distinguishes an unreadable key from a refusal by GitHub", () => {
    const blocker = provisionBlockerFromStatus(
      connected({
        ready: false,
        errorKind: "auth_signing_error",
        error: "GitHub App private key could not be parsed by the runtime.",
      }),
      false,
    );
    expect(blocker).toMatch(/private key cannot be read/i);
  });

  it("names the permissions that are short, not just 'not ready'", () => {
    const blocker = provisionBlockerFromStatus(
      connected({
        ready: false,
        errorKind: "permission_error",
        permissions: GRANTED.map((p) =>
          p.permission === "pages" ? { ...p, current: "read", sufficient: false } : p,
        ),
      }),
      false,
    );
    expect(blocker).toContain("pages");
    expect(blocker).not.toContain("contents");
  });

  it("refuses a personal-account installation, where creating a repo is impossible", () => {
    // A GitHub App cannot create a repository on a user account at all, so this
    // has to be said before somebody names a repo and presses Create.
    const blocker = provisionBlockerFromStatus(
      connected({ owner: "AttractAcq", targetType: "User" }),
      false,
    );
    expect(blocker).toMatch(/Organization installation/i);
    expect(blocker).toContain("AttractAcq");
  });

  it("sends the reader to the screen that can fix it", () => {
    const blocker = provisionBlockerFromStatus(
      connected({ ready: false, errorKind: "github_api_error", error: "GitHub rejected the connection request (HTTP 401)." }),
      false,
    );
    expect(blocker).toMatch(/Settings → GitHub/);
  });

  it("does not claim everything is fine when the check could not run", () => {
    expect(provisionBlockerFromStatus(null, false)).not.toBeNull();
  });
});
