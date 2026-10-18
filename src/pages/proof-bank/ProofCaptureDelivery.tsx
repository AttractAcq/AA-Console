import { useCallback, useEffect, useState } from "react";
import { callRuntime } from "../../lib/callRuntime";
import { supabase } from "../../lib/supabase";
import { FormModal } from "../../components/forms/FormModal";
type Setup = {
  id: string;
  name: string;
  method: string;
  trigger_event: string | null;
};
type LinkRow = {
  id: string;
  config_id: string;
  expires_at: string;
  revoked_at: string | null;
  submissions: number;
  max_submissions: number;
};
type Delivery = {
  id: string;
  config_id: string;
  channel: string;
  recipient: string;
  message: string;
  scheduled_at: string;
  status: string;
  error: string | null;
  provider_id: string | null;
};
type Snapshot = {
  links: LinkRow[];
  deliveries: Delivery[];
  channels: string[];
};
const button =
  "rounded-md border border-border px-3 py-2 text-sm hover:bg-accent disabled:opacity-50";
export function ProofCaptureDelivery({
  clientId,
  setup,
}: {
  clientId: string;
  setup: Setup;
}) {
  const [data, setData] = useState<Snapshot>({
    links: [],
    deliveries: [],
    channels: [],
  });
  const [checkedAt, setCheckedAt] = useState(() => Date.now());
  const [url, setUrl] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [queue, setQueue] = useState(false);
  const refresh = useCallback(async () => {
    try {
      setData(
        await callRuntime<Snapshot>("/admin/proof-capture", {
          action: "list",
          clientId,
          configId: setup.id,
        }),
      );
      setCheckedAt(Date.now());
      setError("");
    } catch (e) {
      setError((e as Error).message);
    }
  }, [clientId, setup.id]);
  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), 15000);
    return () => clearInterval(timer);
  }, [refresh]);
  async function act(action: () => Promise<unknown>) {
    setBusy(true);
    setError("");
    try {
      await action();
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="mt-4 space-y-3 border-t border-border pt-3">
      {error && (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <button
          className={button}
          disabled={busy}
          onClick={() =>
            void act(async () => {
              const r = await callRuntime<{ url: string }>(
                "/admin/proof-capture",
                { action: "create_link", clientId, configId: setup.id },
              );
              setUrl(r.url);
            })
          }
        >
          Create capture link
        </button>
        {setup.method === "automated_requests" && (
          <button
            className={button}
            disabled={busy || !data.channels.length}
            onClick={() => setQueue(true)}
          >
            Prepare request
          </button>
        )}
      </div>
      {url && (
        <div className="space-y-2">
          <p className="text-sm">
            Copy this private link now. It expires in 14 days and accepts one
            submission.
          </p>
          <input
            aria-label="Capture link"
            className="w-full rounded border border-border bg-background p-2"
            readOnly
            value={url}
            onFocus={(e) => e.target.select()}
          />
          <button
            className={button}
            onClick={() => void act(() => navigator.clipboard.writeText(url))}
          >
            Copy link
          </button>
        </div>
      )}
      {setup.method === "automated_requests" && (
        <p className="text-sm text-muted-foreground">
          {data.channels.length
            ? `Available channels: ${data.channels.join(", ")}. Each prepared request needs human approval before sending.`
            : "Request delivery requires an email or messaging provider to be configured on the server. Capture links work independently."}
        </p>
      )}
      {data.links
        .filter((l) => l.config_id === setup.id)
        .map((l) => (
          <div key={l.id} className="flex flex-wrap items-center gap-3 text-sm">
            <span>
              {l.revoked_at
                ? "Revoked"
                : Date.parse(l.expires_at) < checkedAt
                  ? "Expired"
                  : `${l.submissions}/${l.max_submissions} submitted`}{" "}
              · Expires {new Date(l.expires_at).toLocaleDateString()}
            </span>
            {!l.revoked_at && l.submissions < l.max_submissions && (
              <button
                className={button}
                disabled={busy}
                onClick={() =>
                  void act(() =>
                    callRuntime("/admin/proof-capture", {
                      action: "revoke",
                      clientId,
                      linkId: l.id,
                    }),
                  )
                }
              >
                Revoke link
              </button>
            )}
          </div>
        ))}
      {data.deliveries
        .filter((d) => d.config_id === setup.id)
        .map((d) => (
          <article
            key={d.id}
            className="space-y-2 rounded border border-border p-3"
          >
            <p>
              {d.channel} · {d.recipient} ·{" "}
              {d.status === "sent"
                ? "Accepted by provider"
                : d.status.replaceAll("_", " ")}
            </p>
            <p className="text-sm">
              Scheduled: {new Date(d.scheduled_at).toLocaleString()}
            </p>
            <details>
              <summary>Review request message</summary>
              <p className="whitespace-pre-wrap break-words text-sm">
                {d.message}
              </p>
            </details>
            {d.error && <p role="alert">{d.error}</p>}
            {d.provider_id && (
              <p className="text-xs">Provider reference: {d.provider_id}</p>
            )}
            {["pending_approval", "approved", "failed"].includes(d.status) && (
              <div className="flex gap-2">
                {d.status !== "approved" && (
                  <button
                    className={button}
                    disabled={busy}
                    onClick={() => {
                      if (
                        window.confirm(
                          `Send this ${d.channel} request to ${d.recipient} at the scheduled time?`,
                        )
                      )
                        void act(async () => {
                          const r = await supabase.rpc(
                            "decide_proof_delivery",
                            { p_delivery_id: d.id, p_approve: true },
                          );
                          if (r.error) throw r.error;
                        });
                    }}
                  >
                    Approve send
                  </button>
                )}
                <button
                  className={button}
                  disabled={busy}
                  onClick={() =>
                    void act(async () => {
                      const r = await supabase.rpc("decide_proof_delivery", {
                        p_delivery_id: d.id,
                        p_approve: false,
                      });
                      if (r.error) throw r.error;
                    })
                  }
                >
                  Cancel request
                </button>
              </div>
            )}
          </article>
        ))}
      <FormModal
        open={queue}
        onClose={() => setQueue(false)}
        title="Prepare evidence request"
        submitLabel="Prepare for approval"
        fields={[
          {
            name: "channel",
            label: "Channel",
            kind: "select",
            required: true,
            options: data.channels.map((c) => ({ value: c, label: c })),
          },
          {
            name: "recipient",
            label: "Email or phone (+country code)",
            kind: "text",
            required: true,
          },
          { name: "customerName", label: "Customer name", kind: "text" },
          {
            name: "eventKey",
            label: "Unique service / event reference",
            kind: "text",
            required: true,
          },
          {
            name: "scheduledAt",
            label: "Send after (ISO date and time, optional)",
            kind: "text",
            hint: "Leave blank to send after approval. Example: 2026-10-20T09:00:00+02:00",
          },
        ]}
        initialValues={{ channel: data.channels[0] ?? "email" }}
        onSubmit={async (v) => {
          await callRuntime("/admin/proof-capture", {
            ...v,
            action: "queue_delivery",
            clientId,
            configId: setup.id,
            triggerEvent: setup.trigger_event,
          });
        }}
        onSaved={() => void refresh()}
      />
    </section>
  );
}
