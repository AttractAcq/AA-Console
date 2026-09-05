import { useCallback, useEffect, useState } from "react";
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

type Page = {
  id: string;
  title: string;
  status: string;
  body: string | null;
  published_url: string | null;
  created_at: string;
};

const FIELDS: FieldDef[] = [
  { name: "title", label: "Page title", kind: "text", required: true },
  {
    name: "brief",
    label: "What this page is for",
    kind: "textarea",
    rows: 4,
    required: true,
    hint: "The agent writes the page from this, your offer strategy, your ICP and whatever proof is on file.",
  },
];

export function PageBuilderPanel({ pageType = "landing" }: { pageType?: "landing" | "offer" }) {
  const [buildOpen, setBuildOpen] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const { clientId } = useParams<{ clientId: string }>();
  const [pages, setPages] = useState<Page[]>([]);
  const [notice, setNotice] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!clientId) return;
    const { data } = await supabase
      .from("client_pages")
      .select("id, title, status, body, published_url, created_at")
      .eq("client_id", clientId)
      .eq("page_type", pageType)
      .order("created_at", { ascending: false });
    setPages((data ?? []) as Page[]);
  }, [clientId, pageType]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // The page appears minutes after the click that asked for it, so this
  // has to reload itself rather than wait to be reloaded by hand.
  const { inFlight, recentFailures } = useAgentJobs(clientId, refresh);

  const open = pages.find((p) => p.id === openId);

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
              <p className="text-sm capitalize text-muted-foreground">{p.status}</p>
              {p.body ? (
                <>
                  <p className="mt-2 line-clamp-4 whitespace-pre-wrap text-sm text-muted-foreground">
                    {p.body}
                  </p>
                  <button
                    type="button"
                    onClick={() => setOpenId(p.id)}
                    className="mt-2 rounded text-sm font-medium text-brand-strong hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    Read full page
                  </button>
                </>
              ) : (
                <p className="mt-2 text-sm text-muted-foreground">
                  Waiting for the agent to write this.
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
        intro="Queues the page agent. It needs your offer strategy, takes a couple of minutes, and this page fills in on its own when it finishes."
        fields={FIELDS}
        submitLabel="Build"
        onSubmit={async (v) => {
          if (!clientId) throw new Error("No client selected.");
          const { data, error } = await supabase
            .from("client_pages")
            .insert({
              client_id: clientId,
              page_type: pageType,
              title: (v.title as string).trim(),
              brief: (v.brief as string).trim(),
            })
            .select("id")
            .single();
          if (error) throw error;

          const { error: jobError } = await supabase.rpc("enqueue_agent_job", {
            p_agent_key: "landing_page",
            p_client_id: clientId,
            p_input_table: "client_pages",
            p_input_id: data.id,
          });
          if (jobError) throw new Error(jobError.message);
          setNotice("Queued. The agent is writing the page now.");
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
            className="relative flex max-h-[88vh] w-full max-w-2xl flex-col overflow-hidden rounded-lg border border-border bg-card shadow-lg"
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
              <p className="whitespace-pre-wrap text-sm text-muted-foreground">{open.body}</p>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
