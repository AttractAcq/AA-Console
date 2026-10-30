import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Download, RefreshCw } from "lucide-react";
import { Button } from "../../components/Button";
import { browserBuildSha } from "../../lib/buildInfo";
import { readRuntime } from "../../lib/readRuntime";

type Observation<T> = {
  state: "observed" | "unknown" | "error";
  checkedAt: string;
  value: T | null;
  reason: string | null;
};

type Snapshot = {
  schemaVersion: number;
  capturedAt: string;
  environment: { name: string | null; railwayEnvironmentId: string | null; supabaseProjectRef: string | null };
  runtime: {
    sha: string | null;
    switches: Record<string, boolean>;
    credentialPresence: Record<string, boolean>;
    heartbeats: Observation<{
      workerId: string; sha: string | null; reportedVersion: string | null;
      reportedAt: string; isLive: boolean; enabled: boolean | null;
      queueDepth: number | null; activeJobs: number | null;
    }[]>;
  };
  gateway: Observation<{
    sha: string | null; observedAt: string;
    configured: { aaInternalApi: boolean; botAuthMode: string };
  }>;
  database: Observation<{
    migrationHead: string | null; migrationCount: number | null;
    objects: Record<string, number>;
    cronJobs: { name: string; schedule: string; active: boolean }[] | null;
  }>;
  global: Observation<{
    engineEnabled: boolean | null;
    publishingPlatforms: { platform: string; supported: boolean }[];
    proofDestinations: { key: string; mode: string; supported: boolean }[];
    campaignActionExecutors: { key: string; module: string; supported: boolean }[];
    messageChannels: { key: string; transport: string; supported: boolean; canInitiate: boolean }[];
  }>;
  clients: Observation<{
    id: string; name: string; switches: Record<string, boolean | null>;
    platforms: { platform: string; active: boolean }[];
    leadCaptureEndpoints: { id: string; purpose: string; enabled: boolean; expiresAt: string | null; revoked: boolean }[];
    proofDestinations: { key: string; enabled: boolean; hasAccountRef: boolean }[];
    salesAgentDeployments: { id: string; pageId: string | null; enabled: boolean }[];
    integrations: {
      provider: string; status: string; ingestEnabled: boolean; hasCredential: boolean;
      lastCheckedAt: string | null; tokenExpiresAt: string | null;
      accountIds: Record<string, string | null>;
    }[];
  }[]>;
  publicPerimeter?: Observation<{
    asOf: string; budgetDay: string;
    quotaLastHour: { route: string; bucketKind: string; activeBuckets: number; countedAttempts: number }[];
    budgetsToday: { deploymentId: string; messages: number; committedUsd: number;
      heldUsd: number; uncertainCount: number }[];
    unresolvedUncertain: number;
  }>;
  requestProxy?: {
    directPeer: string | null; forwardedHops: string[];
    chainStatus: "absent" | "invalid" | "ignored_untrusted_peer" | "trusted_peer";
    trustedProxyCount: number; callerIpUsedForQuota: string | null;
  };
};

function stamp(value: string | null | undefined): string {
  if (!value) return "Unknown";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Unknown" : date.toLocaleString();
}

function state(value: boolean | null | undefined): string {
  return value === true ? "On" : value === false ? "Off" : "Unknown";
}

function Commit({ sha }: { sha: string | null | undefined }) {
  if (!sha || !/^[0-9a-f]{40}$/i.test(sha)) return <span>Unknown</span>;
  return <a className="font-mono text-xs underline" href={`https://github.com/AttractAcq/AA-Console/commit/${sha}`}
    target="_blank" rel="noreferrer">{sha}</a>;
}

function Fact({ label, children, observedAt }: { label: string; children: ReactNode; observedAt: string }) {
  return <div className="rounded-lg border border-border bg-card p-4">
    <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</div>
    <div className="mt-2 break-all text-sm font-medium text-foreground">{children}</div>
    <div className="mt-2 text-xs text-muted-foreground">Checked {stamp(observedAt)}</div>
  </div>;
}

function ObservationMessage({ observation }: { observation: Observation<unknown> }) {
  if (observation.state === "observed") return null;
  return <p role="status" className="mt-2 rounded-md border border-border p-3 text-sm text-muted-foreground">
    {observation.state === "error" ? "Could not verify" : "Unknown"}: {observation.reason ?? "No evidence available."}
  </p>;
}

export function SystemReadinessPanel() {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [budgetPage, setBudgetPage] = useState(0);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await readRuntime<Snapshot>("/admin/system-readiness");
      setSnapshot(result);
      setBudgetPage(0);
    } catch (cause) {
      setSnapshot(null);
      setError(cause instanceof Error ? cause.message : "System readiness is unavailable.");
    } finally { setLoading(false); }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  const download = () => {
    if (!snapshot) return;
    const report = {
      ...snapshot,
      browser: { sha: browserBuildSha, capturedAt: snapshot.capturedAt },
    };
    const url = URL.createObjectURL(new Blob([JSON.stringify(report, null, 2)], { type: "application/json" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `aa-system-readiness-${snapshot.capturedAt.replaceAll(":", "-")}.json`;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  };

  return <div className="space-y-6">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div>
        <p className="text-sm text-muted-foreground">Read-only inventory of the environment serving this console. A reachable process is only liveness evidence; external provider actions need separate receipts and read-back.</p>
        {snapshot && <p className="mt-1 text-xs text-muted-foreground">Snapshot {stamp(snapshot.capturedAt)} · Environment {snapshot.environment.name ?? "Unknown"} · Supabase project {snapshot.environment.supabaseProjectRef ?? "Unknown"}</p>}
      </div>
      <div className="flex gap-2">
        <Button icon={RefreshCw} disabled={loading} onClick={() => void refresh()}>{loading ? "Checking…" : "Refresh"}</Button>
        <Button icon={Download} disabled={!snapshot || loading} onClick={download}>Export JSON</Button>
      </div>
    </div>

    {error && <p role="alert" className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">{error}</p>}
    {loading && !snapshot && <p role="status" className="text-sm text-muted-foreground">Collecting system evidence…</p>}
    {snapshot && <>
      <section aria-label="Code and deployment identity" className="space-y-3">
        <h2 className="text-lg font-semibold">Code and deployed services</h2>
        <div className="grid gap-3 lg:grid-cols-2">
          <Fact label="Browser bundle commit" observedAt={snapshot.capturedAt}><Commit sha={browserBuildSha} /></Fact>
          <Fact label="Runtime deployed commit" observedAt={snapshot.capturedAt}><Commit sha={snapshot.runtime.sha} /></Fact>
          <Fact label="Gateway deployed commit" observedAt={snapshot.gateway.checkedAt}>
            <Commit sha={snapshot.gateway.value?.sha} />
          </Fact>
          <Fact label="Database migration head" observedAt={snapshot.database.checkedAt}>
            {snapshot.database.value?.migrationHead ?? "Unknown"}
          </Fact>
        </div>
        <ObservationMessage observation={snapshot.gateway} />
        <ObservationMessage observation={snapshot.database} />
        {snapshot.runtime.sha && snapshot.runtime.heartbeats.value?.some((beat) => beat.isLive && beat.sha !== snapshot.runtime.sha) &&
          <p role="alert" className="text-sm text-destructive">The live heartbeat build does not match the runtime process build. Check deployed replicas.</p>}
      </section>

      <section aria-label="Configuration" className="space-y-3">
        <h2 className="text-lg font-semibold">Configuration</h2>
        <div className="grid gap-3 lg:grid-cols-2">
          <div className="rounded-lg border border-border bg-card p-4">
            <h3 className="font-medium">Runtime switches</h3>
            <dl className="mt-2 space-y-1 text-sm">{Object.entries(snapshot.runtime.switches).map(([key, value]) =>
              <div key={key} className="flex justify-between gap-3"><dt>{key}</dt><dd>{state(value)}</dd></div>)}</dl>
          </div>
          <div className="rounded-lg border border-border bg-card p-4">
            <h3 className="font-medium">Credential presence</h3>
            <p className="text-xs text-muted-foreground">Presence only; no credential value is returned.</p>
            <dl className="mt-2 space-y-1 text-sm">{Object.entries(snapshot.runtime.credentialPresence).map(([key, value]) =>
              <div key={key} className="flex justify-between gap-3"><dt>{key}</dt><dd>{value ? "Present" : "Missing"}</dd></div>)}</dl>
          </div>
        </div>
        <ObservationMessage observation={snapshot.global} />
        {snapshot.global.value && <div className="rounded-lg border border-border bg-card p-4 text-sm">
          <p>Database engine switch: {state(snapshot.global.value.engineEnabled)}</p>
          <p className="mt-1">Publishing adapters: {snapshot.global.value.publishingPlatforms.map((platform) => `${platform.platform} ${platform.supported ? "supported" : "unsupported"}`).join(" · ") || "None"}</p>
          <p className="mt-1">Proof destinations: {snapshot.global.value.proofDestinations.map((destination) => `${destination.key} ${destination.supported ? "supported" : "unsupported"} (${destination.mode})`).join(" · ") || "None"}</p>
          <p className="mt-1">Campaign action executors: {snapshot.global.value.campaignActionExecutors.map((action) => `${action.key} ${action.supported ? "supported" : "unsupported"} (${action.module})`).join(" · ") || "None"}</p>
          <p className="mt-1">Message channels: {snapshot.global.value.messageChannels.map((channel) => `${channel.key} ${channel.supported ? "supported" : "unsupported"}, ${channel.canInitiate ? "can initiate" : "reply only"} (${channel.transport})`).join(" · ") || "None"}</p>
          <p className="mt-2 text-xs text-muted-foreground">Source: engine_controls, platform_publishing, proof_destinations, campaign_action_executors and message_channels; checked {stamp(snapshot.global.checkedAt)}.</p>
        </div>}
        <p className="text-xs text-muted-foreground">Gateway internal API: {snapshot.gateway.value ? state(snapshot.gateway.value.configured.aaInternalApi) : "Unknown"}. Gateway probe checked {stamp(snapshot.gateway.checkedAt)}.</p>
      </section>

      <section aria-label="Observed dependency state" className="space-y-3">
        <h2 className="text-lg font-semibold">Observed dependency state</h2>
        <div className="grid gap-3 lg:grid-cols-2">
          <Fact label="Live runtime heartbeats" observedAt={snapshot.runtime.heartbeats.checkedAt}>
            {snapshot.runtime.heartbeats.value?.filter((beat) => beat.isLive).length ?? "Unknown"}
          </Fact>
          <Fact label="Cron jobs" observedAt={snapshot.database.checkedAt}>
            {snapshot.database.value?.cronJobs?.length ?? "Unknown"}
          </Fact>
        </div>
        <ObservationMessage observation={snapshot.runtime.heartbeats} />
        {snapshot.runtime.heartbeats.value?.map((beat) => <div key={beat.workerId} className="rounded-md border border-border p-3 text-sm">
          <span className="font-mono">{beat.workerId}</span> · {beat.isLive ? "Heartbeat fresh" : "Heartbeat stale"} · workers {state(beat.enabled)} · build <Commit sha={beat.sha} /> · reported {stamp(beat.reportedAt)} · queued {beat.queueDepth ?? "Unknown"} · active {beat.activeJobs ?? "Unknown"}
        </div>)}
        {snapshot.database.value && <div className="rounded-lg border border-border bg-card p-4 text-sm">
          <p>Tracked migration entries: {snapshot.database.value.migrationCount ?? "Unknown"}. Catalog objects: {Object.entries(snapshot.database.value.objects).map(([name, count]) => `${name} ${count}`).join(" · ")}</p>
          <p className="mt-2 text-xs text-muted-foreground">Source: service-only system_readiness_catalog RPC. This counts objects; B002 checks their definitions and drift.</p>
          {snapshot.database.value.cronJobs === null ? <p className="mt-2">Cron catalog unavailable.</p> :
            <ul className="mt-2 space-y-1">{snapshot.database.value.cronJobs.map((job) =>
              <li key={job.name} className="flex flex-wrap justify-between gap-2"><span>{job.name}</span><span>{job.active ? "Active" : "Inactive"} · {job.schedule}</span></li>)}</ul>}
        </div>}
      </section>

      <section aria-label="Public acquisition perimeter" className="space-y-3">
        <h2 className="text-lg font-semibold">Public acquisition perimeter</h2>
        {snapshot.requestProxy && <div className="rounded-lg border border-border bg-card p-4 text-sm">
          <h3 className="font-medium">This admin request's proxy path</h3>
          <p className="mt-2">Direct socket peer: <code>{snapshot.requestProxy.directPeer ?? "Invalid"}</code></p>
          <p className="mt-1">Forwarded chain: {snapshot.requestProxy.chainStatus.replaceAll("_", " ")}; {snapshot.requestProxy.forwardedHops.length ?
            snapshot.requestProxy.forwardedHops.map((hop, index) => <code key={`${index}-${hop}`} className="mr-2">{hop}</code>) : "no valid hops"}</p>
          <p className="mt-1">Configured trusted proxy CIDRs: {snapshot.requestProxy.trustedProxyCount}. Caller used for quota: <code>{snapshot.requestProxy.callerIpUsedForQuota ?? "Refused"}</code>.</p>
          <p className="mt-2 text-xs text-muted-foreground">Only this authenticated admin request is inspected. The raw forwarding header is never returned or logged. With no trusted direct peer, the forwarding chain is ignored for quota.</p>
        </div>}
        {!snapshot.publicPerimeter && <p className="text-sm text-muted-foreground">This runtime build has no public perimeter inventory.</p>}
        {snapshot.publicPerimeter && <ObservationMessage observation={snapshot.publicPerimeter} />}
        {snapshot.publicPerimeter?.value && <>
          <p className="text-xs text-muted-foreground">Checked {stamp(snapshot.publicPerimeter.value.asOf)}. Counted attempts are capped within each quota bucket; they are not a count of every refused request. These aggregate metrics contain no caller IP or token handles.</p>
          <div className="grid gap-3 lg:grid-cols-2">
            <Fact label="Unresolved paid requests" observedAt={snapshot.publicPerimeter.checkedAt}>
              {snapshot.publicPerimeter.value.unresolvedUncertain}
            </Fact>
            <Fact label={`Held paid budget · ${snapshot.publicPerimeter.value.budgetDay}`} observedAt={snapshot.publicPerimeter.checkedAt}>
              ${snapshot.publicPerimeter.value.budgetsToday.reduce((sum, row) => sum + row.heldUsd, 0).toFixed(2)}
            </Fact>
          </div>
          <div className="overflow-x-auto rounded-lg border border-border bg-card p-4">
            <h3 className="font-medium">Quota buckets · last hour</h3>
            {snapshot.publicPerimeter.value.quotaLastHour.length === 0 ?
              <p className="mt-2 text-sm text-muted-foreground">No public POST attempts recorded.</p> :
              <table className="mt-2 w-full text-left text-sm"><thead><tr>
                <th className="p-2">Route</th><th className="p-2">Bucket</th>
                <th className="p-2">Active buckets</th><th className="p-2">Counted attempts</th>
              </tr></thead><tbody>{snapshot.publicPerimeter.value.quotaLastHour.map((row) =>
                <tr key={`${row.route}-${row.bucketKind}`} className="border-t border-border">
                  <td className="p-2 font-mono text-xs">{row.route}</td><td className="p-2">{row.bucketKind}</td>
                  <td className="p-2">{row.activeBuckets}</td><td className="p-2">{row.countedAttempts}</td>
                </tr>)}</tbody></table>}
          </div>
          <div className="overflow-x-auto rounded-lg border border-border bg-card p-4">
            <h3 className="font-medium">Paid widget budgets · {snapshot.publicPerimeter.value.budgetDay}</h3>
            {snapshot.publicPerimeter.value.budgetsToday.length === 0 ?
              <p className="mt-2 text-sm text-muted-foreground">No paid widget reservations today.</p> : <>
              <table className="mt-2 w-full text-left text-sm"><thead><tr>
                <th className="p-2">Deployment</th><th className="p-2">Messages</th>
                <th className="p-2">Settled USD</th><th className="p-2">Held USD</th>
                <th className="p-2">Uncertain today</th>
              </tr></thead><tbody>{snapshot.publicPerimeter.value.budgetsToday.slice(budgetPage * 20, budgetPage * 20 + 20).map((row) =>
                <tr key={row.deploymentId} className="border-t border-border">
                  <td className="p-2 font-mono text-xs">{row.deploymentId}</td><td className="p-2">{row.messages}</td>
                  <td className="p-2">${row.committedUsd.toFixed(4)}</td>
                  <td className="p-2">${row.heldUsd.toFixed(4)}</td><td className="p-2">{row.uncertainCount}</td>
                </tr>)}</tbody></table>
              <div className="mt-3 flex items-center justify-between gap-2 text-xs text-muted-foreground">
                <span>Showing {budgetPage * 20 + 1}–{Math.min((budgetPage + 1) * 20, snapshot.publicPerimeter.value.budgetsToday.length)} of {snapshot.publicPerimeter.value.budgetsToday.length}</span>
                <div className="flex gap-2">
                  <Button disabled={budgetPage === 0} onClick={() => setBudgetPage((page) => page - 1)}>Previous</Button>
                  <Button disabled={(budgetPage + 1) * 20 >= snapshot.publicPerimeter.value.budgetsToday.length} onClick={() => setBudgetPage((page) => page + 1)}>Next</Button>
                </div>
              </div></>}
            <p className="mt-2 text-xs text-muted-foreground">These are runtime cost estimates, not provider billing receipts. An uncertain reserve stays held until verified against provider usage.</p>
          </div>
        </>}
      </section>

      <section aria-label="Client configuration" className="space-y-3">
        <h2 className="text-lg font-semibold">Client configuration and accounts</h2>
        <ObservationMessage observation={snapshot.clients} />
        {snapshot.clients.value?.length === 0 && <p className="text-sm text-muted-foreground">No clients are configured.</p>}
        {snapshot.clients.value?.map((client) => <div key={client.id} className="rounded-lg border border-border bg-card p-4">
          <h3 className="font-medium">{client.name} <span className="font-mono text-xs text-muted-foreground">{client.id}</span></h3>
          <p className="mt-2 text-sm">Switches: {Object.entries(client.switches).map(([key, value]) => `${key} ${state(value)}`).join(" · ")}</p>
          <p className="mt-1 text-sm">Platforms: {client.platforms.length ? client.platforms.map((platform) => `${platform.platform} ${state(platform.active)}`).join(" · ") : "None configured"}</p>
          <p className="mt-1 text-sm">Lead capture endpoints: {client.leadCaptureEndpoints.length ? client.leadCaptureEndpoints.map((endpoint) => `${endpoint.purpose} ${endpoint.enabled ? "on" : "off"}${endpoint.revoked ? " (revoked)" : ""}, expires ${stamp(endpoint.expiresAt)}`).join(" · ") : "None configured"}</p>
          <p className="mt-1 text-sm">Proof destinations: {client.proofDestinations.length ? client.proofDestinations.map((destination) => `${destination.key} ${state(destination.enabled)}${destination.hasAccountRef ? " (account linked)" : ""}`).join(" · ") : "None configured"}</p>
          <p className="mt-1 text-sm">Sales agent deployments: {client.salesAgentDeployments.length ? client.salesAgentDeployments.map((deployment) => `${deployment.pageId ?? deployment.id} ${state(deployment.enabled)}`).join(" · ") : "None configured"}</p>
          <ul className="mt-2 space-y-1 text-sm">{client.integrations.map((integration, index) =>
            <li key={`${integration.provider}-${index}`}>{integration.provider}: {integration.status}; ingest {state(integration.ingestEnabled)}; credential {integration.hasCredential ? "present" : "missing"}; checked {stamp(integration.lastCheckedAt)}; token expiry {stamp(integration.tokenExpiresAt)}; account IDs {Object.entries(integration.accountIds).filter(([, value]) => value).map(([key, value]) => `${key} ${value}`).join(", ") || "Unknown"}</li>)}</ul>
        </div>)}
      </section>

      <section aria-label="External proof" className="rounded-lg border border-border bg-card p-4">
        <h2 className="text-lg font-semibold">External action proof</h2>
        <p className="mt-1 text-sm text-muted-foreground">Unknown from this inventory. Provider receipts, read-back, actual spend, delivery and conversion evidence are recorded by the relevant build gates.</p>
      </section>
    </>}
  </div>;
}
