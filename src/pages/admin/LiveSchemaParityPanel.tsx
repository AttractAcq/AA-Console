import { useCallback, useEffect, useState } from "react";
import { Download, RefreshCw } from "lucide-react";
import { Button } from "../../components/Button";
import { readRuntime } from "../../lib/readRuntime";
import { SchemaParityPanel, parseSchemaParityReport, type SchemaParityReport } from "./SchemaParityPanel";

/** Only the server holds the scoped Supabase Management API token. The browser
 * receives a bounded, redacted report after its current admin session passes
 * the runtime's database-backed role check. */
export function LiveSchemaParityPanel() {
  const [report, setReport] = useState<SchemaParityReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const value = await readRuntime<unknown>("/admin/schema-parity");
      const parsed = parseSchemaParityReport(value);
      if (!parsed) throw new Error("The runtime returned an invalid schema parity report.");
      setReport(parsed);
    } catch (cause) {
      setReport(null);
      setError(cause instanceof Error ? cause.message : "Schema parity is unavailable.");
    } finally { setLoading(false); }
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);

  const download = () => {
    if (!report) return;
    const url = URL.createObjectURL(new Blob([JSON.stringify(report, null, 2)], { type: "application/json" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `aa-schema-parity-${report.createdAt.replaceAll(":", "-")}.json`;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  };

  const ageMs = report ? Date.now() - Date.parse(report.createdAt) : null;
  const stale = ageMs === null || !Number.isFinite(ageMs) || ageMs < 0 || ageMs > 15 * 60_000;
  return <div className="space-y-4">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <p className="text-sm text-muted-foreground">Live, read-only staging and production catalog audit. A scoped token stays on the runtime server.</p>
      <div className="flex gap-2">
        <Button icon={RefreshCw} disabled={loading} onClick={() => void refresh()}>{loading ? "Checking…" : "Refresh"}</Button>
        <Button icon={Download} disabled={!report || loading} onClick={download}>Export JSON</Button>
      </div>
    </div>
    {loading && !report && <p role="status" className="text-sm text-muted-foreground">Collecting live schema evidence…</p>}
    {error && <p role="alert" className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">{error}</p>}
    {report && stale && <p role="alert" className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">This schema parity report is stale or has an invalid capture time. Refresh before using it for release decisions.</p>}
    <SchemaParityPanel report={report} />
  </div>;
}
