import { useCallback, useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { Bot, ImagePlus, Users, X } from "lucide-react";
import { supabase } from "../../lib/supabase";
import { cn } from "../../lib/cn";

type Brief = {
  id: string;
  title: string;
  body: string | null;
  media_type: "image" | "text" | "video";
  brief_ref: string | null;
  status: string;
};

type Member = { id: string; name: string; category: "editors" | "avatars" | "smm" };

const QUALITY = [
  { id: "low", label: "Low", note: "Rough concepts, cheapest" },
  { id: "medium", label: "Medium", note: "Good enough to review" },
  { id: "high", label: "High", note: "Finished, for publishing" },
];

const SIZE = [
  { id: "1024x1536", label: "Portrait", note: "Feed and stories" },
  { id: "1024x1024", label: "Square", note: "General post" },
  { id: "1536x1024", label: "Landscape", note: "Hero and display" },
];

/**
 * The step between an approved brief and a finished asset.
 *
 * Two routes. The AI route builds the asset in two stages — the concept is
 * written first, then rendered from it — and is not offered for video,
 * which people make. The human route hands the brief to an editor or an
 * avatar; the assignment is what matters and the email is the heads-up.
 */
export function ApproveAndBuildModal({
  brief,
  open,
  onClose,
  onDone,
}: {
  brief: Brief | null;
  open: boolean;
  onClose: () => void;
  onDone: () => void;
}) {
  const { clientId } = useParams<{ clientId: string }>();
  const [route, setRoute] = useState<"ai" | "human" | null>(null);
  const [quality, setQuality] = useState("medium");
  const [size, setSize] = useState("1024x1536");
  const [members, setMembers] = useState<Member[]>([]);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [kinds, setKinds] = useState<Set<"editors" | "avatars">>(new Set());
  const [dueDate, setDueDate] = useState("");
  const [compensation, setCompensation] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reference, setReference] = useState<{ path: string; name: string; preview: string } | null>(null);
  const [uploading, setUploading] = useState(false);

  const isVideo = brief?.media_type === "video";

  // Reset every time it opens: a modal that remembers the last brief's
  // choices is how the wrong person gets sent the wrong work.
  useEffect(() => {
    if (!open) return;
    setRoute(isVideo ? "human" : null);
    setQuality("medium");
    setSize("1024x1536");
    setPicked(new Set());
    setKinds(new Set());
    setDueDate("");
    setCompensation("");
    setReference(null);
    setError(null);
  }, [open, brief?.id, isVideo]);

  const loadMembers = useCallback(async () => {
    const { data } = await supabase
      .from("team_members")
      .select("id, name, category")
      .in("category", ["editors", "avatars"])
      .eq("active", true)
      .order("name");
    setMembers((data ?? []) as Member[]);
  }, []);

  useEffect(() => {
    if (open) void loadMembers();
  }, [open, loadMembers]);

  const uploadReference = async (file: File, clientId: string) => {
    setUploading(true);
    setError(null);
    // Storage RLS is written against the path prefix, so the client id has
    // to be the first segment — the same rule every other upload follows.
    const ext = file.name.split(".").pop() ?? "png";
    const path = `${clientId}/references/${crypto.randomUUID()}.${ext}`;
    const { error: uploadError } = await supabase.storage
      .from("client-media")
      .upload(path, file, { upsert: false });
    if (uploadError) {
      setError(uploadError.message);
      setUploading(false);
      return;
    }
    const { data: signed } = await supabase.storage.from("client-media").createSignedUrl(path, 3600);
    setReference({ path, name: file.name, preview: signed?.signedUrl ?? "" });
    setUploading(false);
  };

  if (!open || !brief) return null;

  const toggleKind = (kind: "editors" | "avatars") => {
    setKinds((prev) => {
      const next = new Set(prev);
      if (next.has(kind)) {
        next.delete(kind);
        // Drop anyone whose whole category was just switched off, so the
        // selection can never contain someone you can no longer see.
        setPicked((p) => {
          const kept = new Set(p);
          for (const m of members) if (m.category === kind) kept.delete(m.id);
          return kept;
        });
      } else next.add(kind);
      return next;
    });
  };

  const togglePicked = (id: string) =>
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const visible = members.filter((m) => kinds.has(m.category as "editors" | "avatars"));

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      if (route === "ai") {
        const { error: rpcError } = await supabase.rpc("build_brief_with_ai", {
          p_brief_id: brief.id,
          p_quality: quality,
          p_size: brief.media_type === "image" ? size : "1024x1536",
          p_reference_path: reference?.path ?? undefined,
        });
        if (rpcError) throw new Error(rpcError.message);
      } else {
        const { error: rpcError } = await supabase.rpc("dispatch_brief_to_members", {
          p_brief_id: brief.id,
          p_member_ids: [...picked],
          // The RPC defaults both, so an omitted value must be undefined
          // rather than null for the generated types to accept it.
          p_due_date: dueDate || undefined,
          p_compensation: compensation ? Number(compensation) : undefined,
        });
        if (rpcError) throw new Error(rpcError.message);
      }
      onDone();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong.");
    } finally {
      setBusy(false);
    }
  };

  const canSubmit = route === "ai" ? true : picked.size > 0;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <button type="button" aria-label="Close" className="absolute inset-0 bg-foreground/40" onClick={onClose} />
      <div
        role="dialog"
        aria-modal="true"
        className="relative flex max-h-[88vh] w-full max-w-2xl flex-col overflow-hidden rounded-lg border border-border bg-card shadow-lg"
      >
        <header className="flex shrink-0 items-start justify-between gap-3 border-b border-border px-5 py-4">
          <div>
            <h2 className="text-base font-semibold text-card-foreground">Approve &amp; Build</h2>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {brief.brief_ref ? `${brief.brief_ref} · ` : ""}
              <span className="capitalize">{brief.media_type}</span> · {brief.title}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md px-2 py-1 text-sm text-muted-foreground hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            Close
          </button>
        </header>

        <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-5 py-4">
          {/* the brief itself, so nobody builds from a title alone */}
          <section>
            <h3 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">The brief</h3>
            <div className="max-h-40 overflow-y-auto rounded-md border border-border bg-muted/40 p-3">
              <p className="whitespace-pre-wrap text-sm text-foreground">{brief.body ?? "(no detail on this brief)"}</p>
            </div>
          </section>

          <section>
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Who builds it</h3>
            <div className="grid gap-3 sm:grid-cols-2">
              <button
                type="button"
                disabled={isVideo}
                onClick={() => setRoute("ai")}
                className={cn(
                  "rounded-lg border p-4 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  route === "ai" ? "border-primary bg-primary/5" : "border-border hover:border-primary/50",
                  isVideo && "cursor-not-allowed opacity-50 hover:border-border",
                )}
              >
                <span className="flex items-center gap-2 text-sm font-medium text-card-foreground">
                  <Bot className="h-4 w-4" aria-hidden="true" /> AI
                </span>
                <span className="mt-1 block text-xs text-muted-foreground">
                  {isVideo
                    ? "Not available for video — video is made by people."
                    : "Writes the creative concept, then renders it. Text and image only."}
                </span>
              </button>

              <button
                type="button"
                onClick={() => setRoute("human")}
                className={cn(
                  "rounded-lg border p-4 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  route === "human" ? "border-primary bg-primary/5" : "border-border hover:border-primary/50",
                )}
              >
                <span className="flex items-center gap-2 text-sm font-medium text-card-foreground">
                  <Users className="h-4 w-4" aria-hidden="true" /> Human
                </span>
                <span className="mt-1 block text-xs text-muted-foreground">
                  Send it to an editor or an avatar. Lands on their dashboard and emails them.
                </span>
              </button>
            </div>
          </section>

          {route === "ai" && (
            <section className="space-y-4">
              <div>
                <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Quality</h3>
                <div className="grid gap-2 sm:grid-cols-3">
                  {QUALITY.map((q) => (
                    <button
                      key={q.id}
                      type="button"
                      onClick={() => setQuality(q.id)}
                      className={cn(
                        "rounded-md border px-3 py-2 text-left text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                        quality === q.id ? "border-primary bg-primary/5" : "border-border hover:border-primary/50",
                      )}
                    >
                      <span className="font-medium text-card-foreground">{q.label}</span>
                      <span className="block text-xs text-muted-foreground">{q.note}</span>
                    </button>
                  ))}
                </div>
              </div>

              {brief.media_type === "image" && (
                <div>
                  <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Shape</h3>
                  <div className="grid gap-2 sm:grid-cols-3">
                    {SIZE.map((s) => (
                      <button
                        key={s.id}
                        type="button"
                        onClick={() => setSize(s.id)}
                        className={cn(
                          "rounded-md border px-3 py-2 text-left text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                          size === s.id ? "border-primary bg-primary/5" : "border-border hover:border-primary/50",
                        )}
                      >
                        <span className="font-medium text-card-foreground">{s.label}</span>
                        <span className="block text-xs text-muted-foreground">{s.note}</span>
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {brief.media_type === "image" && (
                <div>
                  <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    Start from an image <span className="font-normal normal-case">(optional)</span>
                  </h3>
                  {reference ? (
                    <div className="flex items-center gap-3 rounded-md border border-border p-2">
                      {reference.preview && (
                        <img
                          src={reference.preview}
                          alt=""
                          className="h-16 w-16 shrink-0 rounded object-cover"
                        />
                      )}
                      <span className="min-w-0 flex-1 truncate text-sm text-foreground">{reference.name}</span>
                      <button
                        type="button"
                        aria-label="Remove reference image"
                        onClick={() => setReference(null)}
                        className="rounded-md p-1.5 text-muted-foreground hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      >
                        <X className="h-4 w-4" aria-hidden="true" />
                      </button>
                    </div>
                  ) : (
                    <label
                      className={cn(
                        "flex cursor-pointer items-center gap-2 rounded-md border border-dashed border-border px-3 py-3 text-sm text-muted-foreground",
                        "hover:border-primary/50 focus-within:ring-2 focus-within:ring-ring",
                        uploading && "opacity-60",
                      )}
                    >
                      <ImagePlus className="h-4 w-4" aria-hidden="true" />
                      {uploading ? "Uploading…" : "Upload a product shot, layout or photo to build from"}
                      <input
                        type="file"
                        accept="image/*"
                        className="sr-only"
                        disabled={uploading}
                        onChange={(e) => {
                          const file = e.target.files?.[0];
                          if (file && clientId) void uploadReference(file, clientId);
                        }}
                      />
                    </label>
                  )}
                  {reference && (
                    <p className="mt-1.5 text-xs text-muted-foreground">
                      The concept will be written as direction on this image — what to keep, change and
                      add — rather than describing a picture to build from nothing.
                    </p>
                  )}
                </div>
              )}

              <p className="rounded-md bg-muted/60 px-3 py-2 text-xs text-muted-foreground">
                It writes the concept first — what is actually in frame — and renders from that, so the
                result follows the brief rather than the industry's stock imagery. The finished asset
                appears under this client's Media, awaiting review.
              </p>
            </section>
          )}

          {route === "human" && (
            <section className="space-y-4">
              <div>
                <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Send to</h3>
                <div className="flex gap-2">
                  {(["editors", "avatars"] as const).map((kind) => (
                    <button
                      key={kind}
                      type="button"
                      onClick={() => toggleKind(kind)}
                      className={cn(
                        "rounded-full border px-3 py-1.5 text-sm capitalize focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                        kinds.has(kind)
                          ? "border-primary bg-primary/5 text-foreground"
                          : "border-border text-muted-foreground hover:border-primary/50",
                      )}
                    >
                      {kind}
                    </button>
                  ))}
                </div>
              </div>

              {kinds.size > 0 && (
                <div>
                  <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    Who exactly
                  </h3>
                  {visible.length === 0 ? (
                    <p className="text-sm text-muted-foreground">No active people in that group.</p>
                  ) : (
                    <ul className="space-y-1">
                      {visible.map((m) => (
                        <li key={m.id}>
                          <label className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 hover:bg-accent">
                            <input
                              type="checkbox"
                              checked={picked.has(m.id)}
                              onChange={() => togglePicked(m.id)}
                              className="h-4 w-4 rounded border-input"
                            />
                            <span className="text-sm text-foreground">{m.name}</span>
                            <span className="text-xs capitalize text-muted-foreground">{m.category}</span>
                          </label>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}

              <div className="grid gap-3 sm:grid-cols-2">
                <label className="text-sm">
                  <span className="mb-1 block text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    Due date
                  </span>
                  <input
                    type="date"
                    value={dueDate}
                    onChange={(e) => setDueDate(e.target.value)}
                    className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  />
                </label>
                <label className="text-sm">
                  <span className="mb-1 block text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    Compensation
                  </span>
                  <input
                    type="number"
                    min="0"
                    step="0.01"
                    value={compensation}
                    onChange={(e) => setCompensation(e.target.value)}
                    placeholder="Per person"
                    className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  />
                </label>
              </div>
            </section>
          )}

          {error && (
            <p role="alert" className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {error}
            </p>
          )}
        </div>

        <footer className="flex shrink-0 items-center justify-end gap-2 border-t border-border px-5 py-3">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md px-3 py-2 text-sm text-muted-foreground hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={!route || !canSubmit || busy}
            onClick={() => void submit()}
            className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
          >
            {busy
              ? "Working…"
              : route === "human"
                ? `Send to ${picked.size || "…"}`
                : "Generate"}
          </button>
        </footer>
      </div>
    </div>
  );
}
