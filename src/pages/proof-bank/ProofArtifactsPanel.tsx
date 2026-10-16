import { type FormEvent, useCallback, useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { supabase } from "../../lib/supabase";
import { fetchProofAssets, type ProofAsset } from "../../lib/media";
import type { Database } from "../../types/database";
import { AgentActivityBar } from "../../components/agents/AgentActivityBar";
import { useAgentJobs } from "../../lib/useAgentJobs";

type Artifact = Database["public"]["Tables"]["proof_artifact_versions"]["Row"];
type Signoff = Database["public"]["Tables"]["proof_artifact_signoffs"]["Row"];

const kinds = [
  { id: "geo_answer", label: "GEO answer" },
  { id: "seo_case_study", label: "SEO case study" },
  { id: "local_proof_snippet", label: "Local proof snippet" },
] as const;
const blank = { sourceId: "", kind: "geo_answer", claim: "", excerpt: "", content: "" };

export function ProofArtifactsPanel() {
  const { clientId } = useParams<{ clientId: string }>();
  const [sources, setSources] = useState<ProofAsset[]>([]);
  const [artifacts, setArtifacts] = useState<Artifact[]>([]);
  const [signoffs, setSignoffs] = useState<Signoff[]>([]);
  const [form, setForm] = useState(blank);
  const [draftKey, setDraftKey] = useState(() => crypto.randomUUID());
  const [busy, setBusy] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!clientId) { setLoading(false); return; }
    setLoading(true);
    try {
      const [proof, artifactResult, signoffResult] = await Promise.all([
        fetchProofAssets(clientId),
        supabase.from("proof_artifact_versions").select("*").eq("client_id", clientId)
          .order("created_at", { ascending: false }),
        supabase.from("proof_artifact_signoffs").select("*").eq("client_id", clientId),
      ]);
      if (artifactResult.error || signoffResult.error) {
        throw artifactResult.error ?? signoffResult.error;
      }
      setSources(proof);
      setArtifacts(artifactResult.data ?? []);
      setSignoffs(signoffResult.data ?? []);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  }, [clientId]);

  useEffect(() => { void refresh(); }, [refresh]);
  const { inFlight, recentFailures } = useAgentJobs(clientId, refresh);

  function update(field: keyof typeof blank, value: string) {
    setForm((prior) => ({ ...prior, [field]: value }));
    setDraftKey(crypto.randomUUID());
  }

  function selectSource(source: ProofAsset) {
    setForm((prior) => ({ ...prior, sourceId: source.id,
      claim: source.claim ?? "", excerpt: source.evidence ?? source.body ?? "" }));
    setDraftKey(crypto.randomUUID());
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    if (!clientId || busy) return;
    setBusy("save"); setError(null);
    const { error: rpcError } = await supabase.rpc("create_proof_artifact_v6", {
      p_client_id: clientId,
      p_source_proof_id: form.sourceId,
      p_artifact_kind: form.kind,
      p_supported_claim: form.claim.trim(),
      p_evidence_excerpt: form.excerpt.trim(),
      p_content: form.content.trim(),
      p_idempotency_key: draftKey,
    });
    setBusy(null);
    if (rpcError) { setError(rpcError.message); return; }
    setForm(blank); setDraftKey(crypto.randomUUID());
    await refresh();
  }

  async function approve(artifact: Artifact) {
    setBusy(artifact.id); setError(null);
    const { error: rpcError } = await supabase.rpc("approve_proof_artifact_v6", {
      p_artifact_version_id: artifact.id,
    });
    setBusy(null);
    if (rpcError) { setError(rpcError.message); return; }
    await refresh();
  }

  async function generate() {
    if (!clientId || !form.sourceId || busy) return;
    setBusy("generate"); setError(null); setNotice(null);
    const { error: rpcError } = await supabase.rpc("request_proof_artifact_v6", {
      p_client_id: clientId,
      p_source_proof_id: form.sourceId,
      p_artifact_kind: form.kind,
    });
    setBusy(null);
    if (rpcError) { setError(rpcError.message); return; }
    setNotice("An AI draft is queued. It will appear here for human review when the job finishes.");
  }

  const chosen = sources.find((source) => source.id === form.sourceId);
  return <div className="space-y-6">
    <AgentActivityBar inFlight={inFlight} failures={recentFailures} />
    <div>
      <h2 className="text-xl font-semibold">Proof artifacts</h2>
      <p className="mt-1 text-sm text-muted-foreground">
        Turn a genuine source into a reviewable answer, case study or local snippet.
        Drafts keep the exact source text they used. A human clears the source and claim before approval.
        Publication is handled later by Proof Distribution.
      </p>
    </div>
    {error && <p role="alert" className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">{error}</p>}
    {notice && <p role="status" className="text-sm text-primary">{notice}</p>}
    <form onSubmit={(event) => void save(event)} className="space-y-4 rounded-xl border border-border bg-card p-5">
      <h3 className="font-semibold">Draft an artifact</h3>
      <div className="grid gap-4 sm:grid-cols-2">
        <label className="text-sm">Proof source
          <select required value={form.sourceId} onChange={(event) => {
            const source = sources.find((item) => item.id === event.target.value);
            if (source) selectSource(source); else update("sourceId", "");
          }} className="mt-1 w-full rounded-lg border border-border bg-background p-2">
            <option value="">Choose genuine proof</option>
            {sources.map((source) => <option key={source.id} value={source.id}>
              {source.title ?? source.ref_number ?? source.id} · {source.usage_rights}
            </option>)}
          </select>
        </label>
        <label className="text-sm">Artifact type
          <select value={form.kind} onChange={(event) => update("kind", event.target.value)}
            className="mt-1 w-full rounded-lg border border-border bg-background p-2">
            {kinds.map((kind) => <option key={kind.id} value={kind.id}>{kind.label}</option>)}
          </select>
        </label>
      </div>
      {chosen && <div className="rounded-lg bg-muted p-3 text-sm">
        <p className="font-medium">Source: {chosen.title ?? "Untitled proof"}</p>
        <p className="mt-1">{chosen.evidence ?? chosen.body ?? "No readable evidence"}</p>
        <p className="mt-1 text-xs text-muted-foreground">
          Rights: {chosen.usage_rights}{chosen.expires_on ? ` · expires ${chosen.expires_on}` : ""}
          {chosen.source ? ` · ${chosen.source}` : ""}
        </p>
        {chosen.permission_basis && <p className="mt-1 text-xs text-muted-foreground">Permission: {chosen.permission_basis}</p>}
      </div>}
      <label className="block text-sm">Supported claim
        <textarea required rows={2} maxLength={1000} value={form.claim}
          onChange={(event) => update("claim", event.target.value)}
          className="mt-1 w-full rounded-lg border border-border bg-background p-2" />
      </label>
      <label className="block text-sm">Verbatim evidence excerpt
        <textarea required rows={2} maxLength={2000} value={form.excerpt}
          onChange={(event) => update("excerpt", event.target.value)}
          className="mt-1 w-full rounded-lg border border-border bg-background p-2" />
        <span className="text-xs text-muted-foreground">Copy exact words from the source. The server checks they are present.</span>
      </label>
      <label className="block text-sm">Artifact draft
        <textarea required rows={8} maxLength={12000} value={form.content}
          onChange={(event) => update("content", event.target.value)}
          className="mt-1 w-full rounded-lg border border-border bg-background p-2" />
      </label>
      <div className="flex flex-wrap gap-2">
        <button type="button" disabled={Boolean(busy) || !chosen} onClick={() => void generate()}
          className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50">
          Generate AI draft
        </button>
        <button type="submit" disabled={Boolean(busy) || !chosen}
          className="rounded-lg border border-border px-4 py-2 text-sm font-medium disabled:opacity-50">
          Save manual draft
        </button>
      </div>
    </form>
    <section className="space-y-3">
      <h3 className="font-semibold">Versions awaiting use</h3>
      {loading ? <p className="text-sm text-muted-foreground">Loading artifacts…</p>
        : artifacts.length === 0 ? <p className="text-sm text-muted-foreground">No proof artifacts have been drafted yet.</p>
          : artifacts.map((artifact) => {
            const source = sources.find((item) => item.id === artifact.source_proof_id);
            const approved = signoffs.some((item) => item.artifact_version_id === artifact.id);
            return <article key={artifact.id} className="rounded-xl border border-border bg-card p-5">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div>
                  <h4 className="font-semibold">{kinds.find((kind) => kind.id === artifact.artifact_kind)?.label ?? artifact.artifact_kind} · v{artifact.version}</h4>
                  <p className="text-xs text-muted-foreground">{source?.title ?? artifact.source_proof_id} · {approved ? "Approved" : "Draft"}</p>
                </div>
                <span className="font-mono text-xs text-muted-foreground">{artifact.content_hash.slice(0, 16)}…</span>
              </div>
              <p className="mt-3 text-sm font-medium">Claim: {artifact.supported_claim}</p>
              <p className="mt-2 text-sm text-muted-foreground">Evidence: “{artifact.evidence_excerpt}”</p>
              <p className="mt-3 whitespace-pre-wrap text-sm">{artifact.content}</p>
              <div className="mt-4 flex gap-2">
                {!approved && <button type="button" disabled={Boolean(busy)} onClick={() => void approve(artifact)}
                  className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50">
                  Approve source and claim
                </button>}
                <button type="button" onClick={() => {
                  setForm({ sourceId: artifact.source_proof_id, kind: artifact.artifact_kind,
                    claim: artifact.supported_claim, excerpt: artifact.evidence_excerpt, content: artifact.content });
                  setDraftKey(crypto.randomUUID());
                  window.scrollTo({ top: 0, behavior: "smooth" });
                }} className="rounded-lg border border-border px-4 py-2 text-sm">Create revision</button>
              </div>
            </article>;
          })}
    </section>
  </div>;
}
