import { ProofCaptureDelivery } from "./ProofCaptureDelivery";
import { ProofIntegrationCapture } from "./ProofIntegrationCapture";
import { ProofOutcomeConsentPanel } from "./ProofOutcomeConsentPanel";
import { ProofServiceOutcomePanel } from "./ProofServiceOutcomePanel";
import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { supabase } from "../../lib/supabase";
import { CAPTURE_METHODS } from "../../lib/proofFactory";
import { FormModal } from "../../components/forms/FormModal";
import { AddProofModal } from "../../components/proof/AddProofModal";
import type { Database } from "../../types/database";

type Config = Database["public"]["Tables"]["proof_capture_configs"]["Row"];
const button =
  "rounded-md border border-border px-3 py-2 text-sm hover:bg-accent";
export function ProofCapturePanel({ clientId }: { clientId: string }) {
  const [params, setParams] = useSearchParams();
  const method = CAPTURE_METHODS.find((m) => m.id === params.get("capture"));
  const [snapshot, setSnapshot] = useState<{
    clientId: string; configs: Config[]; pages: { id: string; title: string }[];
    error: string | null; loading: boolean;
  }>({ clientId, configs: [], pages: [], error: null, loading: true });
  const current = snapshot.clientId === clientId ? snapshot
    : { clientId, configs: [] as Config[], pages: [] as { id: string; title: string }[],
      error: null, loading: true };
  const [editing, setEditing] = useState<{ clientId: string; config: Partial<Config> } | null>(null);
  const [uploadClient, setUploadClient] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let active = true;
    setSnapshot({ clientId, configs: [], pages: [], error: null, loading: true });
    void Promise.all([
      supabase
        .from("proof_capture_configs")
        .select("*")
        .eq("client_id", clientId)
        .order("created_at", { ascending: false }),
      supabase
        .from("client_pages")
        .select("id,title")
        .eq("client_id", clientId),
    ]).then(([c, p]) => {
      if (!active) return;
      setSnapshot({ clientId, configs: c.error ? [] : c.data ?? [],
        pages: p.error ? [] : p.data ?? [],
        error: c.error?.message ?? p.error?.message ?? null, loading: false });
    }).catch((cause) => {
      if (active) setSnapshot({ clientId, configs: [], pages: [],
        error: cause instanceof Error ? cause.message : "Capture setups could not be loaded.",
        loading: false });
    });
    return () => {
      active = false;
    };
  }, [clientId, revision]);
  const choose = (id?: string) => {
    const next = new URLSearchParams(params);
    if (id) next.set("capture", id);
    else next.delete("capture");
    setParams(next);
  };
  if (!method)
    return (
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {CAPTURE_METHODS.map((m) => (
          <button
            key={m.id}
            type="button"
            onClick={() => choose(m.id)}
            className="rounded-lg border border-border bg-card p-5 text-left hover:bg-accent"
          >
            <h2 className="font-semibold">{m.label}</h2>
            {m.description && (
              <p className="mt-2 text-sm text-muted-foreground">
                {m.description}
              </p>
            )}
          </button>
        ))}
      </div>
    );
  return (
    <div className="space-y-4">
      <button type="button" className={button} onClick={() => choose()}>
        Back to capture
      </button>
      <h2 className="text-xl font-semibold">{method.label}</h2>
      {method.id === "integration" && <ProofIntegrationCapture key={clientId} clientId={clientId} />}
      {method.id === "outcome_followup" && <>
        <ProofServiceOutcomePanel key={clientId} clientId={clientId} onChange={() => setRevision((n) => n + 1)} />
        <ProofOutcomeConsentPanel key={clientId} clientId={clientId} onChange={() => setRevision((n) => n + 1)} />
      </>}
      {method.id !== "integration" && (
        <>
          <p className="text-sm text-muted-foreground">{method.description}</p>
          {current.error && (
            <p role="alert" className="text-destructive">
              {current.error}
            </p>
          )}
          {current.loading && <p className="text-sm text-muted-foreground">Loading capture setups…</p>}
          <div className="flex flex-wrap gap-2">
            <button
              className={button}
              onClick={() => setEditing({ clientId, config: { method: method.id } })}
            >
              {method.id === "guided_interview"
                ? "New interview script"
                : "New capture setup"}
            </button>
            {method.id === "manual_import" && (
              <button className={button} onClick={() => setUploadClient(clientId)}>
                Upload proof
              </button>
            )}
            {(method.id === "manual_import" ||
              method.id === "field_capture") && (
              <Link
                className={button}
                to={`/clients/${clientId}/delivery/website-studio?view=v1`}
              >
                Build / manage pages
              </Link>
            )}
          </div>
          <p className="text-xs text-muted-foreground">
            {method.id === "guided_interview"
              ? "Save the questions here, then share a capture link for written answers, recordings and supporting evidence."
              : method.id === "outcome_followup"
                ? "Verify the service result and record specific customer consent above, then prepare a bound request. Every request needs exact Inbox approval before delivery."
              : "Create a private capture link for this setup. Submissions enter Raw for review and permission clearance. A website can link to the capture portal."}
          </p>
          <p className="text-xs text-muted-foreground">Editing a setup changes future links. Existing links keep the method and instructions recorded when they were created.</p>
          {current.configs
            .filter((c) => c.method === method.id)
            .map((c) => (
              <article
                key={c.id}
                className="rounded-lg border border-border p-4"
              >
                <div className="flex justify-between gap-3">
                  <h3 className="font-semibold">{c.name}</h3>
                  <button className={button} onClick={() => setEditing({ clientId, config: c })}>
                    Edit
                  </button>
                </div>
                {c.trigger_event && (
                  <p className="mt-2 text-sm">Trigger: {c.trigger_event}</p>
                )}
                <p className="mt-2 whitespace-pre-wrap text-sm">
                  {c.instructions}
                </p>
                {c.message_template && (
                  <p className="mt-2 whitespace-pre-wrap text-sm">
                    {c.message_template}
                  </p>
                )}
                {c.page_id && (
                  <p className="mt-2 text-sm">
                    Page:{" "}
                    {current.pages.find((p) => p.id === c.page_id)?.title ??
                      "Unavailable"}
                  </p>
                )}
                <ProofCaptureDelivery key={`${clientId}:${c.id}`} clientId={clientId} setup={c} />
              </article>
            ))}
          <FormModal
            open={editing?.clientId === clientId}
            onClose={() => setEditing(null)}
            title={method.label}
            fields={[
              { name: "name", label: "Name", kind: "text", required: true },
              ...(method.id === "automated_requests" || method.id === "outcome_followup"
                ? [
                    {
                      name: "trigger_event",
                      label: "Delivery event / trigger",
                      kind: method.id === "outcome_followup" ? "select" as const : "text" as const,
                      required: true,
                      ...(method.id === "outcome_followup" ? { options: [
                        { value: "service_completed", label: "Service completion verified" },
                      ] } : {}),
                    },
                    {
                      name: "message_template",
                      label: "Request message",
                      kind: "textarea" as const,
                      rows: 5,
                      required: true,
                    },
                  ]
                : []),
              {
                name: "instructions",
                label:
                  method.id === "guided_interview"
                    ? "Interview questions and structure"
                    : "Capture instructions and required evidence",
                kind: "textarea",
                rows: 10,
                required: true,
              },
              ...(method.id === "field_capture" || method.id === "manual_import"
                ? [
                    {
                      name: "page_id",
                      label: "Linked page",
                      kind: "select" as const,
                      options: current.pages.map((p) => ({
                        value: p.id,
                        label: p.title,
                      })),
                    },
                  ]
                : []),
            ]}
            initialValues={{
              name: editing?.clientId === clientId ? editing.config.name ?? "" : "",
              instructions: editing?.clientId === clientId ? editing.config.instructions ?? "" : "",
              trigger_event: editing?.clientId === clientId ? editing.config.trigger_event ?? "" : "",
              message_template: editing?.clientId === clientId ? editing.config.message_template ?? "" : "",
              page_id: editing?.clientId === clientId ? editing.config.page_id ?? "" : "",
            }}
            onSubmit={async (v) => {
              if (editing?.clientId !== clientId) throw new Error("Capture setup belongs to another client.");
              const values = {
                client_id: clientId,
                method: method.id,
                name: String(v.name).trim(),
                instructions: String(v.instructions).trim(),
                trigger_event: String(v.trigger_event ?? "").trim() || null,
                message_template:
                  String(v.message_template ?? "").trim() || null,
                page_id: String(v.page_id ?? "") || null,
              };
              const result = editing.config.id
                ? await supabase
                    .from("proof_capture_configs")
                    .update(values)
                    .eq("id", editing.config.id)
                    .eq("client_id", clientId)
                : await supabase.from("proof_capture_configs").insert(values);
              if (result.error) throw result.error;
            }}
            onSaved={() => setRevision((n) => n + 1)}
          />
          <AddProofModal
            open={uploadClient === clientId}
            onClose={() => setUploadClient(null)}
            clientId={clientId}
            classify
          />
        </>
      )}
    </div>
  );
}
