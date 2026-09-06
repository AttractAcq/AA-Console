import { useCallback, useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { Pencil } from "lucide-react";
import { Button } from "../../components/Button";
import { Panel } from "../../components/Panel";
import { EmptyState } from "../../components/EmptyState";
import { FormModal } from "../../components/forms/FormModal";
import type { FieldDef, FormValues } from "../../components/forms/fields";
import { signPaths } from "../../lib/media";
import { supabase } from "../../lib/supabase";

/**
 * Who the client is, how to reach them, and how they appear in public.
 *
 * The public half is not administrative trivia: a generated asset renders
 * these as literal type, so a wrong number is published as a real one. The
 * first live image build invented a practice name and a phone number because
 * nothing in the system held the real ones — this is where they live now.
 */
const FIELDS: FieldDef[] = [
  { name: "primary_contact", label: "Primary contact", kind: "text", placeholder: "Who we actually speak to" },
  { name: "role_title", label: "Their role", kind: "text", placeholder: "Owner, practice manager…" },
  { name: "email", label: "Email", kind: "text" },
  { name: "phone", label: "Phone", kind: "text" },
  {
    name: "whatsapp",
    label: "WhatsApp",
    kind: "text",
    hint: "Only if it differs from the phone number.",
  },
  { name: "website", label: "Website", kind: "text", placeholder: "https://" },
  { name: "instagram", label: "Instagram", kind: "text", placeholder: "@handle" },
  { name: "facebook", label: "Facebook", kind: "text" },
  { name: "address", label: "Address", kind: "textarea", rows: 3 },
  {
    name: "logo",
    label: "Logo",
    kind: "file",
    accept: "image/*",
    hint: "Placed onto finished creative. The image model is never asked to draw it — an approximated logo is still the wrong mark.",
  },
  { name: "notes", label: "Notes", kind: "textarea", rows: 3 },
];

const TEXT_FIELDS = FIELDS.filter((f) => f.kind !== "file");

/** What a generated asset is allowed to put in front of the public. */
const PUBLIC_FIELDS = new Set(["phone", "whatsapp", "website", "instagram", "facebook", "address"]);

type Row = Record<string, string | null>;

const GROUPS: Array<{ title: string; keys: Array<[string, string]> }> = [
  {
    title: "Who we deal with",
    keys: [
      ["primary_contact", "Primary contact"],
      ["role_title", "Role"],
      ["email", "Email"],
    ],
  },
  {
    title: "Public details",
    keys: [
      ["phone", "Phone"],
      ["whatsapp", "WhatsApp"],
      ["website", "Website"],
      ["instagram", "Instagram"],
      ["facebook", "Facebook"],
      ["address", "Address"],
    ],
  },
];

export function ContactPanel() {
  const { clientId } = useParams<{ clientId: string }>();
  const [row, setRow] = useState<Row | null>(null);
  const [logoUrl, setLogoUrl] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    if (!clientId) return;
    const { data } = await supabase
      .from("client_contact_details")
      .select("*")
      .eq("client_id", clientId)
      .maybeSingle();
    const next = (data as Row) ?? null;
    setRow(next);
    setLogoUrl(
      next?.logo_path ? ((await signPaths("client-media", [next.logo_path])).get(next.logo_path) ?? null) : null,
    );
    setLoading(false);
  }, [clientId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const initialValues: FormValues = Object.fromEntries(
    TEXT_FIELDS.map((f) => [f.name, row?.[f.name] ?? ""]),
  );

  const publicCount = [...PUBLIC_FIELDS].filter((k) => row?.[k]).length;

  if (loading) return <p className="text-sm text-muted-foreground">Loading…</p>;

  return (
    <div>
      <div className="mb-4 flex justify-end">
        <Button icon={Pencil} onClick={() => setOpen(true)}>
          {row ? "Edit details" : "Add details"}
        </Button>
      </div>

      {!row ? (
        <EmptyState label="No contact details yet. Until these exist, generated creative leaves the contact area blank rather than inventing one." />
      ) : (
        <div className="space-y-4">
          <div className="grid gap-4 lg:grid-cols-3">
            {GROUPS.map((group) => (
              <Panel key={group.title} title={group.title}>
                <dl className="space-y-1.5 text-sm">
                  {group.keys.map(([key, label]) =>
                    row[key] ? (
                      <div key={key} className="flex min-w-0 gap-2">
                        <dt className="w-28 shrink-0 text-muted-foreground">{label}</dt>
                        <dd className="min-w-0 whitespace-pre-wrap break-words text-card-foreground">
                          {row[key]}
                        </dd>
                      </div>
                    ) : null,
                  )}
                  {group.keys.every(([k]) => !row[k]) && (
                    <p className="text-sm text-muted-foreground">Nothing recorded.</p>
                  )}
                </dl>
              </Panel>
            ))}

            <Panel title="Logo">
              {logoUrl ? (
                <img src={logoUrl} alt="Client logo" className="max-h-24 object-contain" />
              ) : (
                <p className="text-sm text-muted-foreground">
                  None on file. Generated creative will not draw one.
                </p>
              )}
            </Panel>
          </div>

          {row.notes && (
            <Panel title="Notes">
              <p className="whitespace-pre-wrap text-sm text-muted-foreground">{row.notes}</p>
            </Panel>
          )}

          {/* The point of the page, said once rather than on every field. */}
          <p className="text-xs text-muted-foreground">
            The public details are rendered as literal type on generated creative — exactly as written
            here, or not at all. {publicCount === 0
              ? "None are set, so that area is left blank."
              : `${publicCount} set.`}{" "}
            An asset never invents one.
          </p>
        </div>
      )}

      <FormModal
        open={open}
        onClose={() => setOpen(false)}
        title="Contact Details"
        draftKey={`contact:${clientId}`}
        intro="The public details appear on generated creative exactly as written. Leave a field blank rather than approximate it."
        fields={FIELDS}
        initialValues={initialValues}
        onSubmit={async (values) => {
          if (!clientId) throw new Error("No client selected.");
          const payload: Record<string, string | null> = Object.fromEntries(
            TEXT_FIELDS.map((f) => [f.name, (values[f.name] as string)?.trim() || null]),
          );

          const logo = values.logo;
          if (logo instanceof File) {
            // Storage RLS keys off the client-id prefix, so it has to lead.
            const ext = logo.name.split(".").pop() ?? "png";
            const path = `${clientId}/identity/logo-${crypto.randomUUID()}.${ext}`;
            const { error: uploadError } = await supabase.storage
              .from("client-media")
              .upload(path, logo, { upsert: false });
            if (uploadError) throw new Error(uploadError.message);
            payload.logo_path = path;
          }

          const { error } = await supabase
            .from("client_contact_details")
            .upsert({ client_id: clientId, ...payload }, { onConflict: "client_id" });
          if (error) throw error;
        }}
        onSaved={refresh}
      />
    </div>
  );
}
