import { useCallback, useEffect, useMemo, useState } from "react";
import { useParams } from "react-router-dom";
import { Plus } from "lucide-react";
import { Button } from "../../components/Button";
import { DataTable } from "../../components/DataTable";
import { FormModal } from "../../components/forms/FormModal";
import type { FieldDef } from "../../components/forms/fields";
import { ACCESS_LEVEL_OPTIONS } from "../../lib/options";
import { supabase } from "../../lib/supabase";
import { SYNCING_PROVIDERS } from "../../lib/onboarding";
import { cn } from "../../lib/cn";

type Integration = {
  id: string;
  provider: string;
  credential_label: string | null;
  access_level: string | null;
  status: string;
  ingest_enabled: boolean;
  last_checked_at: string | null;
  ad_account_id: string | null;
  meta_page_id: string | null;
  meta_pixel_id: string | null;
};

/**
 * What building ads needs from the Meta account beyond the token. The page
 * every ad runs from, and the pixel conversion goals count against. The
 * currency is deliberately not asked for: the build reads it from Meta.
 */
const META_AD_FIELDS: FieldDef[] = [
  {
    name: "meta_page_id",
    label: "Facebook page ID",
    kind: "text",
    required: true,
    placeholder: "104123456789012",
    hint: "The page ads run from. In Meta Business Suite: Settings → Business assets → Pages.",
  },
  {
    name: "meta_pixel_id",
    label: "Pixel ID (optional)",
    kind: "text",
    placeholder: "123456789012345",
    hint: "Needed only for templates that optimise for conversions or landing page views.",
  },
];

function numericId(value: unknown, label: string): string | null {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) return null;
  if (!/^[0-9]+$/.test(text)) throw new Error(`${label} should be digits only.`);
  return text;
}

/**
 * Which providers the daily metrics pull knows how to read, and what it
 * pulls from each. Anything else is a credential we store but do not sync,
 * so it gets no toggle rather than a dead one.
 */
const SYNCS: Record<string, string> = {
  meta: "Paid campaign metrics, daily",
  instagram: "Organic post and account metrics, daily",
};

const FIELDS: FieldDef[] = [
  {
    name: "provider",
    label: "Provider",
    kind: "select",
    required: true,
    options: [
      { value: "meta", label: "Meta" },
      { value: "instagram", label: "Instagram" },
      { value: "facebook", label: "Facebook" },
      { value: "resend", label: "Resend" },
      { value: "google", label: "Google" },
      { value: "other", label: "Other" },
    ],
  },
  {
    name: "credential_label",
    label: "Account ID",
    kind: "text",
    placeholder: "act_1234567890 for Meta, 17841400000000000 for Instagram",
    hint: "Meta pulls paid metrics from an ad account (act_…); Instagram pulls organic from an IG user id. Connect one of each to sync both.",
  },
  {
    name: "secret",
    label: "Credential",
    kind: "password",
    required: true,
    hint: "Stored in Supabase Vault. Never written to a table and never shown again.",
  },
  { name: "access_level", label: "Access level", kind: "select", options: ACCESS_LEVEL_OPTIONS },
];

export function IntegrationsPanel() {
  const [addOpen, setAddOpen] = useState(false);
  const [adSettings, setAdSettings] = useState<Integration | null>(null);
  const { clientId } = useParams<{ clientId: string }>();
  const [rows, setRows] = useState<Integration[]>([]);
  const [saving, setSaving] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!clientId) return;
    setLoadError(null);
    try {
      const { data, error } = await supabase
        .from("client_integrations")
        .select("id, provider, credential_label, access_level, status, ingest_enabled, last_checked_at, ad_account_id, meta_page_id, meta_pixel_id")
        .eq("client_id", clientId)
        .order("provider");
      if (error) throw error;
      setRows((data ?? []) as Integration[]);
    } catch (error) {
      setLoadError("Failed to load integrations: " + (error instanceof Error ? error.message : (error as { message?: string })?.message ?? "Unknown query error"));
    }
  }, [clientId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const adSettingsValues = useMemo(
    () => ({ meta_page_id: adSettings?.meta_page_id ?? "", meta_pixel_id: adSettings?.meta_pixel_id ?? "" }),
    [adSettings],
  );

  /**
   * Turns the scheduled pull on or off for one integration. This gates the
   * schedule only — the ingest can still be run by hand, which is what you
   * want for a one-off backfill without arming a recurring job.
   */
  const setIngest = async (integration: Integration, enabled: boolean) => {
    setSaving(integration.id);
    setError(null);
    // Optimistic: the switch should move under the finger, not after a
    // round trip. Rolled back below if the write is refused.
    setRows((prev) =>
      prev.map((r) => (r.id === integration.id ? { ...r, ingest_enabled: enabled } : r)),
    );
    const { error: updateError } = await supabase
      .from("client_integrations")
      .update({ ingest_enabled: enabled })
      .eq("id", integration.id);
    if (updateError) {
      setRows((prev) =>
        prev.map((r) => (r.id === integration.id ? { ...r, ingest_enabled: !enabled } : r)),
      );
      setError(updateError.message);
    }
    setSaving(null);
  };

  if (loadError) return <div role="alert"><p>{loadError}</p><button type="button" onClick={() => void refresh()}>Retry</button></div>;

  // The credentials onboarding asks for, and whether they have arrived. Read
  // from the same list onboarding scores itself against, so the two cannot
  // disagree about what "credentials collected" means.
  const connected = new Set(rows.map((r) => r.provider));
  const outstanding = SYNCING_PROVIDERS.filter((p) => !connected.has(p));

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-muted-foreground">
          {outstanding.length === 0 ? (
            <>
              Both credentials onboarding asks for are connected. Reporting and attribution have
              numbers to pull.
            </>
          ) : (
            <>
              Onboarding is waiting on:{" "}
              <span className="font-medium capitalize text-foreground">
                {outstanding.join(", ")}
              </span>
              . Until these are here, reporting and attribution have nothing to read.
            </>
          )}
        </p>
        <Button icon={Plus} onClick={() => setAddOpen(true)}>
          Add
        </Button>
      </div>

      {error && (
        <p role="alert" className="mb-3 rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </p>
      )}

      <DataTable
        columns={["Integration", "Credential", "Access Level", "Status", "Daily sync", "Ads"]}
        emptyLabel="No integrations connected yet"
        rows={rows.map((r) => [
          <span key="p" className="capitalize">{r.provider}</span>,
          r.credential_label ?? "—",
          r.access_level ?? "—",
          <span
            key="s"
            className={cn(
              "inline-block rounded-full px-2 py-0.5 text-xs font-medium capitalize",
              r.status === "error"
                ? "bg-destructive/10 text-destructive"
                : "bg-primary/10 text-brand-strong",
            )}
          >
            {r.status}
          </span>,
          SYNCS[r.provider] ? (
            <div key="t" className="flex items-center gap-2">
              <button
                type="button"
                role="switch"
                aria-checked={r.ingest_enabled}
                aria-label={`Daily sync for ${r.provider}`}
                disabled={saving === r.id}
                onClick={() => void setIngest(r, !r.ingest_enabled)}
                className={cn(
                  "relative h-5 w-9 shrink-0 rounded-full transition-colors disabled:opacity-50",
                  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
                  r.ingest_enabled ? "bg-primary" : "bg-muted-foreground/30",
                )}
              >
                <span
                  className={cn(
                    "absolute top-0.5 h-4 w-4 rounded-full bg-background transition-transform",
                    r.ingest_enabled ? "translate-x-[1.125rem]" : "translate-x-0.5",
                  )}
                />
              </button>
              <span className="text-xs text-muted-foreground">
                {r.ingest_enabled ? "On" : "Off"}
                {r.last_checked_at && r.ingest_enabled
                  ? ` · last ${new Date(r.last_checked_at).toLocaleDateString()}`
                  : ""}
              </span>
            </div>
          ) : (
            <span key="t" className="text-xs text-muted-foreground">
              Not synced
            </span>
          ),
          r.provider === "meta" ? (
            <button
              key="a"
              type="button"
              onClick={() => setAdSettings(r)}
              className="text-xs text-brand-strong hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {r.meta_page_id ? `Page ${r.meta_page_id}` : "Add page for ads"}
            </button>
          ) : (
            <span key="a" className="text-xs text-muted-foreground">—</span>
          ),
        ])}
      />

      {rows.some((r) => SYNCS[r.provider]) && (
        <p className="mt-3 text-xs text-muted-foreground">
          Daily sync runs at 03:15 UTC and re-pulls the last 7 days, because these numbers keep
          moving for about a week after the fact. Turning it off stops the schedule; you can still
          run a pull by hand.
        </p>
      )}

      <FormModal
        open={adSettings !== null}
        onClose={() => setAdSettings(null)}
        title="Meta ad settings"
        intro="What building ads in Meta needs beyond the credential. Ads are always built paused; launching happens in Ads Manager."
        fields={META_AD_FIELDS}
        initialValues={adSettingsValues}
        submitLabel="Save"
        onSubmit={async (v) => {
          if (!adSettings) throw new Error("No integration selected.");
          const pageId = numericId(v.meta_page_id, "The page ID");
          if (!pageId) throw new Error("The page ID is required.");
          const { error } = await supabase
            .from("client_integrations")
            .update({ meta_page_id: pageId, meta_pixel_id: numericId(v.meta_pixel_id, "The pixel ID") })
            .eq("id", adSettings.id);
          if (error) throw new Error(error.message);
        }}
        onSaved={refresh}
      />

      <FormModal
        open={addOpen}
        onClose={() => setAddOpen(false)}
        title="Add Integration"
        draftKey={`integration:${clientId}`}
        fields={FIELDS}
        submitLabel="Connect"
        onSubmit={async (v) => {
          if (!clientId) throw new Error("No client selected.");
          const { error } = await supabase.rpc("admin_store_integration_credential", {
            p_client_id: clientId,
            p_provider: v.provider as string,
            p_label: (v.credential_label as string)?.trim() || "default",
            p_secret: v.secret as string,
            p_access_level: (v.access_level as string) || undefined,
          });
          if (error) throw new Error(error.message);
        }}
        onSaved={refresh}
      />
    </div>
  );
}
