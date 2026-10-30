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

type EvidenceCheck = {
  state: "observed" | "unknown" | "error";
  checkedAt: string;
  evidenceAt: string | null;
  source: string;
  reason: string | null;
};

const EVIDENCE_LABELS: Record<string, string> = {
  runtimeDeployment: "Runtime deployed commit",
  runtimeWorkers: "Runtime worker fleet",
  gatewayDeployment: "Gateway deployed commit",
  schemaCatalog: "Database schema catalog",
  schemaParity: "Database schema parity",
  cronCatalog: "Cron schedule catalog",
  cronExecution: "Cron execution",
  switchInventory: "Runtime and database switches",
  credentialValidity: "Credential validity",
  providerAccountHealth: "Provider account health",
  otherEnvironment: "Other environment inventory",
  externalEffects: "External action results",
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
    campaignActionExecutors: { key: string; module: string; supported: boolean; handlerRegistered?: boolean }[];
    campaignActionHandlerParity?: { state: "aligned" | "blocked"; unhandledSupportedKeys: string[] };
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
      providerHealth?: EvidenceCheck;
    }[];
  }[]>;
  evidenceCoverage?: Record<string, EvidenceCheck>;
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

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await readRuntime<Snapshot>("/admin/system-readiness");
      setSnapshot(result);
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
      <section aria-label="Evidence coverage" className="space-y-3">
        <h2 className="text-lg font-semibold">Evidence coverage</h2>
        <p className="text-sm text-muted-foreground">Recorded means the named source returned evidence at capture time. It does not certify the feature or an external provider action.</p>
        {!snapshot.evidenceCoverage && <p role="status" className="text-sm text-muted-foreground">This runtime has not supplied machine-readable evidence coverage. Refresh after its deployment.</p>}
        {snapshot.evidenceCoverage && <dl className="grid gap-3 lg:grid-cols-2">
          {Object.entries(EVIDENCE_LABELS).map(([key, label]) => {
            const check = snapshot.evidenceCoverage?.[key];
            return <div key={key} className="rounded-lg border border-border bg-card p-4 text-sm">
              <dt className="font-medium">{label}</dt>
              <dd className="mt-1">{check?.state === "observed" ? "Recorded" : check?.state === "error" ? "Could not verify" : "Unknown"}</dd>
              <dd className="mt-1 text-xs text-muted-foreground">Source: {check?.source ?? "Unknown"}; checked {stamp(check?.checkedAt)}; source evidence {stamp(check?.evidenceAt)}.</dd>
              {check?.reason && <dd className="mt-1 text-xs text-muted-foreground">{check.reason}</dd>}
            </div>;
          })}
        </dl>}
      </section>

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
          <p className="mt-1">Campaign action executors: {snapshot.global.value.campaignActionExecutors.map((action) => `${action.key} ${action.supported ? "database supported" : "database unsupported"}, ${action.handlerRegistered === true ? "runtime handler registered" : action.handlerRegistered === false ? "no runtime handler" : "runtime handler unknown"} (${action.module})`).join(" · ") || "None"}</p>
          {snapshot.global.value.campaignActionHandlerParity?.state === "blocked" &&
            <p role="alert" className="mt-2 text-destructive">Campaign action execution is blocked: the database marks {snapshot.global.value.campaignActionHandlerParity.unhandledSupportedKeys.join(", ")} supported, but this runtime has no campaign action handler. No action should be claimed until the mismatch is repaired.</p>}
          {!snapshot.global.value.campaignActionHandlerParity &&
            <p role="status" className="mt-2 text-muted-foreground">Campaign action handler parity is unknown in this runtime build.</p>}
          <p className="mt-2 text-xs text-muted-foreground">A registered handler does not prove a connected account, current approval, or external result.</p>
          <p className="mt-1">Message channels: {snapshot.global.value.messageChannels.map((channel) => `${channel.key} ${channel.supported ? "supported" : "unsupported"}, ${channel.canInitiate ? "can initiate" : "reply only"} (${channel.transport})`).join(" · ") || "None"}</p>
          <p className="mt-2 text-xs text-muted-foreground">Source: engine_controls, platform_publishing, proof_destinations, campaign_action_executors and message_channels; checked {stamp(snapshot.global.checkedAt)}.</p>
        </div>}
        <div className="rounded-lg border border-border bg-card p-4 text-sm">
          <p>Gateway internal API: {snapshot.gateway.value ? state(snapshot.gateway.value.configured.aaInternalApi) : "Unknown"}.</p>
          <p className="mt-1">Gateway Bot auth mode: {snapshot.gateway.value?.configured.botAuthMode ?? "Unknown"}.</p>
          {snapshot.gateway.value?.configured.botAuthMode === "dual" &&
            <p role="status" className="mt-2 text-muted-foreground">Dual mode can still admit legacy environment identities. Verify each Bot grant and revocation before enabling autonomous tool access.</p>}
          <p className="mt-2 text-xs text-muted-foreground">Gateway probe checked {stamp(snapshot.gateway.checkedAt)}.</p>
        </div>
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
            <li key={`${integration.provider}-${index}`}>{integration.provider}: {integration.status}; ingest {state(integration.ingestEnabled)}; credential {integration.hasCredential ? "present" : "missing"}; last recorded integration check {stamp(integration.lastCheckedAt)}; token expiry {stamp(integration.tokenExpiresAt)}; account IDs {Object.entries(integration.accountIds).filter(([, value]) => value).map(([key, value]) => `${key} ${value}`).join(", ") || "Unknown"}; live provider health {integration.providerHealth?.state === "observed" ? "Recorded" : integration.providerHealth?.state === "error" ? "Could not verify" : "Unknown"}{integration.providerHealth?.reason && <span className="block text-xs text-muted-foreground">{integration.providerHealth.reason}</span>}</li>)}</ul>
        </div>)}
      </section>

      <section aria-label="External proof" className="rounded-lg border border-border bg-card p-4">
        <h2 className="text-lg font-semibold">External action proof</h2>
        <p className="mt-1 text-sm text-muted-foreground">Unknown from this inventory. Provider receipts, read-back, actual spend, delivery and conversion evidence are recorded by the relevant build gates.</p>
      </section>
    </>}
  </div>;
}
