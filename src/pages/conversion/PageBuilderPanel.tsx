import { useCallback, useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { Plus } from "lucide-react";
import { Button } from "../../components/Button";
import { Panel } from "../../components/Panel";
import { EmptyState } from "../../components/EmptyState";
import { FormModal } from "../../components/forms/FormModal";
import type { FieldDef } from "../../components/forms/fields";
import { supabase } from "../../lib/supabase";

type Page = { id: string; title: string; status: string; published_url: string | null };

const FIELDS: FieldDef[] = [
  { name: "title", label: "Page title", kind: "text", required: true },
  {
    name: "brief",
    label: "What this page is for",
    kind: "textarea",
    rows: 4,
    required: true,
    hint: "The agent writes the page body from this, your offer strategy and your proof.",
  },
];

export function PageBuilderPanel({ pageType = "landing" }: { pageType?: "landing" | "offer" }) {
  const [buildOpen, setBuildOpen] = useState(false);
  const { clientId } = useParams<{ clientId: string }>();
  const [pages, setPages] = useState<Page[]>([]);

  const refresh = useCallback(async () => {
    if (!clientId) return;
    const { data } = await supabase
      .from("client_pages")
      .select("id, title, status, published_url")
      .eq("client_id", clientId)
      .eq("page_type", pageType)
      .order("created_at", { ascending: false });
    setPages((data ?? []) as Page[]);
  }, [clientId, pageType]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return (
    <div>
      <div className="mb-4 flex justify-end">
        <Button icon={Plus} onClick={() => setBuildOpen(true)}>
          Build Page
        </Button>
      </div>

      {pages.length === 0 ? (
        <EmptyState label="No pages built yet" />
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {pages.map((p) => (
            <Panel key={p.id} title={p.title}>
              <p className="text-sm text-muted-foreground">{p.status}</p>
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
        }}
        onSaved={refresh}
      />
    </div>
  );
}
