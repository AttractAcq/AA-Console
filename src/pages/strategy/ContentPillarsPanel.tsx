import { useCallback, useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { Sparkles } from "lucide-react";
import { supabase } from "../../lib/supabase";
import { Button } from "../../components/Button";
import { GenerateWithAIDialog } from "../../components/forms/GenerateWithAIDialog";
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
    const { error } = await supabase.from("client_content_pillars").update(changes).eq("id", id);
    setBusy(false);
    if (error) {
      setLoadError(`Failed to save: ${error.message}`);
      return;
    }
    void refresh();
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
              <PillarCard key={p.id} pillar={p} busy={busy} onPatch={patch} />
            ))}
          </div>
          <p className="text-xs text-muted-foreground">{shareHint(pillars)}</p>
        </>
      )}

      {retired.length > 0 && (
        <div className="space-y-2 pt-2">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Retired</h3>
          {retired.map((p) => (
            <div key={p.id} className="flex items-center justify-between rounded-md border border-border p-3">
              <span className="text-sm text-muted-foreground">{p.name}</span>
              <button
                type="button"
                disabled={busy || active.length >= MAX_PILLARS}
                onClick={() => void patch(p.id, { active: true })}
                className="text-xs font-medium text-brand-strong disabled:opacity-50"
              >
                Reinstate
              </button>
            </div>
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
}: {
  pillar: ContentPillar;
  busy: boolean;
  onPatch: (id: string, changes: Partial<ContentPillar>) => void | Promise<void>;
}) {
  const field = (key: keyof ContentPillar, label: string, rows = 2) => (
    <label className="block">
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      <textarea
        aria-label={`${label} for ${pillar.name}`}
        defaultValue={String(pillar[key] ?? "")}
        rows={rows}
        disabled={busy}
        onBlur={(e) => {
          const next = e.target.value.trim();
          if (next !== String(pillar[key] ?? "")) void onPatch(pillar.id, { [key]: next });
        }}
        className="mt-1 w-full rounded-md border border-input bg-background p-2 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60"
      />
    </label>
  );

  return (
    <div className="space-y-3 rounded-lg border border-border bg-card p-4">
      <div className="flex items-center justify-between gap-3">
        <input
          aria-label={`Name for ${pillar.name}`}
          defaultValue={pillar.name}
          disabled={busy}
          onBlur={(e) => {
            const next = e.target.value.trim();
            if (next && next !== pillar.name) void onPatch(pillar.id, { name: next });
          }}
          className="min-w-0 flex-1 rounded-md border border-transparent bg-transparent px-1 py-0.5 text-sm font-semibold text-card-foreground hover:border-input focus-visible:border-input focus-visible:outline-none"
        />
        <label className="flex shrink-0 items-center gap-1.5">
          <span className="text-xs text-muted-foreground">Share</span>
          <input
            type="number"
            min={0}
            max={100}
            aria-label={`Target share for ${pillar.name}`}
            defaultValue={pillar.target_share}
            disabled={busy}
            onBlur={(e) => {
              const next = Number(e.target.value);
              if (Number.isFinite(next) && next !== pillar.target_share) {
                void onPatch(pillar.id, { target_share: Math.max(0, Math.min(100, Math.round(next))) });
              }
            }}
            className="w-16 rounded-md border border-input bg-background px-2 py-1 text-sm text-foreground"
          />
          <span className="text-xs text-muted-foreground">%</span>
        </label>
        <button
          type="button"
          disabled={busy}
          onClick={() => void onPatch(pillar.id, { active: false })}
          className="shrink-0 text-xs font-medium text-muted-foreground hover:text-destructive disabled:opacity-50"
        >
          Retire
        </button>
      </div>

      {field("premise", "What it argues", 1)}
      <div className="grid gap-3 sm:grid-cols-2">
        {field("belongs", "What belongs")}
        {field("does_not_belong", "What does not")}
      </div>
    </div>
  );
}
