import { useCallback, useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import {
  Building2,
  Camera,
  Check,
  Copy,
  ExternalLink,
  Globe,
  Mail,
  MapPin,
  MessageCircle,
  Pencil,
  Phone,
  Share2,
  User,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { Button } from "../../components/Button";
import { Panel } from "../../components/Panel";
import { FormModal } from "../../components/forms/FormModal";
import type { FieldDef, FormValues } from "../../components/forms/fields";
import { signPaths } from "../../lib/media";
import { supabase } from "../../lib/supabase";
import { cn } from "../../lib/cn";

/**
 * Who the client is, how to reach them, and how they appear in public.
 *
 * The public half is not administrative trivia: a generated asset renders
 * these as literal type, so a wrong number is published as a real one. The
 * first live image build invented a practice name and a phone number because
 * nothing in the system held the real ones — this is where they live now.
 *
 * Which is why this page shows what is *missing* as prominently as what is
 * set. A blank field is not an empty row to be tidied away; it is the reason
 * a corner of the next advert will be empty, and the operator needs to see
 * that before the render, not after.
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

type Row = Record<string, string | null>;

type Detail = {
  key: string;
  label: string;
  icon: LucideIcon;
  /** Turns a stored value into something a browser can act on. */
  href?: (value: string) => string;
  multiline?: boolean;
};

const INTERNAL: Detail[] = [
  { key: "primary_contact", label: "Primary contact", icon: User },
  { key: "role_title", label: "Role", icon: Building2 },
  { key: "email", label: "Email", icon: Mail, href: (v) => `mailto:${v}` },
];

/** What a generated asset is allowed to put in front of the public. */
const PUBLIC: Detail[] = [
  { key: "phone", label: "Phone", icon: Phone, href: (v) => `tel:${v.replace(/[^\d+]/g, "")}` },
  {
    key: "whatsapp",
    label: "WhatsApp",
    icon: MessageCircle,
    href: (v) => `https://wa.me/${v.replace(/[^\d]/g, "")}`,
  },
  {
    key: "website",
    label: "Website",
    icon: Globe,
    href: (v) => (/^https?:\/\//i.test(v) ? v : `https://${v}`),
  },
  {
    key: "instagram",
    label: "Instagram",
    icon: Camera,
    href: (v) => `https://instagram.com/${v.replace(/^@/, "")}`,
  },
  {
    key: "facebook",
    label: "Facebook",
    icon: Share2,
    href: (v) => (/^https?:\/\//i.test(v) ? v : `https://facebook.com/${v}`),
  },
  { key: "address", label: "Address", icon: MapPin, multiline: true },
];

/** Copies a value and says so, briefly. Silent failure beats a thrown error. */
function CopyButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      // The label carries the confirmation too: the icon swap alone says
      // nothing to a screen reader.
      aria-label={copied ? `${label} copied` : `Copy ${label}`}
      onClick={() => {
        void navigator.clipboard
          ?.writeText(value)
          .then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          })
          .catch(() => undefined);
      }}
      className={cn(
        "shrink-0 rounded-md p-1.5 transition-opacity focus-visible:outline-none",
        // Always visible on touch, where there is no hover to reveal it —
        // hover-only would make this unreachable on a phone.
        "opacity-100 sm:opacity-0 sm:group-hover:opacity-100",
        "focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring",
        copied ? "text-brand-strong opacity-100" : "text-muted-foreground hover:bg-accent",
      )}
    >
      {copied ? (
        <Check className="h-3.5 w-3.5" aria-hidden="true" />
      ) : (
        <Copy className="h-3.5 w-3.5" aria-hidden="true" />
      )}
    </button>
  );
}

function DetailRow({ detail, value }: { detail: Detail; value: string | null }) {
  const Icon = detail.icon;
  const href = value && detail.href ? detail.href(value) : null;
  const external = href?.startsWith("http");

  return (
    <div className="group flex items-start gap-2.5 rounded-md py-1.5">
      <Icon
        className={cn("mt-0.5 h-4 w-4 shrink-0", value ? "text-muted-foreground" : "text-muted-foreground/40")}
        aria-hidden="true"
      />
      <div className="min-w-0 flex-1">
        <p className="text-xs text-muted-foreground">{detail.label}</p>
        {value ? (
          href ? (
            <a
              href={href}
              target={external ? "_blank" : undefined}
              rel={external ? "noreferrer" : undefined}
              className={cn(
                "inline-flex items-center gap-1 break-words text-sm text-card-foreground",
                "rounded hover:text-brand-strong hover:underline",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              )}
            >
              {value}
              {external && <ExternalLink className="h-3 w-3 shrink-0" aria-hidden="true" />}
            </a>
          ) : (
            <p
              className={cn(
                "break-words text-sm text-card-foreground",
                detail.multiline && "whitespace-pre-wrap",
              )}
            >
              {value}
            </p>
          )
        ) : (
          // Shown rather than omitted: on the public side this is the reason
          // a corner of the next advert will be blank.
          <p className="text-sm italic text-muted-foreground/70">Not set</p>
        )}
      </div>
      {value && <CopyButton value={value} label={detail.label} />}
    </div>
  );
}

export function ContactPanel() {
  const { clientId } = useParams<{ clientId: string }>();
  const [row, setRow] = useState<Row | null>(null);
  const [clientName, setClientName] = useState<string | null>(null);
  const [logoUrl, setLogoUrl] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    if (!clientId) return;
    const [{ data }, { data: client }] = await Promise.all([
      supabase.from("client_contact_details").select("*").eq("client_id", clientId).maybeSingle(),
      supabase.from("clients").select("name").eq("id", clientId).maybeSingle(),
    ]);
    const next = (data as Row) ?? null;
    setRow(next);
    setClientName((client?.name as string | null) ?? null);
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

  if (loading) return <p className="text-sm text-muted-foreground">Loading…</p>;

  const publicSet = PUBLIC.filter((d) => row?.[d.key]).length;
  const ready = publicSet > 0 && Boolean(logoUrl);

  return (
    <div className="space-y-4">
      {/* Identity as it will actually appear, not as a list of columns. */}
      <div className="flex flex-col gap-4 rounded-lg border border-border bg-card p-5 sm:flex-row sm:items-center">
        <div className="flex h-20 w-20 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-border bg-cool-surface">
          {logoUrl ? (
            <img src={logoUrl} alt={`${clientName ?? "Client"} logo`} className="h-full w-full object-contain p-1.5" />
          ) : (
            <Building2 className="h-7 w-7 text-muted-foreground/50" aria-hidden="true" />
          )}
        </div>

        <div className="min-w-0 flex-1">
          <h2 className="truncate text-base font-semibold text-card-foreground">
            {clientName ?? "This client"}
          </h2>
          <p className="mt-0.5 text-sm text-muted-foreground">
            {row?.primary_contact
              ? `${row.primary_contact}${row.role_title ? ` · ${row.role_title}` : ""}`
              : "No primary contact recorded"}
          </p>
          <p
            className={cn(
              "mt-1.5 inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium",
              ready
                ? "bg-primary/10 text-brand-strong"
                : "bg-destructive/10 text-destructive",
            )}
          >
            {ready
              ? `Creative-ready · ${publicSet} public detail${publicSet === 1 ? "" : "s"} and a logo`
              : !logoUrl && publicSet === 0
                ? "Creative will carry no identity at all"
                : !logoUrl
                  ? "No logo — creative leaves the mark off"
                  : "No public details — creative leaves the contact area blank"}
          </p>
        </div>

        <Button icon={Pencil} onClick={() => setOpen(true)} className="shrink-0">
          {row ? "Edit details" : "Add details"}
        </Button>
      </div>

      {/* items-start so the shorter internal panel sizes to its content
          rather than stretching to match the public one. */}
      <div className="grid items-start gap-4 lg:grid-cols-2">
        <Panel title="Who we deal with">
          <p className="-mt-1 mb-2 text-xs text-muted-foreground">
            Internal. Never rendered onto anything.
          </p>
          <div className="divide-y divide-border/60">
            {INTERNAL.map((d) => (
              <DetailRow key={d.key} detail={d} value={row?.[d.key] ?? null} />
            ))}
          </div>
        </Panel>

        {/* The consequential half, marked as such: what is here is what a
            generated advert will print, character for character. */}
        <Panel
          title="Public details"
          className="border-primary/30"
          action={
            <span className="rounded-full bg-secondary px-2 py-0.5 text-xs font-medium text-secondary-foreground">
              {publicSet}/{PUBLIC.length} set
            </span>
          }
        >
          <p className="-mt-1 mb-2 text-xs text-muted-foreground">
            Rendered as literal type on generated creative — exactly as written here, or not at all.
            An asset never invents one.
          </p>
          <div className="divide-y divide-border/60">
            {PUBLIC.map((d) => (
              <DetailRow key={d.key} detail={d} value={row?.[d.key] ?? null} />
            ))}
          </div>
        </Panel>
      </div>

      <Panel title="Logo">
        <div className="flex flex-wrap items-center gap-4">
          <div className="flex h-24 w-40 items-center justify-center rounded-md border border-border bg-cool-surface p-2">
            {logoUrl ? (
              <img src={logoUrl} alt="Client logo" className="max-h-full max-w-full object-contain" />
            ) : (
              <span className="text-xs text-muted-foreground">None on file</span>
            )}
          </div>
          <p className="min-w-0 flex-1 text-sm text-muted-foreground">
            {logoUrl ? (
              <>
                Composited onto finished renders, pixel for pixel. The image model is never asked to
                draw it — an approximated wordmark is still the wrong mark.
              </>
            ) : (
              <>
                Without one, a render leaves the mark off rather than approximating it.{" "}
                <button
                  type="button"
                  onClick={() => setOpen(true)}
                  className="rounded font-medium text-brand-strong hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  Upload a logo
                </button>
                .
              </>
            )}
          </p>
        </div>
      </Panel>

      {row?.notes && (
        <Panel title="Notes">
          <p className="whitespace-pre-wrap text-sm text-muted-foreground">{row.notes}</p>
        </Panel>
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
