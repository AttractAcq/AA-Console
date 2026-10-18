import { useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { supabase } from "../../lib/supabase";
import {
  signPaths,
  fetchTextBodies,
  type ProofAsset,
  type MediaAsset,
} from "../../lib/media";
import {
  PROOF_DESTINATIONS,
  PROOF_CATEGORIES,
  categoryLabel,
} from "../../lib/proofFactory";
import { CONTENT_FORMATS, formatAllows } from "../../lib/contentFormat";
import { FormModal } from "../../components/forms/FormModal";
import { AddProofModal } from "../../components/proof/AddProofModal";
import { ProofDetailModal } from "../../components/proof/ProofDetailModal";
import { MediaDetailModal } from "../../components/MediaDetailModal";
import { ApproveAndBuildModal } from "../../components/briefs/ApproveAndBuildModal";
import { BriefDetailModal } from "../../components/briefs/BriefDetailModal";
import { AgentActivityBar } from "../../components/agents/AgentActivityBar";
import { useAgentJobs } from "../../lib/useAgentJobs";
import { ProofCapturePanel } from "./ProofCapturePanel";
import { ProofArtifactsPanel } from "./ProofArtifactsPanel";
import type { Database } from "../../types/database";

type Raw = Database["public"]["Tables"]["client_proof_assets"]["Row"];
type Brief = Database["public"]["Tables"]["client_briefs"]["Row"];
type Request = Database["public"]["Tables"]["proof_production_requests"]["Row"];
type Job = { id: string; status: string; error: string | null };
const button =
  "rounded-md border border-border px-3 py-2 text-sm hover:bg-accent disabled:opacity-50";
const primary =
  "rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground";
export function ProofFactoryV2Panel({ tab }: { tab: string }) {
  const { clientId } = useParams<{ clientId: string }>();
  if (!clientId) return <p>Select a client.</p>;
  return tab === "capture" ? (
    <ProofCapturePanel key={clientId} clientId={clientId} />
  ) : (
    <ProofProductionWorkspace
      key={`${clientId}:${tab}`}
      clientId={clientId}
      tab={tab}
    />
  );
}
function ProofProductionWorkspace({
  clientId,
  tab,
}: {
  clientId: string;
  tab: string;
}) {
  const [raw, setRaw] = useState<Raw[]>([]);
  const [briefs, setBriefs] = useState<Brief[]>([]);
  const [assets, setAssets] = useState<MediaAsset[]>([]);
  const [requests, setRequests] = useState<Request[]>([]);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [urls, setUrls] = useState<Map<string, string>>(new Map());
  const [textBodies, setTextBodies] = useState<Map<string, string>>(new Map());
  const [rawUrls, setRawUrls] = useState<Map<string, string>>(new Map());
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState(false);
  const [upload, setUpload] = useState(false);
  const [requestId, setRequestId] = useState(() => crypto.randomUUID());
  const [notice, setNotice] = useState<string | null>(null);
  const [rawOpen, setRawOpen] = useState<Raw | null>(null);
  const [assetOpen, setAssetOpen] = useState<MediaAsset | null>(null);
  const [building, setBuilding] = useState<Brief | null>(null);
  const [viewBrief, setViewBrief] = useState<Brief | null>(null);
  const [library, setLibrary] = useState("raw");
  const [media, setMedia] = useState("");
  const [format, setFormat] = useState("");
  const [category, setCategory] = useState("");
  const [artifacts, setArtifacts] = useState(false);
  const refresh = useCallback(async () => {
    try {
      const [r, b, q] = await Promise.all([
        supabase
          .from("client_proof_assets")
          .select("*")
          .eq("client_id", clientId)
          .order("created_at", { ascending: false }),
        supabase
          .from("client_briefs")
          .select("*")
          .eq("client_id", clientId)
          .not("proof_asset_id", "is", null)
          .order("created_at", { ascending: false }),
        supabase
          .from("proof_production_requests")
          .select("*")
          .eq("client_id", clientId)
          .order("created_at", { ascending: false }),
      ]);
      if (r.error || b.error || q.error) throw r.error ?? b.error ?? q.error;
      const bs = b.data ?? [],
        qs = q.data ?? [];
      const [a, j] = await Promise.all([
        bs.length
          ? supabase
              .from("client_media_assets")
              .select("*")
              .eq("client_id", clientId)
              .in(
                "brief_id",
                bs.map((x) => x.id),
              )
              .order("created_at", { ascending: false })
          : Promise.resolve({ data: [], error: null }),
        qs.some((x) => x.job_id)
          ? supabase
              .from("agent_jobs")
              .select("id,status,error")
              .eq("client_id", clientId)
              .in(
                "id",
                qs.flatMap((x) => (x.job_id ? [x.job_id] : [])),
              )
          : Promise.resolve({ data: [], error: null }),
      ]);
      if (a.error || j.error) throw a.error ?? j.error;
      const rows = (a.data ?? []) as MediaAsset[];
      const [signed, proofSigned] = await Promise.all([
        signPaths(
          "client-media",
          rows.map((x) => x.render_path || x.storage_path),
        ),
        signPaths(
          "proof",
          (r.data ?? []).flatMap((x) =>
            x.storage_path ? [x.storage_path] : [],
          ),
        ),
      ]);
      setRaw(r.data ?? []);
      setBriefs(bs);
      setRequests(qs);
      setJobs(j.data ?? []);
      setAssets(rows);
      setUrls(signed);
      setRawUrls(proofSigned);
      setTextBodies(
        await fetchTextBodies(
          rows.filter((x) => x.media_type === "text"),
          signed,
        ),
      );
      setError(null);
    } catch (e) {
      setError((e as Error).message ?? "Could not load proof production.");
    } finally {
      setLoading(false);
    }
  }, [clientId]);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  const { inFlight, recentFailures } = useAgentJobs(
    clientId,
    () => void refresh(),
  );
  const byBrief = new Map(briefs.map((b) => [b.id, b]));
  const derived = (a: MediaAsset) =>
    Boolean(a.brief_id && byBrief.get(a.brief_id)?.derived_from_asset_id);
  const eligible = assets.filter((a) => a.review_status === "approved");
  const filtered = assets.filter(
    (a) =>
      (!media || a.media_type === media) &&
      (!format || (a.content_format ?? "single") === format) &&
      (tab === "assets" || (tab === "repurpose" ? derived(a) : !derived(a))),
  );
  const pending = requests.filter((r) =>
    tab === "repurpose" ? Boolean(r.source_asset_id) : !r.source_asset_id,
  );
  const preview = (a: MediaAsset) => (
    <button className={button} onClick={() => setAssetOpen(a)}>
      Preview
    </button>
  );
  const repurpose = tab === "repurpose";
  return (
    <div className="space-y-4">
      <AgentActivityBar inFlight={inFlight} failures={recentFailures} />
      {error && (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      )}
      {notice && <p role="status">{notice}</p>}
      <div className="flex flex-wrap justify-end gap-2">
        <button className={button} onClick={() => void refresh()}>
          Refresh
        </button>
        {tab !== "assets" && (
          <button
            className={primary}
            onClick={() => {
              setRequestId(crypto.randomUUID());
              setForm(true);
            }}
          >
            {repurpose ? "Repurpose" : "Produce"}
          </button>
        )}
        {tab === "assets" && (
          <button className={button} onClick={() => setUpload(true)}>
            Add raw proof
          </button>
        )}
        <button className={button} onClick={() => setArtifacts(!artifacts)}>
          SEO / GEO artifacts
        </button>
      </div>
      {artifacts && <ProofArtifactsPanel />}
      {tab !== "assets" && (
        <p className="text-sm text-muted-foreground">
          {repurpose
            ? "Choose an approved produced asset and a new output format."
            : "Choose cleared raw evidence and an output format."}{" "}
          The brief and AI production run automatically from your instructions.
          Finished outputs appear in this table and in Assets → Produced.
        </p>
      )}
      {tab === "assets" && (
        <div className="flex gap-2" aria-label="Asset library">
          {["raw", "produced"].map((id) => (
            <button
              key={id}
              className={library === id ? primary : button}
              aria-pressed={library === id}
              onClick={() => setLibrary(id)}
            >
              {categoryLabel(id)}
            </button>
          ))}
        </div>
      )}
      <div className="flex flex-wrap gap-3">
        <label className="text-sm">
          Media{" "}
          <select
            value={media}
            onChange={(e) => setMedia(e.target.value)}
            className={button}
          >
            <option value="">All media</option>
            {["image", "text", "video"].map((m) => (
              <option key={m} value={m}>
                {categoryLabel(m)}
              </option>
            ))}
          </select>
        </label>
        {tab === "assets" && library === "raw" && (
          <label className="text-sm">
            Category{" "}
            <select
              className={button}
              value={category}
              onChange={(e) => setCategory(e.target.value)}
            >
              <option value="">All categories</option>
              {Object.keys(PROOF_CATEGORIES).map((c) => (
                <option key={c} value={c}>
                  {categoryLabel(c)}
                </option>
              ))}
            </select>
          </label>
        )}
        <label className="text-sm">
          Format{" "}
          <select
            className={button}
            value={format}
            onChange={(e) => setFormat(e.target.value)}
          >
            <option value="">All formats</option>
            {CONTENT_FORMATS.map((f) => (
              <option key={f.value} value={f.value}>
                {f.label}
              </option>
            ))}
          </select>
        </label>
      </div>
      {loading ? (
        <p>Loading proof…</p>
      ) : tab === "assets" && library === "raw" ? (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead>
              <tr>
                {[
                  "Asset name",
                  "Proof type",
                  "Media",
                  "Date",
                  "Rights",
                  "Preview",
                ].map((h) => (
                  <th className="p-3" key={h}>
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {raw
                .filter(
                  (p) =>
                    (!media || p.media_type === media) &&
                    (!category || p.source_category === category) &&
                    (!format || p.source_format === format),
                )
                .map((p) => (
                  <tr key={p.id} className="border-t border-border">
                    <td className="p-3">{p.title ?? p.ref_number}</td>
                    <td className="p-3">{p.source_kind ?? "Not classified"}</td>
                    <td className="p-3">{p.media_type}</td>
                    <td className="p-3">
                      {new Date(p.created_at).toLocaleDateString()}
                    </td>
                    <td className="p-3">{p.usage_rights}</td>
                    <td className="p-3">
                      <button className={button} onClick={() => setRawOpen(p)}>
                        Preview / manage
                      </button>
                      {p.storage_path && rawUrls.get(p.storage_path) && (
                        <a
                          className="ml-2 underline"
                          target="_blank"
                          rel="noreferrer"
                          href={rawUrls.get(p.storage_path)}
                        >
                          Open file
                        </a>
                      )}
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
          {raw.length === 0 && <p className="p-4">No raw proof yet.</p>}
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead>
              <tr>
                {[
                  "Asset name",
                  repurpose ? "Date repurposed" : "Date produced",
                  "Format",
                  "Status",
                  "Preview",
                ].map((h) => (
                  <th key={h} className="p-3">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filtered.map((a) => (
                <tr key={a.id} className="border-t border-border">
                  <td className="p-3">
                    {a.title ?? a.ref_number}
                    <span className="block text-xs text-muted-foreground">
                      {raw.find(
                        (p) =>
                          p.id ===
                          byBrief.get(a.brief_id ?? "")?.proof_asset_id,
                      )?.title ?? "Linked proof"}
                    </span>
                  </td>
                  <td className="p-3">
                    {new Date(a.created_at).toLocaleDateString()}
                  </td>
                  <td className="p-3">
                    {a.media_type} · {a.content_format ?? "single"}
                  </td>
                  <td className="p-3">{a.review_status}</td>
                  <td className="p-3">
                    {preview(a)}
                    {a.media_type === "video" && (
                      <Link
                        className="ml-2 underline"
                        to={`/clients/${clientId}/delivery/content-production-factory?view=v2&tab=edit&brief=${a.brief_id ?? ""}`}
                      >
                        Edit video
                      </Link>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {filtered.length === 0 && (
            <p className="p-4">No produced assets match these filters.</p>
          )}
        </div>
      )}
      {tab !== "assets" && pending.length > 0 && (
        <section className="space-y-2">
          <h3 className="font-semibold">Production requests</h3>
          {pending.map((r) => {
            const b = briefs.find((x) => x.source_idea_id === r.idea_id);
            const j = jobs.find((x) => x.id === r.job_id);
            return (
              <div
                key={r.id}
                className="flex flex-wrap items-center gap-3 rounded-lg border border-border p-3"
              >
                <span>
                  {raw.find((p) => p.id === r.source_proof_id)?.title ??
                    "Proof"}{" "}
                  · {r.destination}
                </span>
                <span className="text-sm text-muted-foreground">
                  {r.auto_produce
                    ? r.production_status
                    : b
                      ? b.status
                      : (j?.status ?? "Queued")}
                </span>
                {(r.production_error || j?.error) && (
                  <p role="alert" className="text-sm text-destructive">
                    {r.production_error || j?.error}
                  </p>
                )}
                {b && (
                  <>
                    <button className={button} onClick={() => setViewBrief(b)}>
                      Brief
                    </button>
                    <button
                      disabled={
                        r.auto_produce &&
                        !["failed", "needs_attention"].includes(
                          r.production_status,
                        )
                      }
                      className={button}
                      onClick={() => setBuilding(b)}
                    >
                      Create
                    </button>
                  </>
                )}
              </div>
            );
          })}
        </section>
      )}
      <FormModal
        open={form}
        onClose={() => setForm(false)}
        title={repurpose ? "Repurpose proof" : "Produce proof"}
        submitLabel="Start production"
        fields={[
          {
            name: "production_mode",
            label: "Production",
            kind: "select",
            required: true,
            options: [
              { value: "ai", label: "AI — brief and produce automatically" },
              {
                value: "human",
                label: "Human — prepare brief for Create handoff",
              },
            ],
          },
          {
            name: "source",
            label: repurpose ? "Produced asset" : "Raw proof",
            kind: "select",
            required: true,
            options: repurpose
              ? eligible.map((a) => ({
                  value: a.id,
                  label: a.title ?? a.ref_number ?? a.id,
                }))
              : raw.map((p) => ({
                  value: p.id,
                  label: `${p.title ?? p.ref_number} · ${p.usage_rights}`,
                })),
          },
          {
            name: "media_type",
            label: "Output media",
            kind: "select",
            required: true,
            options: ["image", "text", "video"].map((value) => ({
              value,
              label: categoryLabel(value),
            })),
          },
          {
            name: "content_format",
            label: "Output format",
            kind: "select",
            required: true,
            options: CONTENT_FORMATS.map((f) => ({
              value: f.value,
              label: f.label,
            })),
          },
          {
            name: "destination",
            label: "Intended destination",
            kind: "select",
            required: true,
            options: PROOF_DESTINATIONS.map((value) => ({
              value,
              label: value,
            })),
          },
          {
            name: "quality",
            label: "Image quality",
            kind: "select",
            required: true,
            options: ["low", "medium", "high"].map((value) => ({
              value,
              label: categoryLabel(value),
            })),
          },
          {
            name: "size",
            label: "Image size (stories use portrait)",
            kind: "select",
            required: true,
            options: [
              { value: "1024x1536", label: "Portrait" },
              { value: "1024x1024", label: "Square" },
              { value: "1536x1024", label: "Landscape" },
            ],
          },
          {
            name: "direction",
            label: "Production instructions",
            kind: "textarea",
            rows: 6,
            required: true,
            hint: "Specify the supported message, audience, tone, CTA and any visual requirements. Evidence and quotations must remain genuine.",
          },
          {
            name: "video_direction",
            label: "Video and editing direction",
            kind: "textarea",
            rows: 4,
            showIf: { field: "media_type", equals: ["video"] },
            hint: "Describe captions, voiceover, motion graphics, pacing and crop. Available editing controls are configured on the video editing step.",
          },
          {
            name: "frames",
            label: "Frame-by-frame direction",
            kind: "textarea",
            rows: 4,
            showIf: { field: "content_format", equals: ["carousel", "story"] },
          },
        ]}
        initialValues={{
          production_mode: "ai",
          quality: "high",
          size: "1024x1536",
          media_type: "image",
          content_format: "single",
          destination: "Organic Social Media",
        }}
        onSubmit={async (v) => {
          const mt = v.media_type as "image" | "text" | "video",
            f = v.content_format as "single" | "carousel" | "story" | "reel";
          if (!formatAllows(f, mt))
            throw new Error("Choose a compatible media type and format.");
          const source = repurpose
            ? eligible.find((a) => a.id === v.source)
            : null;
          const proofId = repurpose
            ? byBrief.get(source?.brief_id ?? "")?.proof_asset_id
            : String(v.source);
          if (!proofId)
            throw new Error("The selected asset has no proof source.");
          const { error: err } = await supabase.rpc(
            v.production_mode === "human"
              ? "request_proof_production_v2"
              : "request_proof_auto_production",
            {
              p_request_id: requestId,
              ...(v.production_mode === "human"
                ? {}
                : {
                    p_quality: String(v.quality),
                    p_size: f === "story" ? "1024x1536" : String(v.size),
                  }),
              p_client_id: clientId,
              p_source_proof_id: proofId,
              p_source_asset_id: source?.id ?? null,
              p_media_type: mt,
              p_format: f,
              p_destination: String(v.destination),
              p_direction: [
                v.direction,
                mt === "video" ? v.video_direction : null,
                ["carousel", "story"].includes(f) ? v.frames : null,
              ]
                .filter(Boolean)
                .join("\n\n"),
            },
          );
          if (err) throw err;
          setNotice(
            v.production_mode === "human"
              ? "Brief queued. Use Create when it is ready to assign human production."
              : "Production queued. The brief and AI build will run automatically; outputs still require review.",
          );
        }}
        onSaved={() => {
          void refresh();
        }}
      />
      <AddProofModal
        open={upload}
        onClose={() => setUpload(false)}
        clientId={clientId}
        onSaved={() => void refresh()}
        classify
      />
      <ProofDetailModal
        proof={rawOpen as ProofAsset | null}
        open={rawOpen !== null}
        onClose={() => setRawOpen(null)}
        onSaved={() => {
          setRawOpen(null);
          void refresh();
        }}
      />
      <MediaDetailModal
        asset={assetOpen}
        open={assetOpen !== null}
        url={
          assetOpen
            ? urls.get(assetOpen.render_path || assetOpen.storage_path)
            : undefined
        }
        body={assetOpen ? textBodies.get(assetOpen.id) : undefined}
        onClose={() => setAssetOpen(null)}
      />
      <BriefDetailModal
        brief={viewBrief}
        open={viewBrief !== null}
        onClose={() => setViewBrief(null)}
      />
      <ApproveAndBuildModal
        brief={building}
        open={building !== null}
        onClose={() => setBuilding(null)}
        onDone={() => {
          setBuilding(null);
          void refresh();
        }}
      />
    </div>
  );
}
