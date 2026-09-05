import { useCallback, useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { Plus } from "lucide-react";
import { Button } from "../../components/Button";
import { DataTable } from "../../components/DataTable";
import { FormModal } from "../../components/forms/FormModal";
import type { FieldDef } from "../../components/forms/fields";
import { ACCESS_LEVEL_OPTIONS } from "../../lib/options";
import { supabase } from "../../lib/supabase";
import { cn } from "../../lib/cn";

type Integration = {
  id: string;
  provider: string;
  credential_label: string | null;
  access_level: string | null;
  status: string;
  ingest_enabled: boolean;
  last_checked_at: string | null;
};

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
  const { clientId } = useParams<{ clientId: string }>();
  const [rows, setRows] = useState<Integration[]>([]);
  const [saving, setSaving] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!clientId) return;
    const { data } = await supabase
      .from("client_integrations")
      .select("id, provider, credential_label, access_level, status, ingest_enabled, last_checked_at")
      .eq("client_id", clientId)
      .order("provider");
    setRows((data ?? []) as Integration[]);
  }, [clientId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

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

  return (
    <div>
      <div className="mb-4 flex justify-end">
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
        columns={["Integration", "Credential", "Access Level", "Status", "Daily sync"]}
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
