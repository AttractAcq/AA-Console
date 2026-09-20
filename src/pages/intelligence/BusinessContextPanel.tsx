import { useCallback, useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { Plus } from "lucide-react";
import { Button } from "../../components/Button";
import { Panel } from "../../components/Panel";
import { EmptyState } from "../../components/EmptyState";
import { FormModal } from "../../components/forms/FormModal";
import type { FieldDef, FormValues } from "../../components/forms/fields";
import { supabase } from "../../lib/supabase";
import { OnboardingSource } from "../../components/OnboardingSource";
import { clearDraft } from "../../components/forms/FormModal";
import { GenerateWithAIDialog } from "../../components/forms/GenerateWithAIDialog";

/**
 * The root of the whole application. Every agent reads this, and the four
 * required fields are the ones with no other source in the system.
 */
const FIELDS: FieldDef[] = [
  { name: "business_overview", label: "Business overview", kind: "textarea", rows: 4, required: true,
    hint: "Read by every agent." },
  { name: "ideal_customer", label: "Ideal customer", kind: "textarea", rows: 3, required: true,
    hint: "Seeds the ICP agent." },
  { name: "main_offer", label: "Main offer", kind: "textarea", rows: 3, required: true },
  { name: "competitors", label: "Competitors", kind: "textarea", rows: 3, required: true,
    hint: "Seeds the Competitor agent." },
  { name: "brand_voice", label: "Brand voice", kind: "textarea", rows: 3,
    hint: "Tone, language rules, and what never to say." },
  { name: "proof_testimonials", label: "Proof / testimonials", kind: "textarea", rows: 3 },
  { name: "current_marketing", label: "Current marketing", kind: "textarea", rows: 3 },
  { name: "sales_process", label: "Sales process", kind: "textarea", rows: 3 },
  { name: "current_revenue", label: "Current revenue", kind: "text" },
  { name: "target_revenue", label: "Target revenue", kind: "text" },
];

const CARDS: Array<{ key: string; label: string; hero?: boolean }> = [
  { key: "business_overview", label: "Business Overview", hero: true },
  { key: "current_revenue", label: "Current Revenue" },
  { key: "target_revenue", label: "Target Revenue" },
  { key: "current_marketing", label: "Current Marketing" },
  { key: "ideal_customer", label: "Ideal Customer" },
  { key: "main_offer", label: "Main Offer" },
  { key: "competitors", label: "Competitors" },
  { key: "proof_testimonials", label: "Proof / Testimonials" },
];

type ContextRow = Record<string, string | null>;

export function BusinessContextPanel() {
  const [inputOpen, setInputOpen] = useState(false);
  const [researching, setResearching] = useState(false);
  const [aiDraft, setAiDraft] = useState<Record<string, string> | null>(null);
  // Shown, not saved: a researched draft is only useful if it can be checked.
  const [sources, setSources] = useState<string | null>(null);
  // Fields the runtime threw away, so a blank one explains itself rather than
  // looking like the researcher simply found nothing.
  const [dropped, setDropped] = useState<{ field: string; reason: string }[]>([]);
  const { clientId } = useParams<{ clientId: string }>();
  const [row, setRow] = useState<ContextRow | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!clientId) return;
    setLoadError(null);
    try {
      const { data, error } = await supabase
        .from("client_business_context")
        .select("*")
        .eq("client_id", clientId)
        .maybeSingle();
      if (error) throw error;
      setRow((data as ContextRow) ?? null);
    } catch (error) {
      setLoadError("Failed to load business context: " + (error instanceof Error ? error.message : (error as { message?: string })?.message ?? "Unknown query error"));
    }
  }, [clientId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const initialValues: FormValues = Object.fromEntries(
    FIELDS.map((f) => [f.name, row?.[f.name] ?? ""]),
  );

  if (loadError) return <div role="alert"><p>{loadError}</p><button type="button" onClick={() => void refresh()}>Retry</button></div>;

  return (
    <div>
      <OnboardingSource what="Business context" />
      <div className="mb-4 flex justify-end">
        <Button icon={Plus} onClick={() => setInputOpen(true)}>
          Business Input
        </Button>
      </div>

      <div className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {CARDS.map(({ key, label, hero }) => {
            const value = row?.[key];
            return (
              <Panel
                key={key}
                title={label}
                className={hero ? "sm:col-span-2 lg:col-span-4" : undefined}
              >
                {value ? (
                  <p className="whitespace-pre-wrap text-sm text-muted-foreground">{value}</p>
                ) : (
                  <EmptyState label={label} minHeight={hero ? 100 : 80} />
                )}
              </Panel>
            );
          })}
        </div>
      </div>

      <FormModal
        open={inputOpen}
        onClose={() => {
          setInputOpen(false);
          setAiDraft(null);
          setSources(null);
          setDropped([]);
        }}
        title="Business Input"
        draftKey={`business-context:${clientId}`}
        intro="The four required fields are what every downstream agent reads. Partial saves are fine."
        fields={FIELDS}
        initialValues={aiDraft ?? initialValues}
        actions={
          <button
            type="button"
            onClick={() => setResearching(true)}
            className="rounded-md border border-border px-3 py-2 text-sm font-medium text-card-foreground transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            Generate with AI
          </button>
        }
        onSubmit={async (values) => {
          if (!clientId) throw new Error("No client selected.");
          const payload = Object.fromEntries(
            FIELDS.map((f) => [f.name, (values[f.name] as string)?.trim() || null]),
          );
          const { error } = await supabase
            .from("client_business_context")
            .upsert({ client_id: clientId, ...payload }, { onConflict: "client_id" });
          if (error) throw error;
        }}
        onSaved={() => {
          setAiDraft(null);
          setSources(null);
          setDropped([]);
          void refresh();
        }}
      />

      {dropped.length > 0 && (
        <div className="mt-3 rounded-md border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
          <p className="font-medium text-foreground">Left blank for you to fill in</p>
          <ul className="mt-1 space-y-0.5">
            {dropped.map((d) => (
              <li key={d.field}>
                <span className="capitalize">{d.field.replace(/_/g, " ")}</span> — {d.reason}.
              </li>
            ))}
          </ul>
        </div>
      )}

      {sources && (
        <p className="mt-3 rounded-md border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
          {/* Where it came from, so the draft can be checked before it is
              saved. Not stored: an agent reading it back would treat a list
              of URLs as business context. */}
          <span className="font-medium text-foreground">Drafted from:</span> {sources}
        </p>
      )}

      {clientId && (
        <GenerateWithAIDialog<Record<string, string>>
          open={researching}
          title="Draft the business context"
          intro="Reads the client's website and what they have published, and fills the form from it. Everything comes back as a draft for you to correct — nothing is saved until you press Save."
          label="What you know from talking to them (optional)"
          placeholder="Anything the website will not say: what they actually sell, who walks in, what they will not do, what the last agency got wrong. This is trusted over anything found online."
          footnote="Revenue is never researched — you type those two fields or they stay empty. Anything it could not find is left blank rather than guessed."
          endpoint="/admin/business-context/draft"
          payload={{ clientId }}
          requireNotes={false}
          onClose={() => setResearching(false)}
          onGenerated={(draft, drafted, droppedFields) => {
            // A saved draft wins over initialValues inside FormModal, so a
            // half-typed form would silently swallow the research.
            clearDraft(`business-context:${clientId}`);
            setAiDraft(draft);
            setSources(drafted ?? null);
            setDropped(droppedFields ?? []);
          }}
        />
      )}
    </div>
  );
}
