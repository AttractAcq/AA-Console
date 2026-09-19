import { useCallback, useEffect, useMemo, useState } from "react";
import { useParams, Link } from "react-router-dom";
import { Check, ChevronRight, CircleDashed, CircleDot } from "lucide-react";
import { FormModal } from "../../components/forms/FormModal";
import type { FieldDef } from "../../components/forms/fields";
import { supabase } from "../../lib/supabase";
import { cn } from "../../lib/cn";
import {
  ONBOARDING_STEPS,
  missingFor,
  nextStep,
  progress,
  stepState,
  type OnboardingData,
  type OnboardingStep,
  type StepKey,
} from "../../lib/onboarding";

/**
 * Where a client's information is first collected.
 *
 * Every step writes to the table the rest of the app already reads — contact
 * details are client_contact_details, the business step is
 * client_business_context, brand is client_brand_profiles. There is no
 * onboarding copy of anything and nothing to keep in sync: filling a step
 * here is the same act as filling it in its own panel, and each step says
 * where that is so it can be edited later.
 *
 * One step at a time, because ten fields across four subjects in a single
 * form is how a client gets half-onboarded and nobody can see which half.
 */

const CONTACT_FIELDS: FieldDef[] = [
  { name: "primary_contact", label: "Primary contact", kind: "text", required: true, placeholder: "Who we actually speak to" },
  { name: "role_title", label: "Their role", kind: "text", placeholder: "Owner, practice manager…" },
  { name: "email", label: "Email", kind: "text" },
  { name: "phone", label: "Phone", kind: "text" },
  { name: "whatsapp", label: "WhatsApp", kind: "text" },
  {
    name: "website",
    label: "Website",
    kind: "text",
    required: true,
    placeholder: "https://",
    hint: "The Proof Finder and the business researcher both start here. Without it neither can run.",
  },
  { name: "instagram", label: "Instagram", kind: "text", placeholder: "@handle" },
  { name: "facebook", label: "Facebook", kind: "text" },
  { name: "address", label: "Address", kind: "textarea", rows: 2 },
];

const BUSINESS_FIELDS: FieldDef[] = [
  {
    name: "business_overview",
    label: "Business overview",
    kind: "textarea",
    rows: 4,
    required: true,
    hint: "What they do, for whom, and what makes it what it is.",
  },
  {
    name: "ideal_customer",
    label: "Ideal customer",
    kind: "textarea",
    rows: 3,
    required: true,
    hint: "A situation, not a demographic. “Over-55s” is a filter; “has a bridge that failed twice” is a buyer.",
  },
  { name: "main_offer", label: "Main offer", kind: "textarea", rows: 3, required: true },
  {
    name: "competitors",
    label: "Competitors",
    kind: "textarea",
    rows: 3,
    required: true,
    hint: "Named, and how each is positioned differently. Include doing nothing if that is the real alternative.",
  },
  { name: "brand_voice", label: "Brand voice", kind: "textarea", rows: 2 },
  { name: "proof_testimonials", label: "Proof / testimonials", kind: "textarea", rows: 2 },
  { name: "current_marketing", label: "Current marketing", kind: "textarea", rows: 2 },
  { name: "sales_process", label: "Sales process", kind: "textarea", rows: 2 },
];

const BRAND_FIELDS: FieldDef[] = [
  { name: "colour_primary", label: "Primary colour", kind: "text", required: true, placeholder: "#142B23" },
  { name: "colour_secondary", label: "Secondary colour", kind: "text", placeholder: "#F5F7F3" },
  { name: "colour_accent", label: "Accent colour", kind: "text" },
  { name: "font_heading", label: "Heading typeface", kind: "text", placeholder: "Inter" },
  { name: "font_body", label: "Body typeface", kind: "text", placeholder: "Inter" },
  {
    name: "imagery_style",
    label: "Imagery style",
    kind: "textarea",
    rows: 2,
    required: true,
    hint: "Every creative build reads this. Without it assets come back in a default look.",
  },
  { name: "lighting", label: "Lighting", kind: "text", placeholder: "Natural window light, soft shadows" },
  { name: "mood", label: "Mood", kind: "text", placeholder: "Calm, competent, unhurried" },
  {
    name: "never_do",
    label: "Never do",
    kind: "textarea",
    rows: 2,
    hint: "The cliches this sector is drowning in. Read by every creative concept.",
  },
];

/** The database key for the one step that is a manual tick, seeded by start_onboarding. */
const CALL_STEP_KEY = "onboarding_call";

/** Which table a step writes to, and the fields it collects. */
const FORM: Partial<
  Record<
    StepKey,
    {
      table: "client_contact_details" | "client_business_context" | "client_brand_profiles";
      fields: FieldDef[];
    }
  >
> = {
  contact: { table: "client_contact_details", fields: CONTACT_FIELDS },
  business: { table: "client_business_context", fields: BUSINESS_FIELDS },
  brand: { table: "client_brand_profiles", fields: BRAND_FIELDS },
};

const STATE_ICON = {
  done: Check,
  partial: CircleDot,
  empty: CircleDashed,
} as const;

const STATE_TONE = {
  done: "text-brand-strong",
  partial: "text-foreground",
  empty: "text-muted-foreground",
} as const;

export function OnboardingPanel() {
  const { clientId } = useParams<{ clientId: string }>();
  const [data, setData] = useState<OnboardingData | null>(null);
  const [openStep, setOpenStep] = useState<OnboardingStep | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!clientId) return;
    setLoadError(null);
    try {
      const [contact, business, brand, integrations, manual] = await Promise.all([
        supabase.from("client_contact_details").select("*").eq("client_id", clientId).maybeSingle(),
        supabase.from("client_business_context").select("*").eq("client_id", clientId).maybeSingle(),
        supabase.from("client_brand_profiles").select("*").eq("client_id", clientId).maybeSingle(),
        supabase.from("client_integrations").select("provider").eq("client_id", clientId),
        supabase
          .from("client_onboarding_steps")
          .select("step_key, status")
          .eq("client_id", clientId)
          .eq("status", "complete"),
      ]);

      // Supabase reports failure in the result, not by throwing. Without this
      // a broken query reads as "nothing on file", and the panel would say a
      // client had completed none of onboarding when the truth is it could
      // not tell.
      const failed = [contact, business, brand, integrations, manual].find((r) => r.error);
      if (failed?.error) throw new Error(failed.error.message);

      setData({
        contact: (contact.data as Record<string, unknown> | null) ?? null,
        business: (business.data as Record<string, unknown> | null) ?? null,
        brand: (brand.data as Record<string, unknown> | null) ?? null,
        integrations: (integrations.data as { provider: string }[] | null) ?? [],
        // start_onboarding seeds "onboarding_call"; the model calls it "call".
        manualComplete: ((manual.data as { step_key: string }[] | null) ?? [])
          .filter((r) => r.step_key === CALL_STEP_KEY)
          .map(() => "call" as StepKey),
      });
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : "Could not load onboarding.");
    }
  }, [clientId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const next = useMemo(() => (data ? nextStep(data) : null), [data]);

  async function markCall() {
    if (!clientId) return;
    const { error } = await supabase.rpc("start_onboarding", { p_client_id: clientId });
    if (error) {
      setLoadError(error.message);
      return;
    }
    await supabase
      .from("client_onboarding_steps")
      .update({ status: "complete", completed_at: new Date().toISOString() })
      .eq("client_id", clientId)
      .eq("step_key", CALL_STEP_KEY);
    setNotice("Call marked done.");
    void refresh();
  }

  if (loadError) {
    return (
      <div role="alert" className="text-sm text-destructive">
        <p>{loadError}</p>
        <button type="button" onClick={() => void refresh()} className="mt-2 underline">
          Retry
        </button>
      </div>
    );
  }
  if (!data) return <p className="text-sm text-muted-foreground">Loading…</p>;

  const { done, total } = progress(data);
  const form = openStep ? FORM[openStep.key] : undefined;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <h2 className="text-sm font-semibold text-foreground">Onboarding</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Where this client's information is first collected. Everything entered here lands in the
            panel that owns it, so it is filled in once and read everywhere.
          </p>
        </div>
        <span className="text-xs text-muted-foreground">
          {done} of {total} complete
        </span>
      </div>

      {notice && (
        <p role="status" className="text-sm text-brand-strong">
          {notice}
        </p>
      )}

      {next && (
        <p className="rounded-md border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
          Next: <span className="font-medium text-foreground">{next.title}</span> — {next.why}
        </p>
      )}

      <ol className="space-y-2">
        {ONBOARDING_STEPS.map((step, index) => {
          const state = stepState(step.key, data);
          const missing = missingFor(step.key, data);
          const Icon = STATE_ICON[state];
          return (
            <li key={step.key} className="rounded-lg border border-border bg-card p-3">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="flex min-w-0 items-start gap-3">
                  <Icon
                    aria-hidden="true"
                    className={cn("mt-0.5 h-4 w-4 shrink-0", STATE_TONE[state])}
                  />
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-card-foreground">
                      {index + 1}. {step.title}
                    </p>
                    <p className="mt-0.5 text-xs text-muted-foreground">{step.why}</p>
                    {state !== "done" && missing.length > 0 && (
                      <p className="mt-1 text-xs text-muted-foreground">
                        Still needed: {missing.map((m) => m.replace(/_/g, " ")).join(", ")}
                      </p>
                    )}
                    {/* Onboarding collects it; the panel that owns it keeps it. */}
                    <p className="mt-1 text-xs text-muted-foreground">
                      Lives in{" "}
                      <Link
                        to={`/clients/${clientId}/account/${step.livesAt.tab}`}
                        className="text-brand-strong hover:underline"
                      >
                        {step.livesAt.label}
                      </Link>
                    </p>
                  </div>
                </div>

                <div className="shrink-0">
                  {step.manual ? (
                    state === "done" ? (
                      <span className="text-xs text-muted-foreground">Done</span>
                    ) : (
                      <button
                        type="button"
                        onClick={() => void markCall()}
                        className="rounded-md border border-border px-2.5 py-1 text-xs font-medium text-card-foreground hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      >
                        Mark done
                      </button>
                    )
                  ) : step.key === "credentials" ? (
                    <Link
                      to={`/clients/${clientId}/account/integrations`}
                      className="inline-flex items-center gap-1 rounded-md border border-border px-2.5 py-1 text-xs font-medium text-card-foreground hover:bg-accent"
                    >
                      {state === "done" ? "Review" : "Connect"}
                      <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />
                    </Link>
                  ) : (
                    <button
                      type="button"
                      onClick={() => setOpenStep(step)}
                      // Three steps can all be waiting at once. "Fill in" three
                      // times over tells a screen reader nothing about which.
                      aria-label={`${
                        state === "empty" ? "Fill in" : state === "partial" ? "Continue" : "Edit"
                      } ${step.title}`}
                      className="rounded-md border border-border px-2.5 py-1 text-xs font-medium text-card-foreground hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      {state === "empty" ? "Fill in" : state === "partial" ? "Continue" : "Edit"}
                    </button>
                  )}
                </div>
              </div>
            </li>
          );
        })}
      </ol>

      {openStep && form && (
        <FormModal
          open={openStep !== null}
          onClose={() => setOpenStep(null)}
          title={openStep.title}
          intro={`${openStep.why} Saved straight into ${openStep.livesAt.label}.`}
          draftKey={`onboarding:${openStep.key}:${clientId}`}
          fields={form.fields}
          submitLabel="Save"
          initialValues={Object.fromEntries(
            form.fields.map((f) => {
              const row =
                openStep.key === "contact"
                  ? data.contact
                  : openStep.key === "business"
                    ? data.business
                    : data.brand;
              return [f.name, (row?.[f.name] as string | undefined) ?? ""];
            }),
          )}
          onSubmit={async (values) => {
            if (!clientId) throw new Error("No client selected.");
            const payload = Object.fromEntries(
              form.fields.map((f) => [f.name, (values[f.name] as string)?.trim() || null]),
            );
            // The destination table itself, not a copy. This is the same write
            // the step's own panel makes.
            const { error } = await supabase
              .from(form.table)
              .upsert({ client_id: clientId, ...payload }, { onConflict: "client_id" });
            if (error) throw error;
          }}
          onSaved={() => {
            setNotice(`Saved to ${openStep.livesAt.label}.`);
            setOpenStep(null);
            void refresh();
          }}
        />
      )}
    </div>
  );
}
