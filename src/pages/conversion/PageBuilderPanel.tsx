import { useCallback, useEffect, useMemo, useState } from "react";
import { useParams } from "react-router-dom";
import { Plus, Trash2 } from "lucide-react";
import { Button } from "../../components/Button";
import { Panel } from "../../components/Panel";
import { EmptyState } from "../../components/EmptyState";
import { FormModal } from "../../components/forms/FormModal";
import type { FieldDef } from "../../components/forms/fields";
import { AgentActivityBar } from "../../components/agents/AgentActivityBar";
import { useAgentJobs } from "../../lib/useAgentJobs";
import { supabase } from "../../lib/supabase";
import { PublishButton } from "../../components/sites/PublishButton";
import type { SiteRepo } from "../sites/readiness";
import { PagePreview } from "../../components/pages/PagePreview";
import { PagePolish } from "./PagePolish";

type Page = {
  id: string;
  title: string;
  status: string;
  body: string | null;
  published_url: string | null;
  publish_status: string;
  site_repository_id: string | null;
  created_at: string;
  html: string | null;
  current_revision: number | null;
  meta_title: string | null;
  meta_description: string | null;
  built_at: string | null;
};

type CampaignOption = {
  id: string;
  name: string;
  status: string;
};

type PageCampaignLink = {
  id: string;
  page_id: string;
  campaign_id: string;
};

export type PageBuilderType = "landing" | "offer" | "recruitment";

/**
 * @param clientId Overrides the route's client. Recruitment pages live on the
 *   Attract Acquisition house client and are reached from Team, which has no
 *   client in its URL at all.
 */
export function PageBuilderPanel({
  pageType = "landing",
  clientId: clientIdProp,
}: {
  pageType?: PageBuilderType;
  clientId?: string;
}) {
  const [buildOpen, setBuildOpen] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const { clientId: routeClientId } = useParams<{ clientId: string }>();
  const clientId = clientIdProp ?? routeClientId;
  // A hiring page has no campaign to belong to. AA is not running a campaign
  // for itself; it is filling a role.
  const isRecruitment = pageType === "recruitment";
  const [pages, setPages] = useState<Page[]>([]);
  const [campaigns, setCampaigns] = useState<CampaignOption[]>([]);
  const [pageLinks, setPageLinks] = useState<PageCampaignLink[]>([]);
  const [repos, setRepos] = useState<SiteRepo[]>([]);
  const [campaignSelections, setCampaignSelections] = useState<Record<string, string>>({});
  const [busyPageId, setBusyPageId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [loadError, setLoadError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoadError(null);
    try {
      if (!clientId) return;
      const [pageRows, campaignRows, linkRows, repoRows] = await Promise.all([
        supabase
          .from("client_pages")
          .select(
            "id, title, status, body, published_url, publish_status, site_repository_id, created_at, html, current_revision, meta_title, meta_description, built_at",
          )
          .eq("client_id", clientId)
          .eq("page_type", pageType)
          .order("created_at", { ascending: false }),
        isRecruitment
          ? Promise.resolve({ data: [], error: null })
          : supabase
          .from("client_campaigns")
          .select("id, name, status")
          .eq("client_id", clientId)
          .order("created_at", { ascending: false }),
        isRecruitment
          ? Promise.resolve({ data: [], error: null })
          : supabase
          .from("campaign_artifacts")
          .select("id, page_id, campaign_id")
          .eq("client_id", clientId)
          .eq("kind", "landing_page"),
        // The site this client's pages publish onto. One site holds many
        // pages, each at its own path.
        supabase
          .from("client_site_repositories")
          .select("id, owner, repo, status, pages_url")
          .eq("client_id", clientId),
      ]);
      if (pageRows.error) throw pageRows.error;
      if (campaignRows.error) throw campaignRows.error;
      if (linkRows.error) throw linkRows.error;
      setPages((pageRows.data ?? []) as Page[]);
      setCampaigns((campaignRows.data ?? []) as CampaignOption[]);
      const links = (linkRows.data ?? []) as PageCampaignLink[];
      setPageLinks(links);
      setRepos((repoRows.data ?? []) as SiteRepo[]);
      setCampaignSelections((previous) => {
        const selections: Record<string, string> = {};
        for (const page of (pageRows.data ?? []) as Page[]) {
          selections[page.id] = previous[page.id] ?? links.find((link) => link.page_id === page.id)?.campaign_id ?? "";
        }
        return selections;
      });
    } catch (error) {
      setLoadError("Failed to load pages: " + (error instanceof Error ? error.message : (error as { message?: string })?.message ?? "Unknown query error"));
    }
  }, [clientId, pageType, isRecruitment]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // The page appears minutes after the click that asked for it, so this
  // has to reload itself rather than wait to be reloaded by hand.
  const { inFlight, recentFailures } = useAgentJobs(clientId, refresh);

  const open = pages.find((p) => p.id === openId);
  const saveCampaign = async (page: Page) => {
    if (!clientId || busyPageId) return;
    setBusyPageId(page.id);
    setActionError(null);
    setNotice(null);
    try {
      const campaignId = campaignSelections[page.id] ?? "";
      if (campaignId && !campaigns.some((campaign) => campaign.id === campaignId)) {
        throw new Error("That campaign is not available for this client.");
      }
      const existing = pageLinks.filter((link) => link.page_id === page.id);
      if (campaignId && !existing.some((link) => link.campaign_id === campaignId)) {
        const { error } = await supabase.from("campaign_artifacts").insert({
          campaign_id: campaignId,
          client_id: clientId,
          kind: "landing_page",
          page_id: page.id,
        });
        if (error) throw error;
      }
      const removeIds = existing.filter((link) => link.campaign_id !== campaignId).map((link) => link.id);
      if (removeIds.length) {
        const { data, error } = await supabase.from("campaign_artifacts")
          .delete()
          .in("id", removeIds)
          .eq("client_id", clientId)
          .eq("kind", "landing_page")
          .eq("page_id", page.id)
          .select("id");
        if (error) throw error;
        if (data?.length !== removeIds.length) throw new Error("The previous campaign link could not be removed.");
      }
      await refresh();
      setNotice(campaignId ? "Page linked to the campaign." : "Campaign link removed.");
    } catch (error) {
      setActionError("Failed to save campaign: " + (error instanceof Error ? error.message : "Unknown error"));
      setCampaignSelections((previous) => {
        const next = { ...previous };
        delete next[page.id];
        return next;
      });
      await refresh();
    } finally {
      setBusyPageId(null);
    }
  };

  const deletePage = async (page: Page) => {
    if (!clientId || busyPageId) return;
    const message = page.published_url
      ? `Delete “${page.title}” from Page Builder? Its published URL may remain live until it is unpublished separately.`
      : `Delete “${page.title}” from Page Builder? This also removes its campaign link and cannot be undone.`;
    if (!window.confirm(message)) return;
    setBusyPageId(page.id);
    setActionError(null);
    setNotice(null);
    try {
      const { data, error } = await supabase.from("client_pages")
        .delete()
        .eq("id", page.id)
        .eq("client_id", clientId)
        .eq("page_type", pageType)
        .select("id");
      if (error) throw error;
      if (!data?.length) throw new Error("The page could not be deleted.");
      if (openId === page.id) setOpenId(null);
      await refresh();
      setNotice("Page deleted.");
    } catch (error) {
      setActionError("Failed to delete page: " + (error instanceof Error ? error.message : "Unknown error"));
    } finally {
      setBusyPageId(null);
    }
  };
  const fields: FieldDef[] = useMemo(() => [
    { name: "title", label: "Page title", kind: "text", required: true },
    {
      name: "campaign_id",
      label: "Campaign",
      kind: "select",
      options: [
        { value: "", label: "Not linked to a campaign" },
        ...campaigns.map((campaign) => ({
          value: campaign.id,
          label: `${campaign.name} · ${campaign.status}`,
        })),
      ],
      hint: "Optional. Linked pages count toward that campaign's landing page requirement.",
    },
    {
      name: "html_file",
      label: "Built HTML file",
      kind: "file",
      accept: ".html,.htm,text/html",
      hint: "Optional. Upload this when the page is already built; no page agent will be queued.",
    },
    {
      name: "brief",
      label: "What this page is for",
      kind: "textarea",
      rows: 4,
      hint: "Required if no HTML file is uploaded. The agent writes the page from this, your offer strategy, your ICP and whatever proof is on file.",
    },
  ], [campaigns]);

  if (loadError) return <div role="alert"><p>{loadError}</p><button type="button" onClick={() => void refresh()}>Retry</button></div>;

  return (
    <div>
      <AgentActivityBar inFlight={inFlight} failures={recentFailures} />

      <div className="mb-4 flex justify-end">
        <Button icon={Plus} onClick={() => setBuildOpen(true)}>
          Build Page
        </Button>
      </div>

      {notice && (
        <p role="status" className="mb-4 text-sm text-brand-strong">
          {notice}
        </p>
      )}
      {actionError && <p role="alert" className="mb-4 text-sm text-destructive">{actionError}</p>}

      {pages.length === 0 ? (
        <EmptyState label="No pages built yet" />
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {pages.map((p) => (
            <Panel key={p.id} title={p.title}>
              <p className="text-sm capitalize text-muted-foreground">
                {p.status}
                {p.published_url ? " · live" : p.html ? " · built, not published" : ""}
              </p>
              {p.html ? (
                <>
                  {p.meta_description && (
                    <p className="mt-2 line-clamp-3 text-sm text-muted-foreground">
                      {p.meta_description}
                    </p>
                  )}
                  <button
                    type="button"
                    onClick={() => setOpenId(p.id)}
                    className="mt-2 rounded text-sm font-medium text-brand-strong hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    Open the page
                  </button>
                </>
              ) : (
                <p className="mt-2 text-sm text-muted-foreground">
                  Waiting for the agent to build this.
                </p>
              )}
              {p.published_url && (
                <p className="mt-1 truncate text-xs text-muted-foreground">{p.published_url}</p>
              )}
              <div className="mt-4 border-t border-border pt-3">
                <PublishButton
                  page={{
                    id: p.id,
                    title: p.title,
                    html: p.html,
                    publish_status: p.publish_status,
                    published_url: p.published_url,
                    site_repository_id: p.site_repository_id,
                  }}
                  repos={repos}
                  onPublished={() => void refresh()}
                />
              </div>

              <div className="mt-4 border-t border-border pt-3">
                <label htmlFor={`page-campaign-${p.id}`} className="mb-1 block text-xs text-muted-foreground">
                  Campaign for {p.title}
                </label>
                <select
                  id={`page-campaign-${p.id}`}
                  value={campaignSelections[p.id] ?? pageLinks.find((link) => link.page_id === p.id)?.campaign_id ?? ""}
                  onChange={(event) => setCampaignSelections((previous) => ({ ...previous, [p.id]: event.target.value }))}
                  disabled={busyPageId !== null}
                  className="w-full rounded-md border border-border bg-card px-2 py-2 text-sm text-card-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
                >
                  <option value="">Not linked to a campaign</option>
                  {campaigns.map((campaign) => (
                    <option key={campaign.id} value={campaign.id}>{campaign.name} · {campaign.status}</option>
                  ))}
                </select>
                <div className="mt-2 flex items-center gap-3">
                  <button
                    type="button"
                    onClick={() => void saveCampaign(p)}
                    disabled={busyPageId !== null || (campaignSelections[p.id] ?? "") === (pageLinks.find((link) => link.page_id === p.id)?.campaign_id ?? "")}
                    className="rounded text-sm font-medium text-brand-strong hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {busyPageId === p.id ? "Saving…" : "Save campaign"}
                  </button>
                  <button
                    type="button"
                    onClick={() => void deletePage(p)}
                    disabled={busyPageId !== null}
                    className="inline-flex items-center gap-1 rounded text-sm text-destructive hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                    Delete page
                  </button>
                </div>
              </div>
            </Panel>
          ))}
        </div>
      )}

      <FormModal
        open={buildOpen}
        onClose={() => setBuildOpen(false)}
        title="Build Page"
        draftKey={`page:${pageType}:${clientId}`}
        intro="Upload finished HTML when the page already exists, or leave the file empty to queue the page agent."
        fields={fields}
        submitLabel="Save page"
        onSubmit={async (v) => {
          if (!clientId) throw new Error("No client selected.");
          const title = (v.title as string).trim();
          const brief = typeof v.brief === "string" ? v.brief.trim() : "";
          const campaignId = typeof v.campaign_id === "string" ? v.campaign_id : "";
          const htmlFile = v.html_file instanceof File ? v.html_file : null;
          const html = htmlFile ? await htmlFile.text() : "";
          if (!htmlFile && !brief) {
            throw new Error("What this page is for is required unless you upload a built HTML file.");
          }
          if (htmlFile && !html.trim()) {
            throw new Error("That HTML file is empty.");
          }

          const { data, error } = await supabase
            .from("client_pages")
            .insert({
              client_id: clientId,
              page_type: pageType,
              title,
              brief: brief || null,
              html: htmlFile ? html : null,
              body: htmlFile ? `# ${title}\n\nImported from ${htmlFile.name}.` : null,
              meta_title: htmlFile ? title : null,
              meta_description: htmlFile && brief ? brief : null,
              built_at: htmlFile ? new Date().toISOString() : null,
            })
            .select("id")
            .single();
          if (error) throw error;

          if (campaignId) {
            const { error: linkError } = await supabase.from("campaign_artifacts").insert({
              campaign_id: campaignId,
              client_id: clientId,
              kind: "landing_page",
              page_id: data.id,
            });
            if (linkError) throw new Error(linkError.message);
          }

          if (htmlFile) {
            setNotice(campaignId ? "Page uploaded and linked to the campaign." : "Page uploaded.");
            return;
          }

          const { error: jobError } = await supabase.rpc("enqueue_agent_job", {
            p_agent_key: "landing_page",
            p_client_id: clientId,
            p_input_table: "client_pages",
            p_input_id: data.id,
          });
          if (jobError) throw new Error(jobError.message);
          setNotice(campaignId ? "Queued. The agent is writing the campaign page now." : "Queued. The agent is writing the page now.");
        }}
        onSaved={refresh}
      />

      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <button
            type="button"
            aria-label="Close"
            className="absolute inset-0 bg-foreground/40"
            onClick={() => setOpenId(null)}
          />
          <div
            role="dialog"
            aria-modal="true"
            className="relative flex max-h-[92vh] w-full max-w-6xl flex-col overflow-hidden rounded-lg border border-border bg-card shadow-lg"
          >
            <div className="flex shrink-0 items-center justify-between border-b border-border px-5 py-4">
              <h2 className="text-base font-semibold text-card-foreground">{open.title}</h2>
              <button
                type="button"
                onClick={() => setOpenId(null)}
                className="rounded-md px-2 py-1 text-sm text-muted-foreground hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                Close
              </button>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
              <PagePreview
                html={open.html}
                publishedUrl={open.published_url}
                builtAt={open.built_at}
                title={open.title}
              />
              {/* Polish happens here, before anything is pushed to a repo. A
                  page on a Pages-served branch is public the instant it lands,
                  so the place to fix gaps is before the push, not after. */}
              {clientId && open.html && (
                <div className="mt-6">
                  <PagePolish
                    pageId={open.id}
                    clientId={clientId}
                    currentRevision={open.current_revision}
                    onChanged={refresh}
                  />
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
