import { useCallback, useEffect, useState } from "react";
import { supabase } from "./supabase";

export type PermissionCheck = {
  permission: string;
  current: string | null;
  required: string;
  sufficient: boolean;
};

export type ErrorKind =
  | "configuration_error"
  | "auth_signing_error"
  | "github_api_error"
  | "permission_error";

export type GitHubStatus = {
  configured: boolean;
  missing: string[];
  appId: string | null;
  installationId: number | null;
  owner: string | null;
  targetType: string | null;
  repositorySelection: string | null;
  permissions: PermissionCheck[];
  ready: boolean;
  verifiedAt: string | null;
  errorKind: ErrorKind | null;
  error: string | null;
};

/**
 * Whether GitHub is actually connected, asked of GitHub.
 *
 * Shared because it was not, and the two screens disagreed. Sites → Settings
 * asked this endpoint and said Connected; Sites → Overview gated on a row in
 * github_app_installations that nothing wrote, so it said "connect the GitHub
 * App" no matter what was true. One fact, one source.
 */
export function useGitHubStatus() {
  const [status, setStatus] = useState<GitHubStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [problem, setProblem] = useState<string | null>(null);

  const verify = useCallback(async () => {
    setLoading(true);
    setProblem(null);
    const base = (import.meta.env.VITE_AGENT_RUNTIME_URL as string | undefined)?.replace(/\/+$/, "");
    if (!base) {
      setProblem("The agent runtime URL is not configured, so GitHub cannot be checked from here.");
      setLoading(false);
      return;
    }
    try {
      const { data } = await supabase.auth.getSession();
      const token = data.session?.access_token;
      const res = await fetch(`${base}/admin/github/status`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      const body = (await res.json()) as { ok?: boolean; error?: string } & Partial<GitHubStatus>;
      if (!res.ok || body.ok !== true) {
        setProblem(body.error ?? "Could not check the GitHub connection.");
        setStatus(null);
      } else {
        setStatus(body as GitHubStatus);
      }
    } catch {
      setProblem("Could not reach the agent runtime.");
      setStatus(null);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    void verify();
  }, [verify]);

  return { status, loading, problem, verify };
}

/**
 * Why a site cannot be provisioned yet, or null.
 *
 * Every branch names the thing to go and fix. "Not connected" on its own sends
 * whoever read it to guess between Railway, the App and the installation.
 */
export function provisionBlockerFromStatus(
  status: GitHubStatus | null,
  loading: boolean,
): string | null {
  if (loading) return "Checking the GitHub connection…";
  if (!status) return "Could not check the GitHub connection. Open Settings → GitHub.";
  if (!status.configured) {
    return `The runtime has no GitHub credentials yet${status.missing.length ? ` (missing ${status.missing.join(", ")})` : ""}.`;
  }
  if (status.errorKind === "auth_signing_error") {
    return "The GitHub App private key cannot be read by the runtime. See Settings → GitHub.";
  }
  if (status.error) return `${status.error} See Settings → GitHub.`;
  if (!status.ready) {
    const short = status.permissions.filter((p) => !p.sufficient).map((p) => p.permission);
    return `The GitHub App is short of permissions: ${short.join(", ")}. See Settings → GitHub.`;
  }
  // A GitHub App cannot create a repository on a personal account at all, so
  // this is worth saying before somebody names a repo and presses Create.
  if (status.targetType && status.targetType !== "Organization") {
    return `The GitHub App is installed on ${status.owner ?? "a user account"}, which is a ${status.targetType} account. Creating repositories needs an Organization installation.`;
  }
  return null;
}
