import { useCallback, useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { CheckSquare, FolderCheck, Send, Plus } from "lucide-react";
import { ConsoleShell } from "../../components/ConsoleShell";
import { Button } from "../../components/Button";
import { Panel } from "../../components/Panel";
import { EmptyState } from "../../components/EmptyState";
import { ClientAccountView } from "./ClientAccountView";
import { DataTable } from "../../components/DataTable";
import { ChatView } from "../../components/chat/ChatView";
import { AddProofModal } from "../../components/proof/AddProofModal";
import { ActiveCampaignsView, ActiveOrganicView, ActiveConversionView } from "./ClientViews";
import { findConsolePage } from "../../config/consoleNav";
import { useAuth } from "../../context/auth";
import { fetchClientAssets, shortDate, signPaths } from "../../lib/media";
import type { MediaAsset } from "../../lib/media";
import { supabase } from "../../lib/supabase";
import { VideoApprovalRoute } from "../../components/VideoApprovalRoute";

type ClientRow = { id: string; name: string; sector: string | null; tier: string | null };
type ContextRow = { business_overview: string | null; main_offer: string | null };

export function ClientConsolePage() {
  const { profile } = useAuth();
  const { page: pageId } = useParams<{ page: string }>();
  const clientId = profile?.client_id ?? null;
  const page = findConsolePage("client", pageId);

  const [client, setClient] = useState<ClientRow | null>(null);
  const [context, setContext] = useState<ContextRow | null>(null);
  const [pending, setPending] = useState<MediaAsset[]>([]);
  const [videoUrls, setVideoUrls] = useState<ReadonlyMap<string, string>>(new Map());
  const [counts, setCounts] = useState({ distributed: 0, proof: 0 });
  const [proofOpen, setProofOpen] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [loadError, setLoadError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoadError(null);
    try {
    if (!clientId) return;
    const [c, ctx, distributed, proof, waiting, botApproved] = await Promise.all([
      supabase.from("clients").select("id, name, sector, tier").eq("id", clientId).maybeSingle(),
      supabase
        .from("client_business_context")
        .select("business_overview, main_offer")
        .eq("client_id", clientId)
        .maybeSingle(),
      // Distributed means actually scheduled out, not merely delivered.
      supabase
        .from("scheduled_posts")
        .select("id", { count: "exact", head: true })
        .eq("client_id", clientId),
      supabase
        .from("client_proof_assets")
        .select("id", { count: "exact", head: true })
        .eq("client_id", clientId),
      fetchClientAssets(clientId, { reviewStatus: "pending" }),
      fetchClientAssets(clientId, { mediaType: "video", reviewStatus: "approved", humanApproved: false }),
    ]);
    const failure = c.error ?? ctx.error ?? distributed.error ?? proof.error;
    if (failure) throw failure;
    setClient(c.data as ClientRow | null);
    setContext(ctx.data as ContextRow | null);
    setCounts({ distributed: distributed.count ?? 0, proof: proof.count ?? 0 });
    const ready = [...waiting, ...botApproved]
      .filter((asset) => !asset.edit_stage || asset.edit_stage === "review_ready");
    const video = ready.filter((asset) => asset.media_type === "video");
    const states = await Promise.all(video.map((asset) =>
      supabase.rpc("video_approval_state", { p_asset_id: asset.id })));
    const requested = new Set(video.filter((_, index) =>
      !states[index].error && (states[index].data as { client_user_id?: string } | null)?.client_user_id === profile?.id)
      .map((asset) => asset.id));
    const visible = ready.filter((asset) => asset.media_type !== "video" || requested.has(asset.id));
    setPending(visible);
    setVideoUrls(await signPaths("client-media", video.filter((asset) => requested.has(asset.id))
      .map((asset) => asset.render_path ?? asset.storage_path)));
    } catch (error) {
      setLoadError("Failed to load client overview: " + (error instanceof Error ? error.message : (error as { message?: string })?.message ?? "Unknown query error"));
    }
  }, [clientId, profile?.id]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function approve(asset: MediaAsset) {
    setBusyId(asset.id);
    setError(null);
    const { error: rpcError } = await supabase.rpc("review_media_asset", {
      p_asset_id: asset.id,
      p_decision: "approved",
      p_reason: undefined,
    });
    setBusyId(null);
    if (rpcError) {
      setError(rpcError.message);
      return;
    }
    void refresh();
  }

  const stats = [
    { id: "distributed", label: "Media distributed", value: counts.distributed, icon: Send },
    { id: "pending", label: "Awaiting your approval", value: pending.length, icon: CheckSquare },
    { id: "proof", label: "Proof on file", value: counts.proof, icon: FolderCheck },
  ];

  function dashboard() {
    return (
      <div className="space-y-6">
        <div className="grid gap-4 sm:grid-cols-3">
          {stats.map(({ id, label, value, icon: Icon }) => (
            <div key={id} className="rounded-lg border border-border bg-card p-5">
              <div className="mb-2 flex items-center justify-between">
                <span className="text-sm text-muted-foreground">{label}</span>
                <Icon className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
              </div>
              <span className="text-2xl font-semibold text-card-foreground">{value}</span>
            </div>
          ))}
        </div>

        <Panel
          title="Awaiting your approval"
          action={
            error ? (
              <span role="alert" className="text-sm text-destructive">
                {error}
              </span>
            ) : undefined
          }
        >
          <DataTable
            columns={["Asset", "Ref", "Type", "Delivered", ""]}
            emptyLabel="Nothing is waiting on you"
            rows={pending.map((asset) => [
              asset.title ?? "Untitled",
              asset.ref_number ?? "—",
              asset.media_type,
              shortDate(asset.created_at),
              asset.media_type === "video" ? <div key={asset.id} className="space-y-2">
                {videoUrls.get(asset.render_path ?? asset.storage_path) && <video controls preload="metadata"
                  className="max-h-52 max-w-xs rounded-md" aria-label={`Review ${asset.title ?? "video"}`}
                  src={videoUrls.get(asset.render_path ?? asset.storage_path)} />}
                <VideoApprovalRoute assetId={asset.id} onFinalApprove={() => approve(asset)} />
              </div> : <button
                key={asset.id}
                type="button"
                disabled={busyId === asset.id}
                onClick={() => void approve(asset)}
                className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground transition-colors hover:opacity-90 disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                {busyId === asset.id ? "Approving…" : "Approve"}
              </button>,
            ])}
          />
        </Panel>

        <Panel
          title="Proof"
          action={
            <Button icon={Plus} onClick={() => setProofOpen(true)}>
              Upload Proof
            </Button>
          }
        >
          <p className="text-sm text-muted-foreground">
            {counts.proof === 0
              ? "Nothing on file yet. Testimonials, reviews and results you send here shape the content we make for you."
              : `${counts.proof} piece${counts.proof === 1 ? "" : "s"} of proof on file.`}
          </p>
        </Panel>

        <Panel title="Business context">
          {context?.business_overview ? (
            <div className="space-y-4 text-sm">
              <div>
                <h3 className="mb-1 font-medium text-foreground">Overview</h3>
                <p className="text-muted-foreground">{context.business_overview}</p>
              </div>
              {context.main_offer && (
                <div>
                  <h3 className="mb-1 font-medium text-foreground">Main offer</h3>
                  <p className="text-muted-foreground">{context.main_offer}</p>
                </div>
              )}
            </div>
          ) : (
            <EmptyState label="No business context captured yet" minHeight={100} />
          )}
        </Panel>
      </div>
    );
  }

  if (loadError) return <div role="alert"><p>{loadError}</p><button type="button" onClick={() => void refresh()}>Retry</button></div>;

  return (
    <ConsoleShell
      role="client"
      kind="client"
      basePath="/client"
      title={client?.name ?? "AA Client Console"}
      subtitle={[client?.sector, client?.tier].filter(Boolean).join(" · ") || undefined}
      heading={page.label}
    >
      {!clientId ? (
        <EmptyState label="This account is not linked to a client yet. Ask your account manager to connect it." />
      ) : page.id === "chat" ? (
        <ChatView />
      ) : page.id === "dashboard" ? (
        dashboard()
      ) : page.id === "active-campaigns" ? (
        <ActiveCampaignsView clientId={clientId} />
      ) : page.id === "active-organic" ? (
        <ActiveOrganicView clientId={clientId} />
      ) : page.id === "active-conversion" ? (
        <ActiveConversionView clientId={clientId} />
      ) : page.id === "account" ? (
        <ClientAccountView clientId={clientId} />
      ) : (
        <EmptyState label={`${page.label} — coming soon`} />
      )}

      <AddProofModal
        open={proofOpen}
        onClose={() => setProofOpen(false)}
        clientId={clientId ?? undefined}
        onSaved={refresh}
      />
    </ConsoleShell>
  );
}
