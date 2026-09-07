import { useCallback, useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { Palette, Pencil, Type } from "lucide-react";
import { Button } from "../../components/Button";
import { Panel } from "../../components/Panel";
import { FormModal } from "../../components/forms/FormModal";
import type { FieldDef, FormValues } from "../../components/forms/fields";
import { supabase } from "../../lib/supabase";
import { cn } from "../../lib/cn";

/**
 * What the brand looks like, so two assets for one client are recognisably
 * the same company.
 *
 * Identity — the phone number, the logo — was made rigorous after a renderer
 * invented a practice name: every detail is given verbatim or explicitly
 * forbidden. Visual brand had no equivalent, so `art_direction` was reinvented
 * on every build and nothing held it still. This is the other half, and the
 * page leads with what a generated asset will actually carry rather than with
 * a form.
 */
const COLOURS: Array<[string, string, string]> = [
  ["colour_primary", "Primary", "The dominant colour"],
  ["colour_secondary", "Secondary", "Supporting"],
  ["colour_accent", "Accent", "One element only"],
  ["colour_background", "Background", "Grounds the asset"],
  ["colour_text", "Text", "Body copy"],
];

const HEX = /^#[0-9a-fA-F]{6}$/;

const FIELDS: FieldDef[] = [
  ...COLOURS.map(([name, label]) => ({
    name,
    label,
    kind: "text" as const,
    placeholder: "#0064EB",
    hint: "Six-digit hex. The renderer is given this value literally.",
  })),
  { name: "font_heading", label: "Heading typeface", kind: "text", placeholder: "Inter" },
  { name: "font_body", label: "Body typeface", kind: "text", placeholder: "Inter" },
  {
    name: "imagery_style",
    label: "Imagery",
    kind: "text",
    placeholder: "Documentary photography, real people, no studio",
    hint: "The single biggest lever over whether two assets feel related.",
  },
  { name: "lighting", label: "Lighting", kind: "text", placeholder: "Natural window light, soft shadows" },
  { name: "mood", label: "Mood", kind: "text", placeholder: "Calm, competent, unhurried" },
  { name: "composition_notes", label: "Composition", kind: "textarea", rows: 3 },
  {
    name: "never_do",
    label: "Never, for this brand",
    kind: "textarea",
    rows: 3,
    placeholder: "No stock handshakes. No hard-hat stock models. Never gradients.",
    hint: "Added to the bans the renderer already carries.",
  },
  {
    name: "custom_css",
    label: "Custom CSS",
    kind: "textarea",
    rows: 6,
    hint: "Stored for when generated pages render as HTML. Nothing uses it yet — the tokens above are what reach the image models.",
  },
];

type Row = Record<string, string | null>;

function Swatch({ value, label, note }: { value: string | null; label: string; note: string }) {
  return (
    <div className="flex items-center gap-3">
      <div
        className={cn(
          "h-11 w-11 shrink-0 rounded-md border",
          value ? "border-border" : "border-dashed border-border bg-muted/40",
        )}
        style={value ? { backgroundColor: value } : undefined}
        aria-hidden="true"
      />
      <div className="min-w-0">
        <p className="text-sm font-medium text-card-foreground">{label}</p>
        {value ? (
          <p className="font-mono text-xs uppercase text-muted-foreground">{value}</p>
        ) : (
          <p className="text-xs italic text-muted-foreground/70">Not set — {note.toLowerCase()}</p>
        )}
      </div>
    </div>
  );
}

export function BrandPanel() {
  const { clientId } = useParams<{ clientId: string }>();
  const [row, setRow] = useState<Row | null>(null);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    if (!clientId) return;
    const { data } = await supabase
      .from("client_brand_profiles")
      .select("*")
      .eq("client_id", clientId)
      .maybeSingle();
    setRow((data as Row) ?? null);
    setLoading(false);
  }, [clientId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const initialValues: FormValues = Object.fromEntries(
    FIELDS.map((f) => [f.name, row?.[f.name] ?? ""]),
  );

  if (loading) return <p className="text-sm text-muted-foreground">Loading…</p>;

  const coloursSet = COLOURS.filter(([k]) => row?.[k]).length;
  const hasAny = FIELDS.some((f) => f.name !== "custom_css" && row?.[f.name]);

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-4 rounded-lg border border-border bg-card p-5 sm:flex-row sm:items-center">
        <div className="flex shrink-0 items-center gap-1.5">
          {COLOURS.map(([key]) =>
            row?.[key] ? (
              <div
                key={key}
                className="h-10 w-10 rounded-md border border-border"
                style={{ backgroundColor: row[key] as string }}
                aria-hidden="true"
              />
            ) : null,
          )}
          {coloursSet === 0 && (
            <div className="flex h-10 w-10 items-center justify-center rounded-md border border-dashed border-border">
              <Palette className="h-5 w-5 text-muted-foreground/50" aria-hidden="true" />
            </div>
          )}
        </div>

        <div className="min-w-0 flex-1">
          <h2 className="text-base font-semibold text-card-foreground">Brand & Design</h2>
          <p
            className={cn(
              "mt-1 inline-flex rounded-full px-2 py-0.5 text-xs font-medium",
              hasAny ? "bg-primary/10 text-brand-strong" : "bg-destructive/10 text-destructive",
            )}
          >
            {hasAny
              ? `Applied to every build · ${coloursSet}/${COLOURS.length} colours set`
              : "Nothing on file — every build invents its own look"}
          </p>
        </div>

        <Button icon={Pencil} onClick={() => setOpen(true)} className="shrink-0">
          {row ? "Edit brand" : "Add brand"}
        </Button>
      </div>

      <div className="grid items-start gap-4 lg:grid-cols-2">
        <Panel title="Palette">
          <p className="-mt-1 mb-3 text-xs text-muted-foreground">
            Given to the image model as literal hex, not as a description.
          </p>
          <div className="space-y-3">
            {COLOURS.map(([key, label, note]) => (
              <Swatch key={key} value={(row?.[key] as string) ?? null} label={label} note={note} />
            ))}
          </div>
        </Panel>

        <Panel title="Type &amp; treatment">
          <dl className="space-y-2.5 text-sm">
            {(
              [
                ["font_heading", "Headings", Type],
                ["font_body", "Body", Type],
                ["imagery_style", "Imagery", Palette],
                ["lighting", "Lighting", Palette],
                ["mood", "Mood", Palette],
                ["composition_notes", "Composition", Palette],
              ] as Array<[string, string, typeof Type]>
            ).map(([key, label]) => (
              <div key={key} className="min-w-0">
                <dt className="text-xs text-muted-foreground">{label}</dt>
                <dd
                  className={cn(
                    "break-words",
                    row?.[key] ? "text-card-foreground" : "italic text-muted-foreground/70",
                  )}
                >
                  {row?.[key] ?? "Not set"}
                </dd>
              </div>
            ))}
          </dl>
        </Panel>
      </div>

      {row?.never_do && (
        <Panel title="Never, for this brand">
          <p className="whitespace-pre-wrap text-sm text-foreground">{row.never_do}</p>
          <p className="mt-2 text-xs text-muted-foreground">
            Carried into both the concept and the render, on top of the bans every asset already has.
          </p>
        </Panel>
      )}

      <Panel title="Custom CSS">
        {row?.custom_css ? (
          <pre className="max-h-64 overflow-auto rounded-md bg-muted/40 p-3 text-xs text-foreground">
            {row.custom_css}
          </pre>
        ) : (
          <p className="text-sm text-muted-foreground">None on file.</p>
        )}
        {/* Said plainly rather than implied: this is stored, not yet used. */}
        <p className="mt-2 text-xs text-muted-foreground">
          Held for when a generated page is rendered as HTML. Nothing consumes it today — the palette
          and treatment above are what reach the image models.
        </p>
      </Panel>

      <FormModal
        open={open}
        onClose={() => setOpen(false)}
        title="Brand & Design"
        draftKey={`brand:${clientId}`}
        intro="Colours are given to the image model literally, so a value here is what appears. Leave a field blank rather than approximate it — a blank one is stated as absent instead of guessed at."
        fields={FIELDS}
        initialValues={initialValues}
        onSubmit={async (values) => {
          if (!clientId) throw new Error("No client selected.");
          // Checked here as well as by the database, so a typo is a sentence
          // rather than a constraint violation.
          for (const [key, label] of COLOURS.map(([k, l]) => [k, l] as const)) {
            const v = (values[key] as string)?.trim();
            if (v && !HEX.test(v)) {
              throw new Error(`${label} must be a six-digit hex colour like #0064EB — got "${v}".`);
            }
          }
          const payload = Object.fromEntries(
            FIELDS.map((f) => [f.name, (values[f.name] as string)?.trim() || null]),
          );
          const { error } = await supabase
            .from("client_brand_profiles")
            .upsert({ client_id: clientId, ...payload }, { onConflict: "client_id" });
          if (error) throw error;
        }}
        onSaved={refresh}
      />
    </div>
  );
}
