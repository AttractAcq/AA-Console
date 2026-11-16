import { useCallback, useEffect, useState } from "react";
import { supabase } from "../../lib/supabase";
import { downloadVerifiedMagnetFile } from "../../lib/leadMagnets";

type Readiness = {
  status: "unsupported" | "preparing" | "ready_for_review";
  run_id?: string | null;
  expected?: number;
  ready?: number;
  blockers: string[];
};
type Package = {
  id: string;
  version: number;
  snapshot_hash: string;
  assembled_at: string;
  snapshot: { outputs?: Array<{ item_key: string; route_key: string;
    output_fingerprint: string; output_refs: unknown[] }> };
};
type MagnetVersion = { id: string; magnet_id: string; storage_path: string;
  content_sha256: string; file_bytes: number };
type OutputRef = { kind?: string; record_id?: string; version?: string };

function magnetRef(output: NonNullable<Package["snapshot"]["outputs"]>[number]): OutputRef | null {
  if (output.item_key !== "campaign_lead_magnet" || !Array.isArray(output.output_refs)) return null;
  const ref = output.output_refs.find((item): item is OutputRef =>
    !!item && typeof item === "object" && (item as OutputRef).kind === "magnet_version");
  return ref ?? null;
}

export function CampaignPackageReadiness({ campaignId, clientId }: {
  campaignId: string; clientId: string;
}) {
  const [readiness, setReadiness] = useState<Readiness | null>(null);
  const [prepared, setPrepared] = useState<Package | null>(null);
  const [current, setCurrent] = useState(false);
  const [approved, setApproved] = useState(false);
  const [magnetVersions, setMagnetVersions] = useState<Record<string, MagnetVersion>>({});
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const [assembling, setAssembling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const refresh = useCallback(async () => {
    const { data, error: readError } = await supabase.rpc("campaign_package_readiness_v7",
      { p_campaign_id: campaignId });
    if (readError) { setReadiness(null); setError(readError.message); return; }
    const result = data as Partial<Readiness> | null;
    if (!result || !Array.isArray(result.blockers)
      || !["unsupported", "preparing", "ready_for_review"].includes(result.status ?? "")) {
      setReadiness(null);
      setError("Package readiness returned incomplete evidence. Refresh and try again.");
      return;
    }
    setReadiness(result as Readiness);
    const { data: packageData, error: packageError } = await supabase
      .from("campaign_preparation_packages_v7")
      .select("id, version, snapshot_hash, snapshot, assembled_at")
      .eq("campaign_id", campaignId).order("version", { ascending: false })
      .limit(1).maybeSingle();
    if (packageError) { setError(packageError.message); return; }
    const row = packageData as Package | null;
    setPrepared(row);
    const magnetIds = (row?.snapshot.outputs ?? []).map(magnetRef)
      .map((ref) => ref?.record_id).filter((id): id is string => typeof id === "string");
    if (magnetIds.length) {
      const versions = await supabase.from("lead_magnet_versions")
        .select("id,magnet_id,storage_path,content_sha256,file_bytes")
        .eq("client_id", clientId).in("id", magnetIds);
      if (versions.error) { setError(versions.error.message); return; }
      setMagnetVersions(Object.fromEntries(((versions.data ?? []) as MagnetVersion[])
        .map((version) => [version.id, version])));
    } else setMagnetVersions({});
    if (row) {
      const check = await supabase.rpc("campaign_preparation_package_current_v7",
        { p_package_id: row.id });
      if (check.error) { setError(check.error.message); return; }
      setCurrent(check.data === true);
      if (check.data === true) {
        const decision = await supabase.rpc("campaign_preparation_approved_v7",
          { p_package_id: row.id });
        if (decision.error) { setError(decision.error.message); return; }
        setApproved(decision.data === true);
      } else setApproved(false);
    } else { setCurrent(false); setApproved(false); }
    setError(null);
  }, [campaignId, clientId]);

  const assemble = async () => {
    setAssembling(true); setError(null);
    const { error: assembleError } = await supabase.rpc(
      "assemble_campaign_preparation_package_v7", { p_campaign_id: campaignId });
    setAssembling(false);
    if (assembleError) { setError(assembleError.message); return; }
    void refresh();
  };

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => { void refresh(); }, 15_000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  return <section className="mt-4 rounded-lg border border-border bg-card p-4" aria-label="Campaign package readiness">
    <div className="flex items-center justify-between gap-2">
      <h3 className="font-semibold">Production package readiness</h3>
      <button type="button" className="rounded-md border border-border px-3 py-1.5 text-xs font-medium hover:bg-accent"
        onClick={() => void refresh()}>Refresh readiness</button>
    </div>
    {error && <p role="alert" className="mt-2 text-xs text-destructive">{error}</p>}
    {!error && !readiness && <p className="mt-2 text-xs text-muted-foreground">Checking exact sweep outputs…</p>}
    {readiness && <>
      <p className="mt-2 text-sm">{readiness.status === "ready_for_review"
        ? "All required outputs passed internal QA and are ready for package review."
        : readiness.status === "unsupported" ? "This legacy campaign has no route package."
          : `${readiness.ready ?? 0} of ${readiness.expected ?? 0} required outputs ready for review.`}</p>
      {readiness.run_id && <p className="mt-1 text-xs text-muted-foreground">Sweep {readiness.run_id}</p>}
      {readiness.status === "ready_for_review" && <p className="mt-2 text-xs text-muted-foreground">
        Internal QA does not approve publication, paid activation, page publishing, or public agent enablement.
      </p>}
      {readiness.status === "ready_for_review" && !current && <button type="button"
        disabled={assembling}
        className="mt-3 rounded-md border border-border px-3 py-1.5 text-xs font-medium hover:bg-accent disabled:opacity-50"
        onClick={() => void assemble()}>
        {assembling ? "Assembling…" : "Freeze exact package for review"}
      </button>}
      {prepared && <div className="mt-3 rounded-md border border-border p-3 text-xs">
        <p className="font-medium">Frozen package v{prepared.version} · {current ? "Current" : "Superseded"}</p>
        <p className="mt-1 text-muted-foreground">Assembled {new Date(prepared.assembled_at).toLocaleString()} · SHA-256 {prepared.snapshot_hash}</p>
        {current && <p className="mt-1">Exact outputs: {(prepared.snapshot.outputs ?? []).length}.
          {approved ? " Human preparation review approved." : " Human preparation review is pending."}</p>}
        {current && !approved && <a className="mt-2 inline-block underline"
          href={`/clients/${clientId}/delivery/approval-inbox?tab=unified`}>
          Review in Approval Inbox</a>}
        {current && <ul className="mt-2 list-disc space-y-1 pl-5">{(prepared.snapshot.outputs ?? []).map((output) => {
          const ref = magnetRef(output);
          const magnet = ref?.record_id ? magnetVersions[ref.record_id] : null;
          const exact = magnet && magnet.content_sha256 === ref?.version;
          return <li key={output.item_key}>
            {output.item_key.replaceAll("_", " ")} · {output.route_key} · {output.output_fingerprint.slice(0, 12)}…
            {ref && (exact ? <span className="ml-2 inline-flex flex-wrap gap-2">
              <a className="underline" href={`/clients/${clientId}/delivery/lead-magnet-studio?magnet=${encodeURIComponent(magnet.magnet_id)}`}>Open magnet</a>
              <button type="button" className="underline" onClick={() => {
                setDownloadError(null);
                void downloadVerifiedMagnetFile(magnet.storage_path, magnet.content_sha256,
                  magnet.file_bytes).catch((cause: unknown) => setDownloadError(
                  cause instanceof Error ? cause.message : "Could not verify the exact PDF."));
              }}>Download verified PDF</button>
            </span> : <span className="ml-2 text-destructive">Exact magnet file unavailable</span>)}
          </li>;
        })}</ul>}
        {downloadError && <p role="alert" className="mt-2 text-destructive">{downloadError}</p>}
      </div>}
      {readiness.blockers.length > 0 && <ul className="mt-2 list-disc space-y-1 pl-5 text-xs text-destructive">
        {readiness.blockers.map((blocker, index) => <li key={`${index}-${blocker}`}>{blocker}</li>)}
      </ul>}
    </>}
  </section>;
}
