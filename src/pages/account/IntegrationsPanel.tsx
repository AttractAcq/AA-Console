import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import { Plus } from "lucide-react";
import { Button } from "../../components/Button";
import { DataTable } from "../../components/DataTable";
import { FormModal } from "../../components/forms/FormModal";
import { integrationDraftKey } from "../../components/forms/draftStorage";
import type { FieldDef } from "../../components/forms/fields";
import { ACCESS_LEVEL_OPTIONS } from "../../lib/options";
import { supabase } from "../../lib/supabase";
import { SYNCING_PROVIDERS } from "../../lib/onboarding";
import { cn } from "../../lib/cn";
import { MetricsBackfill } from "../../components/MetricsBackfill";
import { integrationCapabilitySummary } from "./integrationHealth";
import { integrationRowsAreValid, providerReadiness, type IntegrationEvidence, type ReadinessCheck } from "../../lib/integrationReadiness";

type Integration = IntegrationEvidence & {
  id: string;
  access_level: string | null;
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

function dateLabel(value: string | null): string | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toLocaleDateString();
}

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
      // Proof distribution reads this one: a Business Profile post is made
      // with a credential of its own, not with the Google Ads one.
      { value: "google_business", label: "Google Business Profile" },
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
  const [snapshot, setSnapshot] = useState<{ clientId: string; rows: Integration[]; observedAtMs: number } | null>(null);
  const [saving, setSaving] = useState<{ clientId: string; integrationId: string } | null>(null);
  const [error, setError] = useState<{ clientId: string; message: string } | null>(null);
  const [loadError, setLoadError] = useState<{ clientId: string; message: string } | null>(null);
  const activeClient = useRef<string | null>(null);
  const requestGeneration = useRef(0);

  const refresh = useCallback(async () => {
    if (!clientId || activeClient.current !== clientId) return;
    const generation = ++requestGeneration.current;
    const isCurrent = () => activeClient.current === clientId && requestGeneration.current === generation;
    setLoadError(null);
    try {
      const { data, error } = await supabase
        .from("client_integrations")
        .select("id, client_id, provider, credential_secret_id, credential_label, access_level, status, ingest_enabled, last_checked_at, token_expires_at, ad_account_id, meta_page_id, meta_pixel_id")
        .eq("client_id", clientId)
        .order("provider");
      if (error) throw error;
      if (!integrationRowsAreValid(data, clientId)
        || !data.every((row) => typeof row.id === "string" && typeof row.access_level !== "undefined")) {
        throw new Error("Integration evidence is unavailable or returned another client's data.");
      }
      if (isCurrent()) setSnapshot({ clientId, rows: data as Integration[], observedAtMs: Date.now() });
    } catch (error) {
      if (isCurrent()) {
        setLoadError({
          clientId,
          message: "Failed to load integrations: " + (error instanceof Error ? error.message : (error as { message?: string })?.message ?? "Unknown query error"),
        });
      }
    }
  }, [clientId]);

  useEffect(() => {
    activeClient.current = clientId ?? null;
    // The render guard below closes a previous client's dialog immediately;
    // clearing the selection also keeps it closed if the route later returns.
    setAdSettings(null);
    void refresh();
    return () => {
      activeClient.current = null;
      requestGeneration.current += 1;
    };
  }, [clientId, refresh]);

  const rows = snapshot && snapshot.clientId === clientId ? snapshot.rows : [];
  const selectedAdSettingsId = adSettings && clientId && adSettings.client_id === clientId
    ? adSettings.id : null;
  const currentAdSettings = selectedAdSettingsId && snapshot?.clientId === clientId
    ? rows.find((row) => row.id === selectedAdSettingsId && row.client_id === clientId) ?? null
    : null;

  const adSettingsValues = useMemo(
    () => ({ meta_page_id: currentAdSettings?.meta_page_id ?? "", meta_pixel_id: currentAdSettings?.meta_pixel_id ?? "" }),
    [currentAdSettings],
  );

  /**
   * Turns the scheduled pull on or off for one integration. This gates the
   * schedule only — the ingest can still be run by hand, which is what you
   * want for a one-off backfill without arming a recurring job.
   */
  const setIngest = async (integration: Integration, enabled: boolean) => {
    if (!clientId || activeClient.current !== clientId || integration.client_id !== clientId) return;
    setSaving({ clientId, integrationId: integration.id });
    setError(null);
    // Optimistic: the switch should move under the finger, not after a
    // round trip. Rolled back below if the write is refused.
    setSnapshot((prev) => {
      if (!prev || prev.clientId !== clientId) return prev;
      return {
        ...prev,
        rows: prev.rows.map((r) => r.id === integration.id ? { ...r, ingest_enabled: enabled } : r),
      };
    });
    const { error: updateError } = await supabase
      .from("client_integrations")
      .update({ ingest_enabled: enabled })
      .eq("id", integration.id)
      .eq("client_id", clientId);
    if (updateError) {
      setSnapshot((prev) => {
        if (!prev || prev.clientId !== clientId) return prev;
        return {
          ...prev,
          rows: prev.rows.map((r) => r.id === integration.id ? { ...r, ingest_enabled: !enabled } : r),
        };
      });
      if (clientId) setError({ clientId, message: updateError.message });
    }
    setSaving((prev) => prev?.clientId === clientId && prev.integrationId === integration.id ? null : prev);
  };

  if (loadError && loadError.clientId === clientId) return <div role="alert"><p>{loadError.message}</p><button type="button" onClick={() => void refresh()}>Retry</button></div>;
  if (!clientId) return <p role="alert">No client selected.</p>;
  if (!snapshot || snapshot.clientId !== clientId) return <p className="text-sm text-muted-foreground">Loading integrations…</p>;

  // The credentials onboarding asks for, and whether they have arrived. Read
  // from the same list onboarding scores itself against, so the two cannot
  // disagree about what "credentials collected" means.
  const providerChecks = SYNCING_PROVIDERS.map((provider) =>
    providerReadiness(provider, rows, clientId, snapshot.observedAtMs));
  const renderCheck = (label: string, check: ReadinessCheck) => (
    <li key={label} className="text-xs text-muted-foreground">
      <span className="font-medium text-foreground">{label}:</span>{" "}
      <span className={check.state === "blocked" ? "font-medium text-destructive" : "font-medium text-amber-900"}>
        {check.state === "blocked" ? "Blocked" : "Unknown"}
      </span>{" "}— {check.reason}
    </li>
  );

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-muted-foreground">
          Meta and Instagram activation evidence is shown below. A stored integration or account ID
          does not establish provider access, scopes, or permission to publish.
        </p>
        <Button icon={Plus} onClick={() => setAddOpen(true)}>
          Add
        </Button>
      </div>

      {error?.clientId === clientId && (
        <p role="alert" className="mb-3 rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error.message}
        </p>
      )}

      <section aria-label="Provider access evidence" className="mb-4 rounded-lg border border-border bg-card p-4">
        <h3 className="text-sm font-semibold text-card-foreground">Provider access evidence</h3>
        <p className="mt-1 text-xs text-muted-foreground">
          Read-only metadata for this client, checked {new Date(snapshot.observedAtMs).toLocaleString()}.
          No provider account or scope readback is persisted yet, so this checklist cannot grant
          publication or ad rights. Every external action still requires exact-version Approval Inbox approval.
        </p>
        <div className="mt-3 grid gap-3 md:grid-cols-2">
          {providerChecks.map((check) => (
            <div key={check.provider} className="rounded-md border border-border p-3">
              <h4 className="text-xs font-semibold capitalize text-card-foreground">
                {check.provider} · {check.overall === "blocked" ? "Blocked" : "Unknown"}
              </h4>
              <ul className="mt-2 space-y-1">
                {renderCheck("Vault credential", check.credential)}
                {renderCheck("Recorded account", check.account)}
                {renderCheck("Required scopes", check.scopes)}
                {renderCheck("Action rights", check.action)}
                {renderCheck("Daily metrics sync", check.dailySync)}
              </ul>
            </div>
          ))}
        </div>
      </section>

      <DataTable
        columns={["Integration", "Credential", "Declared access", "Status", "Provider capability", "Daily sync", "Ads"]}
        emptyLabel="No integrations connected yet"
        rows={rows.map((r) => [
          <span key="p" className="capitalize">{r.provider}</span>,
          r.credential_label ?? "—",
          r.access_level ?? "—",
          <div key="s" className="space-y-1">
            <span
              className={cn(
                "inline-block rounded-full px-2 py-0.5 text-xs font-medium capitalize",
                ["error", "expired", "revoked"].includes(r.status)
                  ? "bg-destructive/10 text-destructive"
                  : r.status === "expiring"
                    ? "bg-amber-100 text-amber-900"
                    : "bg-muted text-foreground",
              )}
            >
              {r.status}
            </span>
            {/* metrics_ingest and token_health both write this timestamp. */}
            {dateLabel(r.last_checked_at) &&
              <span className="block text-xs text-muted-foreground">Last recorded integration activity {dateLabel(r.last_checked_at)}</span>}
            {dateLabel(r.token_expires_at) &&
              <span className="block text-xs text-muted-foreground">Recorded expiry {dateLabel(r.token_expires_at)}</span>}
          </div>,
          <span key="h" className="text-xs text-muted-foreground">
            {integrationCapabilitySummary(r.provider, r.status, r.token_expires_at)}
          </span>,
          SYNCS[r.provider] ? (
            <div key="t" className="flex items-center gap-2">
              <button
                type="button"
                role="switch"
                aria-checked={r.ingest_enabled}
                aria-label={`Daily sync for ${r.provider}`}
                disabled={saving?.clientId === clientId && saving.integrationId === r.id}
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
          pull a window by hand below.
        </p>
      )}

      {clientId && rows.some((r) => SYNCS[r.provider]) && <MetricsBackfill clientId={clientId} />}

      <FormModal
        open={currentAdSettings !== null}
        onClose={() => setAdSettings(null)}
        title="Meta ad settings"
        intro="What building ads in Meta needs beyond the credential. Ads are always built paused; launching happens in Ads Manager."
        fields={META_AD_FIELDS}
        initialValues={adSettingsValues}
        submitLabel="Save"
        onSubmit={async (v) => {
          if (!clientId || activeClient.current !== clientId || !currentAdSettings) {
            throw new Error("No current-client integration selected.");
          }
          const pageId = numericId(v.meta_page_id, "The page ID");
          if (!pageId) throw new Error("The page ID is required.");
          const { error } = await supabase
            .from("client_integrations")
            .update({ meta_page_id: pageId, meta_pixel_id: numericId(v.meta_pixel_id, "The pixel ID") })
            .eq("id", currentAdSettings.id)
            .eq("client_id", clientId);
          if (error) throw new Error(error.message);
        }}
        onSaved={refresh}
      />

      <FormModal
        open={addOpen}
        onClose={() => setAddOpen(false)}
        title="Add Integration"
        draftKey={clientId ? integrationDraftKey(clientId) : undefined}
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
