import { useCallback, useEffect, useState } from "react";
import { Panel } from "../../components/Panel";
import { DataTable } from "../../components/DataTable";
import { supabase } from "../../lib/supabase";
import { cn } from "../../lib/cn";


type PermissionCheck = {
  permission: string;
  current: string | null;
  required: string;
  sufficient: boolean;
};

type Status = {
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
  error: string | null;
};

/**
 * Whether publishing will work, answered inside the console.
 *
 * Until now the only way to know whether GitHub was configured was to open
 * Railway. That is fine for whoever set it up and useless for everyone else,
 * and it is a bad thing to discover halfway through publishing a client's site.
 *
 * Everything here is metadata. The App id and installation id are identifiers,
 * the permission set is a fact about configuration, and the private key is
 * never sent — the runtime reads it server-side and returns only this shape.
 */
export function GitHubSettingsPanel() {
  const [status, setStatus] = useState<Status | null>(null);
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
      const body = (await res.json()) as { ok?: boolean; error?: string } & Partial<Status>;
      if (!res.ok || body.ok !== true) {
        setProblem(body.error ?? "Could not check the GitHub connection.");
        setStatus(null);
      } else {
        setStatus(body as Status);
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

  const state = !status
    ? { label: "Unknown", tone: "bg-muted text-muted-foreground" }
    : !status.configured
      ? { label: "Not connected", tone: "bg-destructive/10 text-destructive" }
      : status.error
        ? { label: "Failing", tone: "bg-destructive/10 text-destructive" }
        : status.ready
          ? { label: "Connected", tone: "bg-primary/10 text-brand-strong" }
          : { label: "Permissions short", tone: "bg-destructive/10 text-destructive" };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-foreground">GitHub</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            The account AA publishes client sites through. Credentials live on the server and are
            never sent to this page.
          </p>
        </div>
        <button
          type="button"
          disabled={loading}
          onClick={() => void verify()}
          className="rounded-md border border-border px-2.5 py-1 text-xs font-medium text-card-foreground hover:bg-accent disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {loading ? "Checking…" : "Verify connection"}
        </button>
      </div>

      {problem && (
        <p role="alert" className="text-sm text-destructive">
          {problem}
        </p>
      )}

      {status && (
        <>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Panel title="Status">
              <span
                className={cn("inline-block rounded-full px-2 py-0.5 text-xs font-medium", state.tone)}
              >
                {state.label}
              </span>
              {status.verifiedAt && (
                <p className="mt-2 text-xs text-muted-foreground">
                  Checked {new Date(status.verifiedAt).toLocaleString()}
                </p>
              )}
            </Panel>
            <Panel title="Organisation">
              <p className="text-sm text-card-foreground">{status.owner ?? "—"}</p>
              <p className="mt-1 text-xs text-muted-foreground">
                {status.targetType ?? "—"}
                {status.repositorySelection ? ` · ${status.repositorySelection} repositories` : ""}
              </p>
            </Panel>
            <Panel title="App ID">
              <p className="text-sm text-card-foreground">{status.appId ?? "—"}</p>
            </Panel>
            <Panel title="Installation ID">
              <p className="text-sm text-card-foreground">{status.installationId ?? "—"}</p>
            </Panel>
          </div>

          {status.missing.length > 0 && (
            <p role="alert" className="text-sm text-destructive">
              {/* Names only. A status screen naming the variable is useful; one
                  showing any part of its value is a leak with a helpful label. */}
              Not configured on the server. Missing: {status.missing.join(", ")}.
            </p>
          )}

          {status.error && (
            <p role="alert" className="text-sm text-destructive">
              GitHub rejected the connection: {status.error}
            </p>
          )}

          <div>
            <h3 className="mb-2 text-sm font-semibold text-foreground">Permissions</h3>
            <DataTable
              columns={["Permission", "Granted", "Needed", ""]}
              emptyLabel="Not checked yet"
              rows={status.permissions.map((p) => [
                p.permission,
                p.current ?? "none",
                p.required,
                <span
                  key="v"
                  className={cn(
                    "rounded-full px-2 py-0.5 text-xs font-medium",
                    p.sufficient
                      ? "bg-primary/10 text-brand-strong"
                      : "bg-destructive/10 text-destructive",
                  )}
                >
                  {p.sufficient ? "OK" : "Insufficient"}
                </span>,
              ])}
            />
            {!status.ready && status.configured && !status.error && (
              <p className="mt-2 text-xs text-muted-foreground">
                Publishing needs every permission above. Change them on the GitHub App, then accept
                the update on the installation — GitHub does not apply new permissions until the
                installation approves them.
              </p>
            )}
          </div>
        </>
      )}
    </div>
  );
}
