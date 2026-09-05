import { useCallback, useEffect, useState } from "react";
import { CalendarPlus, Check, Pencil, RefreshCw, ThumbsUp } from "lucide-react";
import { supabase } from "../../lib/supabase";
import { signPaths } from "../../lib/media";
import { cn } from "../../lib/cn";

export type Generation = {
  id: string;
  stage: string;
  concept: Record<string, unknown> | null;
  quality: string;
  size: string;
  reference_path: string | null;
  concept_model: string | null;
  image_model: string | null;
  concept_edited_at: string | null;
  cost_usd: number | null;
  error: string | null;
  created_at: string;
  media_type: string;
};

type Render = {
  id: string;
  status: string;
  quality: string;
  size: string;
  asset_id: string | null;
  cost_usd: number | null;
  error: string | null;
  selected: boolean;
  created_at: string;
};

/** What has happened to the file a render produced. */
type AssetState = {
  review_status: "pending" | "approved" | "rejected";
  ref_number: string | null;
  scheduled_for: string | null;
  channel: string | null;
};

const CONCEPT_LABEL: Record<string, string> = {
  headline: "Headline",
  subhead: "Subhead",
  body: "Copy",
  call_to_action: "Call to action",
  subject: "What's in frame",
  composition: "Composition",
  art_direction: "Art direction",
  avoid: "Do not include",
  rationale: "Why this",
};

const ORDER = [
  "headline", "subhead", "body", "call_to_action",
  "subject", "composition", "art_direction", "avoid", "rationale",
];

const SHORT = new Set(["headline", "subhead", "call_to_action"]);

const QUALITY = [
  { id: "low", label: "Low", cost: "~$0.005" },
  { id: "medium", label: "Medium", cost: "~$0.045" },
  { id: "high", label: "High", cost: "~$0.165" },
];

const STATUS_TONE: Record<string, string> = {
  done: "bg-primary/10 text-brand-strong",
  failed: "bg-destructive/10 text-destructive",
  queued: "bg-secondary text-secondary-foreground",
  rendering: "bg-secondary text-secondary-foreground",
};

/**
 * One concept and every render made from it.
 *
 * The concept is the expensive half of a build — the reasoning over the
 * client's whole intelligence. Renders are cents. So this surface exists to
 * make the cheap thing repeatable: edit the direction, render again, compare,
 * pick one, and only then pay for a high-quality final.
 */
export function ConceptWorkspace({
  generation,
  onChanged,
}: {
  generation: Generation;
  onChanged: () => void;
}) {
  const [renders, setRenders] = useState<Render[]>([]);
  const [urls, setUrls] = useState<Map<string, string>>(new Map());
  const [assets, setAssets] = useState<Map<string, AssetState>>(new Map());
  const [scheduleDate, setScheduleDate] = useState("");
  const [channel, setChannel] = useState<"organic" | "paid">("organic");
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [quality, setQuality] = useState("medium");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const { data } = await supabase
      .from("creative_renders")
      .select("id, status, quality, size, asset_id, cost_usd, error, selected, created_at")
      .eq("generation_id", generation.id)
      .order("created_at", { ascending: false });
    const rows = (data ?? []) as Render[];
    setRenders(rows);

    const ids = rows.map((r) => r.asset_id).filter((id): id is string => Boolean(id));
    if (ids.length === 0) {
      setUrls(new Map());
      return;
    }
    const { data: assetRows } = await supabase
      .from("client_media_assets")
      .select("id, storage_path, review_status, ref_number")
      .in("id", ids);
    const signed = await signPaths("client-media", (assetRows ?? []).map((a) => a.storage_path));
    setUrls(
      new Map(
        (assetRows ?? [])
          .map((a) => [a.id, signed.get(a.storage_path) ?? ""] as [string, string])
          .filter(([, u]) => u),
      ),
    );

    // Whether each asset has already been booked in, so the action bar
    // offers the next step rather than one that has been taken.
    const { data: posts } = await supabase
      .from("scheduled_posts")
      .select("asset_id, scheduled_for, channel")
      .in("asset_id", ids);
    const booked = new Map(
      (posts ?? []).map((p) => [p.asset_id as string, p] as [string, typeof p]),
    );
    setAssets(
      new Map(
        (assetRows ?? []).map((a) => [
          a.id,
          {
            review_status: a.review_status as AssetState["review_status"],
            ref_number: a.ref_number,
            scheduled_for: booked.get(a.id)?.scheduled_for ?? null,
            channel: booked.get(a.id)?.channel ?? null,
          },
        ]),
      ),
    );
  }, [generation.id]);

  useEffect(() => {
    void load();
  }, [load]);

  const concept = generation.concept ?? {};
  const fields = ORDER.filter((k) => concept[k] !== undefined && concept[k] !== null);

  const startEditing = () => {
    setDraft(Object.fromEntries(fields.map((k) => [k, String(concept[k] ?? "")])));
    setEditing(true);
    setError(null);
  };

  const saveConcept = async () => {
    setBusy("save");
    setError(null);
    const { error: rpcError } = await supabase.rpc("update_generation_concept", {
      p_generation_id: generation.id,
      // The generated Json type cannot see that a concept is a flat object;
      // the RPC validates jsonb_typeof = 'object' server-side.
      p_concept: { ...concept, ...draft } as never,
    });
    if (rpcError) setError(rpcError.message);
    else {
      setEditing(false);
      onChanged();
    }
    setBusy(null);
  };

  const rerender = async () => {
    setBusy("render");
    setError(null);
    const { error: rpcError } = await supabase.rpc("rerender_generation", {
      p_generation_id: generation.id,
      p_quality: quality,
    });
    if (rpcError) setError(rpcError.message);
    else {
      await load();
      onChanged();
    }
    setBusy(null);
  };

  const approve = async (assetId: string) => {
    setBusy("approve");
    setError(null);
    const { error: rpcError } = await supabase.rpc("review_media_asset", {
      p_asset_id: assetId,
      p_decision: "approved",
    });
    if (rpcError) setError(rpcError.message);
    else await load();
    setBusy(null);
  };

  const schedule = async (assetId: string) => {
    if (!scheduleDate) {
      setError("Pick a date first.");
      return;
    }
    setBusy("schedule");
    setError(null);
    const { error: rpcError } = await supabase.rpc("schedule_asset", {
      p_asset_id: assetId,
      p_date: scheduleDate,
      p_channel: channel,
    });
    if (rpcError) setError(rpcError.message);
    else {
      setScheduleDate("");
      await load();
      onChanged();
    }
    setBusy(null);
  };

  const pick = async (renderId: string) => {
    setBusy(renderId);
    const { error: rpcError } = await supabase.rpc("select_render", { p_render_id: renderId });
    if (rpcError) setError(rpcError.message);
    else await load();
    setBusy(null);
  };

  const isImage = generation.media_type === "image";
  const hasConcept = fields.length > 0;
  const totalCost = renders.reduce((sum, r) => sum + Number(r.cost_usd ?? 0), 0);

  return (
    <div className="space-y-4 border-t border-border px-3 py-3">
      {/* ---- the concept ---- */}
      <div>
        <div className="mb-2 flex items-center justify-between gap-2">
          <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Concept
            {generation.concept_edited_at && (
              <span className="ml-2 rounded-full bg-secondary px-2 py-0.5 text-[0.7rem] font-medium normal-case tracking-normal text-secondary-foreground">
                edited by hand
              </span>
            )}
          </h4>
          {hasConcept && !editing && (
            <button
              type="button"
              onClick={startEditing}
              className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <Pencil className="h-3 w-3" aria-hidden="true" /> Edit
            </button>
          )}
        </div>

        {!hasConcept ? (
          <p className="text-sm text-muted-foreground">
            No concept was written — this build failed before that stage.
          </p>
        ) : editing ? (
          <div className="space-y-2">
            {fields.map((k) => (
              <label key={k} className="block">
                <span className="mb-1 block text-xs font-semibold text-muted-foreground">
                  {CONCEPT_LABEL[k] ?? k}
                </span>
                {SHORT.has(k) ? (
                  <input
                    value={draft[k] ?? ""}
                    onChange={(e) => setDraft({ ...draft, [k]: e.target.value })}
                    className="w-full rounded-md border border-input bg-background px-2.5 py-1.5 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  />
                ) : (
                  <textarea
                    value={draft[k] ?? ""}
                    onChange={(e) => setDraft({ ...draft, [k]: e.target.value })}
                    rows={k === "avoid" || k === "composition" ? 5 : 3}
                    className="w-full rounded-md border border-input bg-background px-2.5 py-1.5 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  />
                )}
              </label>
            ))}
            <div className="flex gap-2">
              <button
                type="button"
                disabled={busy === "save"}
                onClick={() => void saveConcept()}
                className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
              >
                {busy === "save" ? "Saving…" : "Save concept"}
              </button>
              <button
                type="button"
                onClick={() => setEditing(false)}
                className="rounded-md px-3 py-1.5 text-xs text-muted-foreground hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                Cancel
              </button>
            </div>
            <p className="text-xs text-muted-foreground">
              Saving does not re-render. The next render composes its prompt from this text, so an
              edit costs nothing until you ask for an image.
            </p>
          </div>
        ) : (
          <dl className="space-y-2">
            {fields.map((k) => (
              <div key={k}>
                <dt className="text-xs font-semibold text-muted-foreground">
                  {CONCEPT_LABEL[k] ?? k}
                </dt>
                <dd className="whitespace-pre-wrap text-sm text-foreground">{String(concept[k])}</dd>
              </div>
            ))}
          </dl>
        )}
      </div>

      {/* ---- renders ---- */}
      {isImage && hasConcept && (
        <div>
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Renders ({renders.length})
              {totalCost > 0 && (
                <span className="ml-2 font-normal normal-case tracking-normal">
                  ${totalCost.toFixed(3)} total
                </span>
              )}
            </h4>
            <div className="flex items-center gap-1.5">
              <select
                value={quality}
                onChange={(e) => setQuality(e.target.value)}
                className="rounded-md border border-input bg-background px-2 py-1 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                {QUALITY.map((q) => (
                  <option key={q.id} value={q.id}>
                    {q.label} {q.cost}
                  </option>
                ))}
              </select>
              <button
                type="button"
                disabled={busy === "render"}
                onClick={() => void rerender()}
                className="inline-flex items-center gap-1 rounded-md bg-primary px-2.5 py-1 text-xs font-medium text-primary-foreground hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
              >
                <RefreshCw className="h-3 w-3" aria-hidden="true" />
                {busy === "render" ? "Queuing…" : "Render again"}
              </button>
            </div>
          </div>

          {renders.length === 0 ? (
            <p className="text-sm text-muted-foreground">No renders yet.</p>
          ) : (
            <div className="grid gap-2 sm:grid-cols-3 lg:grid-cols-4">
              {renders.map((r) => (
                <div
                  key={r.id}
                  className={cn(
                    "overflow-hidden rounded-lg border",
                    r.selected ? "border-primary ring-1 ring-primary" : "border-border",
                  )}
                >
                  <div className="flex h-28 items-center justify-center bg-cool-surface">
                    {r.asset_id && urls.get(r.asset_id) ? (
                      <img src={urls.get(r.asset_id)} alt="" className="h-full w-full object-cover" />
                    ) : (
                      <span className="px-2 text-center text-[0.7rem] text-muted-foreground">
                        {r.status === "failed" ? "failed" : "no image"}
                      </span>
                    )}
                  </div>
                  <div className="space-y-1 p-2">
                    <div className="flex items-center gap-1">
                      <span
                        className={cn(
                          "rounded-full px-1.5 py-0.5 text-[0.65rem] font-medium capitalize",
                          STATUS_TONE[r.status] ?? "bg-muted text-muted-foreground",
                        )}
                      >
                        {r.status}
                      </span>
                      <span className="text-[0.65rem] capitalize text-muted-foreground">
                        {r.quality}
                      </span>
                      {r.asset_id && assets.get(r.asset_id)?.review_status === "approved" && (
                        <span className="text-[0.65rem] text-brand-strong">approved</span>
                      )}
                      <span className="ml-auto text-[0.65rem] text-muted-foreground">
                        {r.cost_usd ? `$${Number(r.cost_usd).toFixed(3)}` : "—"}
                      </span>
                    </div>
                    {r.error && (
                      <p className="line-clamp-2 text-[0.65rem] text-destructive" title={r.error}>
                        {r.error}
                      </p>
                    )}
                    {r.status === "done" && (
                      <button
                        type="button"
                        disabled={busy === r.id}
                        onClick={() => void pick(r.id)}
                        className={cn(
                          "flex w-full items-center justify-center gap-1 rounded-md px-2 py-1 text-[0.7rem] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                          r.selected
                            ? "bg-primary/10 font-medium text-brand-strong"
                            : "text-muted-foreground hover:bg-accent",
                        )}
                      >
                        {r.selected && <Check className="h-3 w-3" aria-hidden="true" />}
                        {r.selected ? "Selected" : "Select"}
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ---- what happens to the one you picked ---- */}
      {isImage && (() => {
        const chosen = renders.find((r) => r.selected && r.status === "done");
        if (!chosen?.asset_id) {
          return renders.some((r) => r.status === "done") ? (
            <p className="rounded-md bg-muted/60 px-2.5 py-2 text-xs text-muted-foreground">
              Select a render to approve and schedule it.
            </p>
          ) : null;
        }
        const state = assets.get(chosen.asset_id);
        if (!state) return null;

        return (
          <div className="rounded-md border border-border p-3">
            <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Selected render{state.ref_number ? ` · ${state.ref_number}` : ""}
            </p>

            {state.scheduled_for ? (
              <p className="text-sm text-foreground">
                Scheduled for <strong>{state.scheduled_for}</strong> on{" "}
                <span className="capitalize">{state.channel}</span>. It appears on the client's
                calendar and under Distribution.
              </p>
            ) : state.review_status === "pending" ? (
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm text-muted-foreground">
                  Awaiting review — approve it to make it schedulable.
                </span>
                <button
                  type="button"
                  disabled={busy === "approve"}
                  onClick={() => void approve(chosen.asset_id as string)}
                  className="inline-flex items-center gap-1 rounded-md bg-primary px-2.5 py-1 text-xs font-medium text-primary-foreground hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
                >
                  <ThumbsUp className="h-3 w-3" aria-hidden="true" />
                  {busy === "approve" ? "Approving…" : "Approve"}
                </button>
              </div>
            ) : state.review_status === "rejected" ? (
              <p className="text-sm text-destructive">
                This render was rejected. Edit the concept and render again.
              </p>
            ) : (
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm text-muted-foreground">Approved. Book it in:</span>
                <input
                  type="date"
                  value={scheduleDate}
                  onChange={(e) => setScheduleDate(e.target.value)}
                  className="rounded-md border border-input bg-background px-2 py-1 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                />
                <select
                  value={channel}
                  onChange={(e) => setChannel(e.target.value as "organic" | "paid")}
                  className="rounded-md border border-input bg-background px-2 py-1 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <option value="organic">Organic</option>
                  <option value="paid">Paid</option>
                </select>
                <button
                  type="button"
                  disabled={busy === "schedule"}
                  onClick={() => void schedule(chosen.asset_id as string)}
                  className="inline-flex items-center gap-1 rounded-md bg-primary px-2.5 py-1 text-xs font-medium text-primary-foreground hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
                >
                  <CalendarPlus className="h-3 w-3" aria-hidden="true" />
                  {busy === "schedule" ? "Scheduling…" : "Schedule"}
                </button>
              </div>
            )}
          </div>
        );
      })()}

      {error && (
        <p role="alert" className="rounded-md bg-destructive/10 px-2.5 py-1.5 text-xs text-destructive">
          {error}
        </p>
      )}

      {generation.concept_model && (
        <p className="text-xs text-muted-foreground">
          Concept by {generation.concept_model}
          {generation.image_model ? `, rendered by ${generation.image_model}` : ""}
        </p>
      )}
    </div>
  );
}
