import { CollapsiblePanel } from "../../components/CollapsiblePanel";
import { useCallback, useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { Sparkles } from "lucide-react";
import { supabase } from "../../lib/supabase";
import { Button } from "../../components/Button";
import { GenerateWithAIDialog } from "../../components/forms/GenerateWithAIDialog";
import { FormModal } from "../../components/forms/FormModal";
import {
  MAX_PILLARS,
  MIN_PILLARS,
  pillarSetProblem,
  shareHint,
  type ContentPillar,
  type ProposedPillar,
} from "../../lib/contentPillars";

const COLUMNS = "id, slug, name, premise, belongs, does_not_belong, target_share, active";

/**
 * The three to six things this brand posts about.
 *
 * Proposed once by an agent, then owned by a person. That split is the whole
 * design: the ideation agent has always produced pillar-shaped labels, and
 * because nothing kept them it produced a different set every run. A set that
 * regenerates is the drift, not the fix.
 *
 * Which is why Generate only appears when there is no active set. Re-proposing
 * over pillars somebody has edited would throw the edit away, so replacing a
 * set means retiring it first — deliberately a decision, not a button.
 */
export function ContentPillarsPanel() {
  const { clientId } = useParams<{ clientId: string }>();
  const [pillars, setPillars] = useState<ContentPillar[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [generating, setGenerating] = useState(false);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    if (!clientId) return;
    setLoadError(null);
    const { data, error } = await supabase
      .from("client_content_pillars")
      .select(COLUMNS)
      .eq("client_id", clientId)
      .order("active", { ascending: false })
      .order("target_share", { ascending: false });
    if (error) {
      setLoadError(`Failed to load pillars: ${error.message}`);
      return;
    }
    setPillars((data ?? []) as ContentPillar[]);
  }, [clientId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const active = pillars.filter((p) => p.active);
  const retired = pillars.filter((p) => !p.active);
  const problem = active.length > 0 ? pillarSetProblem(pillars) : null;

  async function saveProposed(proposed: ProposedPillar[]) {
    if (!clientId) return;
    setBusy(true);
    const { error } = await supabase.from("client_content_pillars").insert(
      proposed.map((p) => ({
        client_id: clientId,
        slug: p.slug,
        name: p.name,
        premise: p.premise,
        belongs: p.belongs,
        does_not_belong: p.does_not_belong,
        target_share: p.target_share,
      })),
    );
    setBusy(false);
    if (error) {
      setLoadError(`Failed to save the pillars: ${error.message}`);
      return;
    }
    setNotice(`Saved ${proposed.length} pillars. Edit any of them — they are yours now, not the agent's.`);
    void refresh();
  }

  async function patch(id: string, changes: Partial<ContentPillar>) {
    setBusy(true);
    setActionError(null);
    const { error } = await supabase.from("client_content_pillars").update(changes).eq("id", id);
    setBusy(false);
    if (error) {
      throw new Error(error.message);
    }
    setNotice("Changes saved.");
    await refresh();
  }

  if (loadError) {
    return (
      <div role="alert" className="space-y-2">
        <p className="text-sm text-destructive">{loadError}</p>
        <Button onClick={() => void refresh()}>Retry</Button>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-4">
        <p className="max-w-2xl text-sm text-muted-foreground">
          The {MIN_PILLARS} to {MAX_PILLARS} things this brand posts about. Ideation generates within a pillar,
          so what each one excludes matters as much as what it includes.
        </p>
        {active.length === 0 && (
          <Button icon={Sparkles} onClick={() => setGenerating(true)}>
            Generate with AI
          </Button>
        )}
      </div>

      {notice && <p className="text-sm text-brand-strong">{notice}</p>}
      {actionError && <p role="alert" className="text-sm text-destructive">{actionError}</p>}
      {problem && (
        <p role="alert" className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
          {problem}
        </p>
      )}

      {active.length === 0 ? (
        <p className="rounded-lg border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
          No pillars yet. Generate a set from the brand strategy, the ICP and the territories ideation has already
          been using — then edit them.
        </p>
      ) : (
        <>
          <div className="space-y-3">
            {active.map((p) => (
              <PillarCard key={`${clientId}:${p.id}`} pillar={p} busy={busy} onPatch={patch}
                onRetireError={(cause) => setActionError(`Failed to retire: ${cause instanceof Error ? cause.message : "Unknown error"}`)} />
            ))}
          </div>
          <p className="text-xs text-muted-foreground">{shareHint(pillars)}</p>
        </>
      )}

      {retired.length > 0 && (
        <div className="space-y-2 pt-2">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Retired</h3>
          {retired.map((p) => (
            <CollapsiblePanel key={`${clientId}:${p.id}`} title={p.name}>
              <button
                type="button"
                disabled={busy || active.length >= MAX_PILLARS}
                onClick={() => { void patch(p.id, { active: true }).catch((cause) =>
                  setActionError(`Failed to reinstate: ${cause instanceof Error ? cause.message : "Unknown error"}`)); }}
                className="text-xs font-medium text-brand-strong disabled:opacity-50"
              >
                Reinstate
              </button>
            </CollapsiblePanel>
          ))}
        </div>
      )}

      {clientId && (
        <GenerateWithAIDialog<{ pillars: ProposedPillar[] }>
          open={generating}
          title="Propose content pillars"
          intro="Reads the brand strategy, the ICP and the offer — and the territories ideation has already been inventing run after run, which are usually the pillars under different names."
          label="Anything to steer the set (optional)"
          placeholder="A repositioning, a service to lead with, a pillar you already know you want. Leave it blank and it will propose from the records."
          footnote={`Between ${MIN_PILLARS} and ${MAX_PILLARS}, with shares totalling 100%. You can edit every one afterwards.`}
          endpoint="/admin/pillars/draft"
          payload={{ clientId }}
          requireNotes={false}
          onClose={() => setGenerating(false)}
          onGenerated={(draft) => void saveProposed(draft.pillars)}
        />
      )}
    </div>
  );
}

function PillarCard({
  pillar,
  busy,
  onPatch,
  onRetireError,
}: {
  pillar: ContentPillar;
  busy: boolean;
  onPatch: (id: string, changes: Partial<ContentPillar>) => Promise<void>;
  onRetireError: (cause: unknown) => void;
}) {
  const [editing, setEditing] = useState(false);

  return (
    <>
      <CollapsiblePanel title={pillar.name}>
        <div className="space-y-3 text-sm text-muted-foreground">
          <p>Target share: {pillar.target_share}%</p>
          <p>What it argues: {pillar.premise || "Not recorded"}</p>
          <p>What belongs: {pillar.belongs || "Not recorded"}</p>
          <p>What does not: {pillar.does_not_belong || "Not recorded"}</p>
          <div className="flex justify-end gap-3 pt-2">
            <button type="button" disabled={busy} onClick={() => { void onPatch(pillar.id, { active: false }).catch(onRetireError); }}
              className="text-xs font-medium text-muted-foreground hover:text-destructive disabled:opacity-50">
              Retire
            </button>
            <button type="button" disabled={busy} onClick={() => setEditing(true)}
              className="text-xs font-medium text-brand-strong hover:underline disabled:opacity-50">
              Edit {pillar.name}
            </button>
          </div>
        </div>
      </CollapsiblePanel>
      <FormModal
        open={editing}
        onClose={() => setEditing(false)}
        title={`Edit ${pillar.name}`}
        intro="Correct this pillar, then save the revised set. Existing campaign plans keep their captured inputs."
        fields={[
          { name: "name", label: "Name", kind: "text", required: true },
          { name: "target_share", label: "Target share (%)", kind: "text", required: true },
          { name: "premise", label: "What it argues", kind: "textarea", rows: 2 },
          { name: "belongs", label: "What belongs", kind: "textarea", rows: 3 },
          { name: "does_not_belong", label: "What does not", kind: "textarea", rows: 3 },
        ]}
        initialValues={{ name: pillar.name, target_share: String(pillar.target_share),
          premise: pillar.premise, belongs: pillar.belongs, does_not_belong: pillar.does_not_belong }}
        onSubmit={async (values) => {
          const share = Number(values.target_share);
          if (!Number.isInteger(share) || share < 0 || share > 100) {
            throw new Error("Target share must be a whole percentage from 0 to 100.");
          }
          await onPatch(pillar.id, {
            name: String(values.name).trim(), target_share: share,
            premise: String(values.premise ?? "").trim(),
            belongs: String(values.belongs ?? "").trim(),
            does_not_belong: String(values.does_not_belong ?? "").trim(),
          });
        }}
      />
    </>
  );
}
