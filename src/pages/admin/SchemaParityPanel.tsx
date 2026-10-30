import { useState, type ChangeEvent } from "react";

type Status = "read" | "absent" | "unavailable";
type Category = { status: Status; count: number | null };
type History = { count: number; head: string | null; digest: string; storedSqlPayloadAvailable?: number; storedSqlPayloadUnavailable?: number } | null;
type Environment = { migrationHistory: History; categories: Record<string, Category>; errors: { category: string; reason: string; code: string | null }[] };
type Finding = { type: string; environment?: string; environments?: string[]; kind?: string; identity?: string; version?: string; localVersion?: string; remoteVersion?: string; count?: number; nextAction?: string };
export type SchemaParityReport = {
  schemaVersion: 1;
  createdAt: string;
  gitSha: string | null;
  sourceProvenance: { headSha: string | null; workingTreeClean: boolean | null; migrationInputsClean: boolean | null; migrationSourceDigest: string; generatedTypesSha256: string };
  result: "matching_snapshots" | "drift" | "incomplete";
  scope: "production_and_staging" | "production_staging_and_baseline";
  localMigrations: { count: number; head: string | null; digest: string };
  environments: Record<string, Environment>;
  generatedTypes: { sourceFile: string; sha256: string; generatedSha256?: string; schemaDerivedComparison: "matching" | "different" | "unverified" };
  sourceToHistoryBody: { provenEqualSingleStatement: Record<string, number>; unverifiedRepresentationOrDifference: Record<string, number>; storedSqlPayloadUnavailable?: Record<string, number> } | null;
  limitations: string[];
  findings: { total: number; shown: Finding[]; omitted: number };
};

const MAX_FILE_BYTES = 2_000_000;
const MAX_FINDINGS = 400;
const results = new Set(["matching_snapshots", "drift", "incomplete"]);
const scopes = new Set(["production_and_staging", "production_staging_and_baseline"]);
const categoryStatuses = new Set(["read", "absent", "unavailable"]);
const typeStatuses = new Set(["matching", "different", "unverified"]);

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function safeText(value: unknown, max = 160): string {
  if (typeof value !== "string" || value.length > max || /:\/\/|password|secret|token|key=/i.test(value)) return "[redacted]";
  return value;
}

/** Reject arbitrary JSON instead of treating an imported file as a trusted status. */
export function parseSchemaParityReport(value: unknown): SchemaParityReport | null {
  if (!record(value) || value.schemaVersion !== 1 || !results.has(String(value.result)) || !scopes.has(String(value.scope))) return null;
  if (typeof value.createdAt !== "string" || Number.isNaN(Date.parse(value.createdAt))) return null;
  if (value.gitSha !== null && (typeof value.gitSha !== "string" || !/^[0-9a-f]{40}$/i.test(value.gitSha))) return null;
  if (!record(value.sourceProvenance) || ![true, false, null].includes(value.sourceProvenance.workingTreeClean as boolean | null) || ![true, false, null].includes(value.sourceProvenance.migrationInputsClean as boolean | null)) return null;
  if (typeof value.sourceProvenance.migrationSourceDigest !== "string" || !/^[0-9a-f]{64}$/i.test(value.sourceProvenance.migrationSourceDigest)) return null;
  if (typeof value.sourceProvenance.generatedTypesSha256 !== "string" || !/^[0-9a-f]{64}$/i.test(value.sourceProvenance.generatedTypesSha256)) return null;
  if (value.sourceProvenance.headSha !== value.gitSha) return null;
  if (!record(value.localMigrations) || !Number.isInteger(value.localMigrations.count) || Number(value.localMigrations.count) < 0 || !record(value.environments)) return null;
  if (value.localMigrations.digest !== value.sourceProvenance.migrationSourceDigest || !record(value.generatedTypes) || value.generatedTypes.sha256 !== value.sourceProvenance.generatedTypesSha256) return null;
  if (value.localMigrations.head !== null && (typeof value.localMigrations.head !== "string" || !/^\d{14}$/.test(value.localMigrations.head))) return null;
  if (!record(value.environments.production) || !record(value.environments.staging)) return null;
  if (!record(value.generatedTypes) || !typeStatuses.has(String(value.generatedTypes.schemaDerivedComparison))) return null;
  if (value.sourceToHistoryBody !== null && (!record(value.sourceToHistoryBody) || !record(value.sourceToHistoryBody.provenEqualSingleStatement) || !record(value.sourceToHistoryBody.unverifiedRepresentationOrDifference))) return null;
  if (!record(value.findings) || !Array.isArray(value.findings.shown) || !Number.isInteger(value.findings.total) || !Number.isInteger(value.findings.omitted)) return null;
  const findingTotal = Number(value.findings.total);
  const findingOmitted = Number(value.findings.omitted);
  if (value.findings.shown.length > MAX_FINDINGS || findingTotal < value.findings.shown.length || findingOmitted !== findingTotal - value.findings.shown.length) return null;
  if (!Array.isArray(value.limitations) || value.limitations.length > 20 || value.limitations.some((limit) => typeof limit !== "string")) return null;
  for (const name of ["production", "staging", ...(value.scope === "production_staging_and_baseline" ? ["baseline"] : [])]) {
    const entry = value.environments[name];
    if (!record(entry) || !record(entry.categories) || !Array.isArray(entry.errors)) return null;
    if (entry.migrationHistory !== null && (!record(entry.migrationHistory) || !Number.isInteger(entry.migrationHistory.count) || (entry.migrationHistory.head !== null && (typeof entry.migrationHistory.head !== "string" || !/^\d{14}$/.test(entry.migrationHistory.head))))) return null;
    if (entry.errors.some((error) => !record(error) || typeof error.category !== "string" || typeof error.reason !== "string")) return null;
    for (const category of Object.values(entry.categories)) {
      if (!record(category) || !categoryStatuses.has(String(category.status))) return null;
      if (category.count !== null && (!Number.isInteger(category.count) || Number(category.count) < 0)) return null;
    }
  }
  for (const finding of value.findings.shown) {
    if (!record(finding) || typeof finding.type !== "string") return null;
    if (finding.nextAction !== undefined && typeof finding.nextAction !== "string") return null;
  }
  return value as SchemaParityReport;
}

function stamp(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Unknown" : date.toLocaleString();
}

function resultLabel(result: SchemaParityReport["result"]): string {
  if (result === "drift") return "Drift found";
  if (result === "incomplete") return "Verification incomplete";
  return "Observed snapshots match";
}

function classForResult(result: SchemaParityReport["result"]): string {
  return result === "matching_snapshots" ? "border-brand-strong/30 bg-brand-strong/5" : "border-destructive/40 bg-destructive/5";
}

export function SchemaParityPanel({ report: suppliedReport }: { report?: unknown }) {
  const [imported, setImported] = useState<SchemaParityReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const supplied = suppliedReport === undefined ? null : parseSchemaParityReport(suppliedReport);
  const report = suppliedReport === undefined ? imported : supplied;

  const importFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    setError(null);
    setImported(null);
    if (file.size > MAX_FILE_BYTES) { setError("Report exceeds the 2 MB import limit."); return; }
    try {
      const candidate = parseSchemaParityReport(JSON.parse(await file.text()));
      if (!candidate) { setError("This is not a valid redacted schema parity report."); return; }
      setImported(candidate);
    } catch { setError("Could not read this JSON report."); }
  };

  const environments = report ? ["production", "staging", ...(report.scope === "production_staging_and_baseline" ? ["baseline"] : [])] : [];
  const categories = report ? [...new Set(environments.flatMap((name) => Object.keys(report.environments[name]?.categories ?? {})))].sort() : [];

  return <section aria-label="Schema parity" className="space-y-5">
    <div>
      <h2 className="text-lg font-semibold">Schema and migration parity</h2>
      <p className="mt-1 text-sm text-muted-foreground">{suppliedReport === undefined ? "Import the redacted output of the read-only parity auditor." : suppliedReport === null ? "A live report is unavailable." : "The admin runtime supplied this redacted, read-only audit."} This page never receives database URLs or runs migrations.</p>
      {suppliedReport === undefined && <label className="mt-3 block text-sm font-medium">Import schema parity JSON
        <input className="mt-1 block w-full max-w-xl rounded-md border border-border bg-card p-2 text-sm" type="file" accept=".json,application/json" onChange={(event) => void importFile(event)} />
      </label>}
    </div>
    {error && <p role="alert" className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">{error}</p>}
    {suppliedReport !== undefined && suppliedReport !== null && !supplied && <p role="alert" className="rounded-md border border-destructive/40 p-3 text-sm">The supplied parity report failed validation.</p>}
    {!report && <p role="status" className="rounded-md border border-border p-3 text-sm text-muted-foreground">Schema parity unknown. No validated report is available.</p>}
    {report && <>
      <div role="status" className={`rounded-md border p-4 ${classForResult(report.result)}`}>
        <p className="font-semibold">{resultLabel(report.result)}</p>
        <p className="mt-1 text-sm">Captured {stamp(report.createdAt)} · HEAD {report.gitSha ? safeText(report.gitSha, 40) : "Unknown"} · working tree {report.sourceProvenance.workingTreeClean === true ? "clean" : report.sourceProvenance.workingTreeClean === false ? "dirty" : "unknown"} · {report.findings.total} finding{report.findings.total === 1 ? "" : "s"}</p>
        <p className="mt-1 text-xs">{report.scope === "production_and_staging" ? "Staging/production comparison only; tracked-source equivalence is unproven." : "Compared with a separately supplied clean-replay baseline."}</p>
        {report.sourceProvenance.workingTreeClean !== true && <p className="mt-1 text-xs">HEAD alone does not identify this audited checkout. Use the migration-source digest below.</p>}
      </div>

      <div className="overflow-x-auto rounded-md border border-border">
        <table className="w-full text-left text-sm">
          <caption className="p-3 text-left font-semibold">Migration history</caption>
          <thead><tr className="border-y border-border"><th className="p-2">Environment</th><th className="p-2">Entries</th><th className="p-2">Head</th><th className="p-2">Stored SQL payload</th><th className="p-2">Status</th></tr></thead>
          <tbody>
            <tr><th className="p-2 font-medium">Source manifest</th><td className="p-2">{report.localMigrations.count}</td><td className="p-2 font-mono">{report.localMigrations.head ?? "Unknown"}</td><td className="p-2">Tracked migrations</td><td className="p-2">Tracked migrations</td></tr>
            {environments.map((name) => <tr key={name} className="border-t border-border"><th className="p-2 font-medium capitalize">{name}</th><td className="p-2">{report.environments[name]?.migrationHistory?.count ?? "Unknown"}</td><td className="p-2 font-mono">{report.environments[name]?.migrationHistory?.head ?? "Unknown"}</td><td className="p-2">{report.environments[name]?.migrationHistory?.storedSqlPayloadUnavailable === undefined ? "Unknown" : `${report.environments[name]?.migrationHistory?.storedSqlPayloadUnavailable} unavailable`}</td><td className="p-2">{report.environments[name]?.errors.length ? "Incomplete" : "Read"}</td></tr>)}
          </tbody>
        </table>
      </div>

      <div className="overflow-x-auto rounded-md border border-border">
        <table className="w-full text-left text-sm">
          <caption className="p-3 text-left font-semibold">Catalog categories</caption>
          <thead><tr className="border-y border-border"><th className="p-2">Category</th>{environments.map((name) => <th key={name} className="p-2 capitalize">{name}</th>)}</tr></thead>
          <tbody>{categories.map((category) => <tr key={category} className="border-t border-border"><th className="p-2 font-medium">{category.replaceAll("_", " ")}</th>{environments.map((name) => {
            const entry = report.environments[name]?.categories[category];
            return <td key={name} className="p-2">{entry?.status === "read" ? `${entry.count} read` : entry?.status === "absent" ? "Absent" : "Unknown"}</td>;
          })}</tr>)}</tbody>
        </table>
      </div>

      <div className="rounded-md border border-border p-4 text-sm">
        <h3 className="font-semibold">Source and type verification</h3>
        <p className="mt-1 break-all font-mono text-xs">Migration-source SHA-256: {report.sourceProvenance.migrationSourceDigest}</p>
        <p className="mt-1">Migration inputs: {report.sourceProvenance.migrationInputsClean === true ? "clean" : report.sourceProvenance.migrationInputsClean === false ? "dirty" : "unknown"}</p>
        <p className="mt-1">Generated types: {report.generatedTypes.schemaDerivedComparison}. {report.sourceToHistoryBody ? environments.filter((name) => name !== "baseline").map((name) => `${name}: ${report.sourceToHistoryBody?.provenEqualSingleStatement[name] ?? 0} exact single-statement body matches, ${report.sourceToHistoryBody?.unverifiedRepresentationOrDifference[name] ?? 0} unverified`).join(" · ") : "Migration body comparison unavailable."}</p>
      </div>

      <div className="rounded-md border border-border p-4">
        <h3 className="font-semibold">Discrepancies</h3>
        {report.findings.shown.length === 0 ? <p className="mt-2 text-sm">No observed differences in the available checks.</p> : <ul className="mt-2 space-y-2 text-sm">{report.findings.shown.map((finding, index) => <li key={`${finding.type}-${finding.identity ?? finding.version ?? index}-${index}`} className="border-t border-border pt-2">
          <span className="font-medium">{safeText(finding.type)}</span> · {safeText(finding.environment ?? finding.environments?.join(" / ") ?? "source")}: {safeText(finding.identity ?? finding.version ?? finding.localVersion ?? (finding.count === undefined ? "Unknown" : `${finding.count} rows`))}
          {finding.remoteVersion && <span> → recorded as {safeText(finding.remoteVersion)}</span>}
          <p className="mt-1 text-muted-foreground">Next action: {finding.nextAction ? safeText(finding.nextAction, 240) : "No suggested action in report."}</p>
        </li>)}</ul>}
        {report.findings.omitted > 0 && <p className="mt-2 text-sm">{report.findings.omitted} more findings omitted from this bounded report.</p>}
      </div>

      <div className="rounded-md border border-border p-4 text-sm">
        <h3 className="font-semibold">Verification limits</h3>
        <ul className="mt-2 list-disc space-y-1 pl-5">{report.limitations.map((limit, index) => <li key={index}>{safeText(limit, 400)}</li>)}</ul>
      </div>
    </>}
  </section>;
}
