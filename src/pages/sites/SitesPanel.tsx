import { useCallback, useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { Plus } from "lucide-react";
import { Button } from "../../components/Button";
import { Panel } from "../../components/Panel";
import { EmptyState } from "../../components/EmptyState";
import { DataTable } from "../../components/DataTable";
import { FormModal } from "../../components/forms/FormModal";
import type { FieldDef } from "../../components/forms/fields";
import { supabase } from "../../lib/supabase";
import { cn } from "../../lib/cn";
import {
  provisionBlocker,
  repoStateLabel,
  type Installation,
  type SiteRepo,
} from "./readiness";

type Deployment = {
  id: string;
  page_id: string;
  sales_agent_id: string;
  allowed_origin: string;
  enabled: boolean;
  public_id: string;
  deployed_at: string | null;
};

type PageRow = { id: string; title: string; published_url: string | null; publish_status: string };
type AgentRow = { id: string; name: string };

const STATE_TONE: Record<string, string> = {
  ready: "bg-primary/10 text-brand-strong",
  provisioning: "bg-secondary text-secondary-foreground",
  failed: "bg-destructive/10 text-destructive",
  archived: "bg-muted text-muted-foreground",
};

export function SitesPanel() {
  const { clientId } = useParams<{ clientId: string }>();
  const [installs, setInstalls] = useState<Installation[]>([]);
  const [repos, setRepos] = useState<SiteRepo[]>([]);
  const [deployments, setDeployments] = useState<Deployment[]>([]);
  const [pages, setPages] = useState<PageRow[]>([]);
  const [agents, setAgents] = useState<AgentRow[]>([]);
  const [createOpen, setCreateOpen] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    if (!clientId) {
      setLoading(false);
      return;
    }
    const [inst, repoRes, depRes, pageRes, agentRes] = await Promise.all([
      supabase.from("github_app_installations").select("id, account_login, status"),
      supabase
        .from("client_site_repositories")
        .select("id, owner, repo, status, pages_url")
        .eq("client_id", clientId)
        .order("created_at", { ascending: false }),
      supabase
        .from("client_sales_agent_deployments")
        .select("id, page_id, sales_agent_id, allowed_origin, enabled, public_id, deployed_at")
        .eq("client_id", clientId)
        .order("created_at", { ascending: false }),
      supabase
        .from("client_pages")
        .select("id, title, published_url, publish_status")
        .eq("client_id", clientId),
      supabase.from("client_sales_agents").select("id, name").eq("client_id", clientId),
    ]);
    setInstalls((inst.data as Installation[] | null) ?? []);
    setRepos((repoRes.data as SiteRepo[] | null) ?? []);
    setDeployments((depRes.data as Deployment[] | null) ?? []);
    setPages((pageRes.data as PageRow[] | null) ?? []);
    setAgents((agentRes.data as AgentRow[] | null) ?? []);
    setLoading(false);
  }, [clientId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const blocker = provisionBlocker(installs);
  const pageTitle = (id: string) => pages.find((p) => p.id === id)?.title ?? "(page removed)";
  const agentName = (id: string) => agents.find((a) => a.id === id)?.name ?? "(agent removed)";

  const setEnabled = async (d: Deployment, enabled: boolean) => {
    setBusy(true);
    setProblem(null);
    const { error } = await supabase
      .from("client_sales_agent_deployments")
      .update({
        enabled,
        disabled_at: enabled ? null : new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq("id", d.id);
    setBusy(false);
    if (error) {
      setProblem(error.message);
      return;
    }
    // Taking an agent off a page has to be instant, so this says what actually
    // happened rather than "saved".
    setNotice(
      enabled
        ? "Agent enabled. It answers visitors on that page now."
        : "Agent disabled. It stops answering immediately — the page keeps its widget but the runtime refuses it.",
    );
    void refresh();
  };

  const fields: FieldDef[] = [
    {
      name: "repo",
      label: "Repository name",
      kind: "text",
      required: true,
      hint: "Lowercase, hyphens. This becomes part of the public URL.",
    },
  ];

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-foreground">Websites</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Where AA publishes this client's pages, and which agents are live on them.
          </p>
        </div>
        <Button icon={Plus} onClick={() => setCreateOpen(true)} disabled={blocker !== null}>
          Create Website Repo
        </Button>
      </div>

      {/* A disabled button with no stated reason is the most annoying thing a
          tool can do, so the reason is always on screen. */}
      {blocker && (
        <p className="mb-4 rounded-lg border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
          {blocker}
        </p>
      )}
      {notice && (
        <p role="status" className="mb-4 text-sm text-brand-strong">
          {notice}
        </p>
      )}
      {problem && (
        <p role="alert" className="mb-4 text-sm text-destructive">
          {problem}
        </p>
      )}

      {loading ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : (
        <div className="space-y-6">
          {repos.length === 0 ? (
            <EmptyState label="No website for this client yet" />
          ) : (
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {repos.map((r) => (
                <Panel key={r.id} title={`${r.owner}/${r.repo}`}>
                  <span
                    className={cn(
                      "inline-block rounded-full px-2 py-0.5 text-xs font-medium",
                      STATE_TONE[r.status] ?? "bg-muted text-muted-foreground",
                    )}
                  >
                    {repoStateLabel(r)}
                  </span>
                  {r.pages_url ? (
                    <a
                      href={r.pages_url}
                      target="_blank"
                      rel="noreferrer noopener"
                      className="mt-2 block truncate text-xs text-brand-strong hover:underline"
                    >
                      {r.pages_url}
                    </a>
                  ) : (
                    <p className="mt-2 text-xs text-muted-foreground">No public URL yet.</p>
                  )}
                </Panel>
              ))}
            </div>
          )}

          <div>
            <h3 className="mb-3 text-sm font-semibold text-foreground">Agents on pages</h3>
            <DataTable
              columns={["Page", "Agent", "Origin it accepts", "State", ""]}
              emptyLabel="No agent is attached to a page yet"
              rows={deployments.map((d) => [
                pageTitle(d.page_id),
                agentName(d.sales_agent_id),
                d.allowed_origin,
                <span
                  key="s"
                  className={cn(
                    "rounded-full px-2 py-0.5 text-xs font-medium",
                    d.enabled ? "bg-primary/10 text-brand-strong" : "bg-muted text-muted-foreground",
                  )}
                >
                  {d.enabled ? "Live" : "Disabled"}
                </span>,
                <button
                  key="a"
                  type="button"
                  disabled={busy}
                  onClick={() => void setEnabled(d, !d.enabled)}
                  className="rounded-md border border-border px-2.5 py-1 text-xs font-medium text-card-foreground hover:bg-accent disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  {d.enabled ? "Disable" : "Enable"}
                </button>,
              ])}
            />
          </div>
        </div>
      )}

      <FormModal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        title="Create Website Repo"
        draftKey={`site-repo:${clientId}`}
        intro="Creates an AA-managed repository ready to host pages and carry a sales agent. Publishing happens from the Conversion tab once this is ready."
        fields={fields}
        submitLabel="Create"
        onSubmit={async (v) => {
          if (!clientId) throw new Error("No client selected.");
          const install = installs.find((i) => i.status === "active");
          if (!install) throw new Error("No active GitHub installation.");
          const { error } = await supabase.from("client_site_repositories").insert({
            client_id: clientId,
            installation_id: install.id,
            owner: install.account_login,
            repo: (v.repo as string).trim().toLowerCase(),
            status: "provisioning",
          });
          if (error) throw new Error(error.message);
          setNotice("Website queued for creation.");
        }}
        onSaved={refresh}
      />
    </div>
  );
}
