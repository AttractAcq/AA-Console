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
  const [configs, setConfigs] = useState<Config[]>([]);
  const [pages, setPages] = useState<{ id: string; title: string }[]>([]);
  const [editing, setEditing] = useState<Partial<Config> | null>(null);
  const [upload, setUpload] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let active = true;
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
      setError(c.error?.message ?? p.error?.message ?? null);
      setConfigs(c.data ?? []);
      setPages(p.data ?? []);
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
  const placeholder =
    method.id === "integration" || method.id === "outcome_followup";
  return (
    <div className="space-y-4">
      <button type="button" className={button} onClick={() => choose()}>
        Back to capture
      </button>
      <h2 className="text-xl font-semibold">{method.label}</h2>
      {!placeholder && (
        <>
          <p className="text-sm text-muted-foreground">{method.description}</p>
          {error && (
            <p role="alert" className="text-destructive">
              {error}
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            <button
              className={button}
              onClick={() => setEditing({ method: method.id })}
            >
              {method.id === "guided_interview"
                ? "New interview script"
                : "New capture setup"}
            </button>
            {method.id === "manual_import" && (
              <button className={button} onClick={() => setUpload(true)}>
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
              ? "Save and edit the script here. Conduct the interview in person or in your meeting tool, then upload the evidence."
              : "Capture setups are saved drafts. Automated delivery and public submission endpoints are not enabled yet. A linked website page alone does not collect submissions."}
          </p>
          {configs
            .filter((c) => c.method === method.id)
            .map((c) => (
              <article
                key={c.id}
                className="rounded-lg border border-border p-4"
              >
                <div className="flex justify-between gap-3">
                  <h3 className="font-semibold">{c.name}</h3>
                  <button className={button} onClick={() => setEditing(c)}>
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
                    {pages.find((p) => p.id === c.page_id)?.title ??
                      "Unavailable"}
                  </p>
                )}
              </article>
            ))}
          <FormModal
            open={editing !== null}
            onClose={() => setEditing(null)}
            title={method.label}
            fields={[
              { name: "name", label: "Name", kind: "text", required: true },
              ...(method.id === "automated_requests"
                ? [
                    {
                      name: "trigger_event",
                      label: "Delivery event / trigger",
                      kind: "text" as const,
                      required: true,
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
                      options: pages.map((p) => ({
                        value: p.id,
                        label: p.title,
                      })),
                    },
                  ]
                : []),
            ]}
            initialValues={{
              name: editing?.name ?? "",
              instructions: editing?.instructions ?? "",
              trigger_event: editing?.trigger_event ?? "",
              message_template: editing?.message_template ?? "",
              page_id: editing?.page_id ?? "",
            }}
            onSubmit={async (v) => {
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
              const result = editing?.id
                ? await supabase
                    .from("proof_capture_configs")
                    .update(values)
                    .eq("id", editing.id)
                    .eq("client_id", clientId)
                : await supabase.from("proof_capture_configs").insert(values);
              if (result.error) throw result.error;
            }}
            onSaved={() => setRevision((n) => n + 1)}
          />
          <AddProofModal
            open={upload}
            onClose={() => setUpload(false)}
            clientId={clientId}
            classify
          />
        </>
      )}
    </div>
  );
}
