import { useCallback, useEffect, useState } from "react";
import { Plus } from "lucide-react";
import { AgentActivityBar } from "../../components/agents/AgentActivityBar";
import { Button } from "../../components/Button";
import { DataTable } from "../../components/DataTable";
import { EmptyState } from "../../components/EmptyState";
import { FormModal, clearDraft } from "../../components/forms/FormModal";
import { GenerateBriefDialog, type GeneratedBrief } from "../../components/forms/GenerateBriefDialog";
import type { FieldDef } from "../../components/forms/fields";
import { MediaCard, StatusBadge } from "../../components/MediaCard";
import { cn } from "../../lib/cn";
import { REVIEW_TONE, signPaths, type MediaAsset } from "../../lib/media";
import {
  RECRUITMENT_ROLES,
  RECRUITMENT_ROLE_LABEL,
  buildRecruitmentCopyPack,
  downloadRecruitmentCopyPack,
  type RecruitmentRole,
} from "../../lib/recruitment";
import { supabase } from "../../lib/supabase";
import { useAgentJobs } from "../../lib/useAgentJobs";

type Brief = {
  id: string;
  title: string;
  status: string;
  recruitment_role: RecruitmentRole | null;
  apply_url: string | null;
  compensation_text: string | null;
  hook: string | null;
  script: string | null;
  call_to_action: string | null;
  created_at: string;
};

const BRIEF_SELECT =
  "id, title, status, recruitment_role, apply_url, compensation_text, hook, script, call_to_action, created_at";

const STATUS_TONE: Record<string, string> = {
  draft: "bg-secondary text-secondary-foreground",
  approved: "bg-secondary text-secondary-foreground",
  in_production: "bg-primary/10 text-brand-strong",
  complete: "bg-primary/10 text-brand-strong",
  rejected: "bg-destructive/10 text-destructive",
};

function briefFields(role: RecruitmentRole): FieldDef[] {
  return [
    {
      name: "heading",
      label: `${RECRUITMENT_ROLE_LABEL[role]} · Meta static`,
      kind: "heading",
      hint: "Headline, primary text and CTA become the ad copy. Apply is a URL only — there is no in-app apply flow.",
    },
    { name: "title", label: "Title", kind: "text", required: true, placeholder: "Internal title for this brief" },
    { name: "hook", label: "Headline", kind: "text", required: true, placeholder: "The largest words on the ad" },
    { name: "script", label: "Primary text", kind: "textarea", required: true, rows: 4, placeholder: "What the role actually involves" },
    { name: "call_to_action", label: "Call to action", kind: "text", required: true, placeholder: "Apply now" },
    {
      name: "apply_url",
      label: "Apply URL",
      kind: "text",
      required: true,
      inputType: "text",
      placeholder: "https://",
      hint: "Candidates leave the ad through this link. Never generated — you fill this in.",
    },
    {
      name: "compensation_text",
      label: "Compensation on the ad",
      kind: "text",
      placeholder: "Optional — e.g. a day rate",
      hint: "Never generated: this is money AA is promising to pay.",
    },
    {
      name: "visual_direction",
      label: "Visual direction",
      kind: "textarea",
      rows: 3,
      placeholder: "What the still should show",
    },
    { name: "premise", label: "Premise", kind: "textarea", rows: 2, placeholder: "Who this ad is trying to attract, and why" },
  ];
}

export function RecruitmentPanel() {
  const [houseClientId, setHouseClientId] = useState<string | null>(null);
  const [brandReady, setBrandReady] = useState<boolean | null>(null);
  const [briefs, setBriefs] = useState<Brief[]>([]);
  const [pending, setPending] = useState<MediaAsset[]>([]);
  const [approved, setApproved] = useState<MediaAsset[]>([]);
  const [urls, setUrls] = useState<Map<string, string>>(new Map());
  const [concepts, setConcepts] = useState<Map<string, Record<string, unknown>>>(new Map());
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pickingRole, setPickingRole] = useState(false);
  const [draftRole, setDraftRole] = useState<RecruitmentRole | null>(null);
  const [generating, setGenerating] = useState(false);
  // The generated brief, and a nonce so re-generating re-seeds a form that is
  // already open — FormModal only reseeds when initialValues changes identity.
  const [aiDraft, setAiDraft] = useState<GeneratedBrief | null>(null);
  const [rejecting, setRejecting] = useState<MediaAsset | null>(null);
  const [reason, setReason] = useState("");

  const refresh = useCallback(async () => {
    setLoadError(null);
    try {
      const { data: houseId, error: houseError } = await supabase.rpc("aa_house_client_id");
      if (houseError) throw houseError;
      const clientId = (houseId as string | null) ?? null;
      setHouseClientId(clientId);
      if (!clientId) {
        setBriefs([]);
        setPending([]);
        setApproved([]);
        setLoading(false);
        return;
      }

      const [briefRes, pendingRes, approvedRes, brandRes] = await Promise.all([
        supabase
          .from("client_briefs")
          .select(BRIEF_SELECT)
          .eq("client_id", clientId)
          .eq("purpose", "recruitment")
          .order("created_at", { ascending: false }),
        supabase
          .from("client_media_assets")
          .select("id, client_id, brief_id, ref_number, media_type, title, storage_path, review_status, member_id, created_at")
          .eq("client_id", clientId)
          .eq("purpose", "recruitment")
          .eq("review_status", "pending")
          .order("created_at", { ascending: false }),
        supabase
          .from("client_media_assets")
          .select("id, client_id, brief_id, ref_number, media_type, title, storage_path, review_status, member_id, created_at")
          .eq("client_id", clientId)
          .eq("purpose", "recruitment")
          .eq("review_status", "approved")
          .order("created_at", { ascending: false }),
        supabase
          .from("client_brand_profiles")
          .select("colour_primary, imagery_style")
          .eq("client_id", clientId)
          .maybeSingle(),
      ]);
      if (briefRes.error) throw briefRes.error;
      if (pendingRes.error) throw pendingRes.error;
      if (approvedRes.error) throw approvedRes.error;
      if (brandRes.error) throw brandRes.error;

      const nextBriefs = (briefRes.data ?? []) as Brief[];
      const nextPending = (pendingRes.data ?? []) as MediaAsset[];
      const nextApproved = (approvedRes.data ?? []) as MediaAsset[];
      setBriefs(nextBriefs);
      setPending(nextPending);
      setApproved(nextApproved);
      const brand = brandRes.data as { colour_primary: string | null; imagery_style: string | null } | null;
      setBrandReady(Boolean(brand && (brand.colour_primary || brand.imagery_style)));

      const paths = [...nextPending, ...nextApproved].map((a) => a.storage_path);
      setUrls(await signPaths("client-media", paths));

      const briefIds = [...new Set([...nextPending, ...nextApproved].map((a) => a.brief_id).filter(Boolean))] as string[];
      if (briefIds.length > 0) {
        const { data: gens, error: genError } = await supabase
          .from("creative_generations")
          .select("brief_id, concept, created_at")
          .in("brief_id", briefIds)
          .order("created_at", { ascending: false });
        if (genError) throw genError;
        const map = new Map<string, Record<string, unknown>>();
        for (const row of gens ?? []) {
          const id = (row as { brief_id: string }).brief_id;
          if (map.has(id)) continue;
          const concept = (row as { concept: Record<string, unknown> | null }).concept;
          if (concept) map.set(id, concept);
        }
        setConcepts(map);
      } else {
        setConcepts(new Map());
      }
      setLoading(false);
    } catch (err) {
      setLoadError(
        "Failed to load recruitment: " +
          (err instanceof Error ? err.message : (err as { message?: string })?.message ?? "Unknown query error"),
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const { inFlight, recentFailures } = useAgentJobs(houseClientId ?? undefined, refresh);

  async function approveBrief(id: string) {
    setBusyId(id);
    setError(null);
    const { error: rpcError } = await supabase.rpc("approve_recruitment_brief", { p_brief_id: id });
    setBusyId(null);
    if (rpcError) {
      setError(rpcError.message);
      return;
    }
    setNotice("Brief approved. Generate the Meta static next.");
    void refresh();
  }

  async function generateAd(id: string) {
    setBusyId(id);
    setError(null);
    const { error: rpcError } = await supabase.rpc("generate_recruitment_ad", {
      p_brief_id: id,
      p_quality: "medium",
      p_size: "1024x1536",
    });
    setBusyId(null);
    if (rpcError) {
      setError(rpcError.message);
      return;
    }
    setNotice("Queued. The asset lands below for review — same creative_build path as client briefs.");
    void refresh();
  }

  async function review(asset: MediaAsset, decision: "approved" | "rejected", why?: string) {
    setBusyId(asset.id);
    setError(null);
    const { error: rpcError } = await supabase.rpc("review_media_asset", {
      p_asset_id: asset.id,
      p_decision: decision,
      p_reason: why?.trim() || undefined,
    });
    setBusyId(null);
    if (rpcError) {
      setError(rpcError.message);
      return;
    }
    void refresh();
  }

  function exportPack(asset: MediaAsset) {
    const brief = briefs.find((b) => b.id === asset.brief_id);
    try {
      const pack = buildRecruitmentCopyPack({
        role: brief?.recruitment_role ?? null,
        hook: brief?.hook ?? null,
        script: brief?.script ?? null,
        call_to_action: brief?.call_to_action ?? null,
        apply_url: brief?.apply_url ?? null,
        compensation_text: brief?.compensation_text ?? null,
        concept: asset.brief_id ? concepts.get(asset.brief_id) ?? null : null,
        asset: {
          id: asset.id,
          ref_number: asset.ref_number,
          storage_path: asset.storage_path,
        },
      });
      downloadRecruitmentCopyPack(pack);
      const imageUrl = urls.get(asset.storage_path);
      if (imageUrl) {
        const a = document.createElement("a");
        a.href = imageUrl;
        a.download = `${pack.role}-recruitment-ad.png`;
        a.rel = "noopener";
        a.target = "_blank";
        document.body.appendChild(a);
        a.click();
        a.remove();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not build the copy pack.");
    }
  }

  if (loadError) {
    return (
      <div role="alert">
        <p>{loadError}</p>
        <button type="button" onClick={() => void refresh()}>
          Retry
        </button>
      </div>
    );
  }

  return (
    <div>
      <AgentActivityBar inFlight={inFlight} failures={recentFailures} />

      <p className="mb-4 text-sm text-muted-foreground">
        Hiring ads for Attract Acquisition — Meta static only. Brand comes from Attract Acquisition
        Brand &amp; Design, not a hardcoded palette. Candidates apply through a URL; nothing is
        published to Distribution.
      </p>
      {brandReady === false && (
        <p className="mb-4 rounded-md bg-secondary px-3 py-2 text-sm text-secondary-foreground">
          No Brand &amp; Design profile is on file for Attract Acquisition. The next generate will
          invent a look. Set the house client&apos;s brand before you spend a render.
        </p>
      )}

      <div className="mb-4 flex justify-end">
        <Button icon={Plus} onClick={() => setPickingRole(true)}>
          New recruitment ad
        </Button>
      </div>

      {notice && (
        <p role="status" className="mb-4 text-sm text-brand-strong">
          {notice}
        </p>
      )}
      {error && (
        <p role="alert" className="mb-4 text-sm text-destructive">
          {error}
        </p>
      )}

      {loading ? (
        <p className="text-sm text-muted-foreground">Loading recruitment…</p>
      ) : briefs.length === 0 ? (
        <EmptyState label="No recruitment ads yet — pick a role to draft one" />
      ) : (
        <DataTable
          columns={["Role", "Brief", "Status", ""]}
          emptyLabel="No recruitment ads yet — pick a role to draft one"
          rows={briefs.map((b) => [
            <span key="r" className="capitalize">
              {b.recruitment_role ? RECRUITMENT_ROLE_LABEL[b.recruitment_role] : "—"}
            </span>,
            <span key="t">
              {b.title}
              {b.apply_url && <span className="block text-xs text-muted-foreground">{b.apply_url}</span>}
            </span>,
            <span
              key="s"
              className={cn(
                "inline-block rounded-full px-2 py-0.5 text-xs font-medium capitalize",
                STATUS_TONE[b.status] ?? "bg-muted text-muted-foreground",
              )}
            >
              {b.status.replace(/_/g, " ")}
            </span>,
            b.status === "draft" ? (
              <button
                key="a"
                type="button"
                disabled={busyId === b.id}
                onClick={() => void approveBrief(b.id)}
                className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
              >
                Approve brief
              </button>
            ) : b.status === "approved" ? (
              <button
                key="g"
                type="button"
                disabled={busyId === b.id}
                onClick={() => void generateAd(b.id)}
                className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
              >
                Generate Meta static
              </button>
            ) : (
              <span key="x" className="text-xs text-muted-foreground">
                {b.status === "in_production" ? "Generating…" : "Actioned"}
              </span>
            ),
          ])}
        />
      )}

      <h2 className="mb-3 mt-8 text-sm font-semibold text-foreground">Asset review</h2>
      {pending.length === 0 ? (
        <p className="mb-6 text-sm text-muted-foreground">Nothing waiting for review.</p>
      ) : (
        <div className="mb-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {pending.map((asset) => (
            <MediaCard
              key={asset.id}
              mediaType={asset.media_type}
              url={urls.get(asset.storage_path)}
              title={asset.title ?? "Untitled"}
              meta={`${asset.ref_number ?? "—"}`}
              badge={<StatusBadge status={asset.review_status} tone={REVIEW_TONE[asset.review_status]} />}
              actions={
                <>
                  <button
                    type="button"
                    disabled={busyId === asset.id}
                    onClick={() => void review(asset, "approved")}
                    className="flex-1 rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    Approve
                  </button>
                  <button
                    type="button"
                    disabled={busyId === asset.id}
                    onClick={() => {
                      setReason("");
                      setRejecting(asset);
                    }}
                    className="flex-1 rounded-md border border-border px-3 py-1.5 text-sm font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    Reject
                  </button>
                </>
              }
            />
          ))}
        </div>
      )}

      <h2 className="mb-3 text-sm font-semibold text-foreground">Export copy pack</h2>
      {approved.length === 0 ? (
        <p className="text-sm text-muted-foreground">Approved ads appear here for download.</p>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {approved.map((asset) => (
            <MediaCard
              key={asset.id}
              mediaType={asset.media_type}
              url={urls.get(asset.storage_path)}
              title={asset.title ?? "Untitled"}
              meta={`${asset.ref_number ?? "—"}`}
              badge={<StatusBadge status={asset.review_status} tone={REVIEW_TONE[asset.review_status]} />}
              actions={
                <button
                  type="button"
                  onClick={() => exportPack(asset)}
                  className="flex-1 rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  Download copy pack
                </button>
              }
            />
          ))}
        </div>
      )}

      {pickingRole && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <button
            type="button"
            aria-label="Close"
            className="absolute inset-0 bg-foreground/40"
            onClick={() => setPickingRole(false)}
          />
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="recruitment-role-title"
            className="relative w-full max-w-xl rounded-lg border border-border bg-card p-5 shadow-lg"
          >
            <h2 id="recruitment-role-title" className="text-base font-semibold text-card-foreground">
              Which role is this ad for?
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">Editor, SMM or Avatar — P0 stops there.</p>
            <div className="mt-4 grid gap-3 sm:grid-cols-3">
              {RECRUITMENT_ROLES.map((role) => (
                <button
                  key={role}
                  type="button"
                  onClick={() => {
                    setPickingRole(false);
                    setDraftRole(role);
                  }}
                  className="rounded-lg border border-border p-4 text-left text-sm font-medium text-card-foreground transition-colors hover:border-primary/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  {RECRUITMENT_ROLE_LABEL[role]}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      <FormModal
        open={draftRole !== null}
        onClose={() => {
          setDraftRole(null);
          setAiDraft(null);
        }}
        title={draftRole ? `Brief · ${RECRUITMENT_ROLE_LABEL[draftRole]}` : "Brief"}
        fields={draftRole ? briefFields(draftRole) : []}
        submitLabel="Save draft"
        draftKey={draftRole ? `recruitment-brief:${draftRole}` : undefined}
        actions={
          draftRole ? (
            <button
              type="button"
              onClick={() => setGenerating(true)}
              className="rounded-md border border-border px-3 py-2 text-sm font-medium text-card-foreground transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              Generate with AI
            </button>
          ) : undefined
        }
        initialValues={
          aiDraft
            ? { ...aiDraft, apply_url: "", compensation_text: "" }
            : undefined
        }
        onSubmit={async (v) => {
          if (!draftRole) return;
          const { error: rpcError } = await supabase.rpc("create_recruitment_brief", {
            p_role: draftRole,
            p_title: (v.title as string).trim(),
            p_hook: (v.hook as string).trim(),
            p_script: (v.script as string).trim(),
            p_call_to_action: (v.call_to_action as string).trim(),
            p_apply_url: (v.apply_url as string).trim(),
            p_visual_direction: ((v.visual_direction as string) || "").trim() || undefined,
            p_compensation_text: ((v.compensation_text as string) || "").trim() || undefined,
            p_premise: ((v.premise as string) || "").trim() || undefined,
          });
          if (rpcError) throw new Error(rpcError.message);
        }}
        onSaved={() => {
          setAiDraft(null);
          setNotice("Draft saved. Approve it when the brief is right.");
          void refresh();
        }}
      />

      {draftRole && (
        <GenerateBriefDialog
          open={generating}
          role={draftRole}
          roleLabel={RECRUITMENT_ROLE_LABEL[draftRole]}
          onClose={() => setGenerating(false)}
          onGenerated={(draft) => {
            // A saved draft wins over initialValues inside FormModal, so a
            // half-typed form would silently swallow what was just generated.
            clearDraft(`recruitment-brief:${draftRole}`);
            setAiDraft(draft);
          }}
        />
      )}

      {rejecting && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <button
            type="button"
            aria-label="Close"
            className="absolute inset-0 bg-foreground/40"
            onClick={() => setRejecting(null)}
          />
          <div
            role="dialog"
            aria-modal="true"
            className="relative w-full max-w-md rounded-lg border border-border bg-card p-5 shadow-lg"
          >
            <h2 className="text-base font-semibold text-card-foreground">Why is this being rejected?</h2>
            <textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={4}
              autoFocus
              className="mt-3 w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
            <div className="mt-3 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setRejecting(null)}
                className="rounded-md px-3 py-2 text-sm text-muted-foreground hover:bg-accent"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={!reason.trim() || busyId === rejecting.id}
                onClick={() => {
                  const asset = rejecting;
                  setRejecting(null);
                  void review(asset, "rejected", reason);
                }}
                className="rounded-md bg-destructive px-4 py-2 text-sm font-medium text-destructive-foreground disabled:opacity-50"
              >
                Confirm rejection
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
