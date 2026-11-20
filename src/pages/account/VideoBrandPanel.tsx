import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "../../components/Button";
import { Panel } from "../../components/Panel";
import { FormModal } from "../../components/forms/FormModal";
import type { FieldDef, FormValues } from "../../components/forms/fields";
import { supabase } from "../../lib/supabase";
import { buildTheme } from "../../../video-render/src/brand/theme";
import { VideoTokenOverridesSchema } from "../../../video-render/src/brand/tokens";
import type { VideoTokenOverrides } from "../../../video-render/src/brand/tokens";

type VideoBrandRow = {
  colour_primary: string | null;
  colour_secondary: string | null;
  colour_accent: string | null;
  colour_background: string | null;
  colour_text: string | null;
  font_heading: string | null;
  font_body: string | null;
  video_tokens: unknown;
  narrator_voice_id: string | null;
  video_rulebook_notes: string | null;
};

const FIELDS: FieldDef[] = [
  { name: "narrator_voice_id", label: "Narrator voice ID", kind: "text",
    hint: "Stored for the audio phase. This does not start narration or publishing." },
  { name: "video_tokens", label: "Video token overrides (JSON)", kind: "textarea", rows: 12,
    hint: "Only include values that differ from the client palette and AA defaults. Colours must be six-digit hex; unknown fields are rejected." },
  { name: "video_rulebook_notes", label: "Additional visual rules", kind: "textarea", rows: 5,
    hint: "Client-specific additions. The global motion grammar still applies." },
];

function field(values: FormValues, key: string): string {
  return typeof values[key] === "string" ? values[key] as string : "";
}

function parseOverrides(raw: string): VideoTokenOverrides | null {
  if (!raw.trim()) return null;
  let input: unknown;
  try { input = JSON.parse(raw); }
  catch { throw new Error("Video token overrides must be valid JSON."); }
  const result = VideoTokenOverridesSchema.safeParse(input);
  if (!result.success) {
    const first = result.error.issues[0];
    throw new Error(`Invalid video tokens at ${first?.path.join(".") || "root"}: ${first?.message || "Check the token values."}`);
  }
  return result.data;
}

export function VideoBrandPanel({ clientId }: { clientId: string }) {
  const [row, setRow] = useState<VideoBrandRow | null>(null);
  const [loadedFor, setLoadedFor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const requestId = useRef(0);

  const refresh = useCallback(async () => {
    const request = ++requestId.current;
    setLoadError(null);
    try {
      const { data, error } = await supabase.from("client_brand_profiles")
        .select("colour_primary, colour_secondary, colour_accent, colour_background, colour_text, font_heading, font_body, video_tokens, narrator_voice_id, video_rulebook_notes")
        .eq("client_id", clientId).maybeSingle();
      if (error) throw error;
      if (request !== requestId.current) return;
      setRow(data as VideoBrandRow | null);
      setLoadedFor(clientId);
    } catch (error) {
      if (request !== requestId.current) return;
      setLoadError(error instanceof Error ? error.message : "Could not read video brand settings.");
      setLoadedFor(clientId);
    } finally {
      if (request === requestId.current) setLoading(false);
    }
  }, [clientId]);

  useEffect(() => { void refresh();
    return () => { requestId.current += 1; };
  }, [refresh]);

  if (loading || loadedFor !== clientId) return <Panel title="Video brand"><p>Loading video settings…</p></Panel>;
  if (loadError) return <Panel title="Video brand"><div role="alert">
    <p>Video settings could not be loaded: {loadError}</p>
    <Button onClick={() => void refresh()}>Retry</Button>
  </div></Panel>;

  const parsed = VideoTokenOverridesSchema.safeParse(row?.video_tokens ?? {});
  const theme = buildTheme({ ...row, video_tokens: parsed.success ? parsed.data : null });
  const initialValues: FormValues = {
    narrator_voice_id: row?.narrator_voice_id ?? "",
    video_tokens: row?.video_tokens == null ? "" : JSON.stringify(row.video_tokens, null, 2),
    video_rulebook_notes: row?.video_rulebook_notes ?? "",
  };

  return <Panel title="Video brand">
    <p className="mb-3 text-sm text-muted-foreground">
      Motion graphics use this palette and type. Video overrides are stored for the upcoming renderer; no video is generated from this page yet.
    </p>
    {!parsed.success && <p role="alert" className="mb-2 text-sm text-destructive">
      Stored video tokens are invalid. The preview uses base colours; edit the JSON to repair the override.
    </p>}
    <div className="mb-3 flex flex-wrap gap-3" aria-label="Video palette">
      {(["background", "surface", "primary", "secondary", "accent", "text"] as const).map((role) =>
        <div key={role} className="flex items-center gap-1.5 text-xs">
          <span className="inline-block h-6 w-6 rounded border border-border" aria-hidden="true"
            style={{ backgroundColor: theme.tokens.colours[role] }} />
          {role}: {theme.tokens.colours[role]}
        </div>)}
    </div>
    <p className="text-xs text-muted-foreground">Caption contrast: {theme.captionContrast.toFixed(1)}:1</p>
    <p className="text-xs text-muted-foreground">Narrator: {row?.narrator_voice_id || "Brand default (not selected)"}</p>
    <Button className="mt-3" onClick={() => setOpen(true)}>Edit video brand</Button>
    <FormModal open={open} onClose={() => setOpen(false)} title="Video brand" fields={FIELDS}
      draftKey={`video-brand:${clientId}`} initialValues={initialValues}
      onSubmit={async (values) => {
        const narratorVoiceId = field(values, "narrator_voice_id").trim() || null;
        const notes = field(values, "video_rulebook_notes").trim() || null;
        if (narratorVoiceId && narratorVoiceId.length > 128) throw new Error("Narrator voice ID is too long.");
        if (notes && notes.length > 4000) throw new Error("Additional visual rules exceed 4,000 characters.");
        const tokens = parseOverrides(field(values, "video_tokens"));
        const { error } = await supabase.from("client_brand_profiles").upsert({
          client_id: clientId, video_tokens: tokens, narrator_voice_id: narratorVoiceId,
          video_rulebook_notes: notes,
        }, { onConflict: "client_id" });
        if (error) throw error;
      }} onSaved={refresh} />
  </Panel>;
}
