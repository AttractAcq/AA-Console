import { useCallback, useEffect, useMemo, useState } from "react";
import { useParams } from "react-router-dom";
import { Plus } from "lucide-react";
import { Button } from "../../components/Button";
import { Panel } from "../../components/Panel";
import { EmptyState } from "../../components/EmptyState";
import { FormModal } from "../../components/forms/FormModal";
import type { FieldDef } from "../../components/forms/fields";
import { AgentActivityBar } from "../../components/agents/AgentActivityBar";
import { useAgentJobs } from "../../lib/useAgentJobs";
import { supabase } from "../../lib/supabase";
import { PagePreview } from "../../components/pages/PagePreview";

type Page = {
  id: string;
  title: string;
  status: string;
  body: string | null;
  published_url: string | null;
  created_at: string;
  html: string | null;
  meta_title: string | null;
  meta_description: string | null;
  built_at: string | null;
};

type CampaignOption = {
  id: string;
  name: string;
  status: string;
};

export function PageBuilderPanel({ pageType = "landing" }: { pageType?: "landing" | "offer" }) {
  const [buildOpen, setBuildOpen] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const { clientId } = useParams<{ clientId: string }>();
  const [pages, setPages] = useState<Page[]>([]);
  const [campaigns, setCampaigns] = useState<CampaignOption[]>([]);
  const [notice, setNotice] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!clientId) return;
    const [pageRows, campaignRows] = await Promise.all([
      supabase
        .from("client_pages")
        .select(
          "id, title, status, body, published_url, created_at, html, meta_title, meta_description, built_at",
        )
        .eq("client_id", clientId)
        .eq("page_type", pageType)
        .order("created_at", { ascending: false }),
      supabase
        .from("client_campaigns")
        .select("id, name, status")
        .eq("client_id", clientId)
        .order("created_at", { ascending: false }),
    ]);
    setPages((pageRows.data ?? []) as Page[]);
    setCampaigns((campaignRows.data ?? []) as CampaignOption[]);
  }, [clientId, pageType]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // The page appears minutes after the click that asked for it, so this
  // has to reload itself rather than wait to be reloaded by hand.
  const { inFlight, recentFailures } = useAgentJobs(clientId, refresh);

  const open = pages.find((p) => p.id === openId);
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
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
