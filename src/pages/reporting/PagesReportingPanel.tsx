import { useCallback, useEffect, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import { DataTable } from "../../components/DataTable";
import { Panel } from "../../components/Panel";
import { supabase } from "../../lib/supabase";

type Row = {
  page_id: string;
  page_title: string;
  archived_at: string | null;
  recorded_leads: number;
  consented_leads: number;
  recorded_sales: number;
  recorded_cash: number;
  latest_lead_at: string | null;
};

export function PagesReportingPanel({ pageType }: { pageType: "landing" | "offer" }) {
  const { clientId } = useParams<{ clientId: string }>();
  return <ClientPagesReporting key={`${clientId ?? "no-client"}:${pageType}`}
    clientId={clientId} pageType={pageType} />;
}

function ClientPagesReporting({ clientId, pageType }: {
  clientId: string | undefined; pageType: "landing" | "offer";
}) {
  const [days, setDays] = useState(30);
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);

  const refresh = useCallback(async () => {
    const current = ++generation.current;
    if (!clientId) { setLoading(false); return; }
    setLoading(true);
    try {
      const read = await supabase.rpc("page_recorded_outcomes_v8", {
        p_client_id: clientId, p_page_type: pageType, p_days: days,
      });
      if (current !== generation.current) return;
      if (read.error) throw read.error;
      setRows((read.data ?? []) as Row[]);
      setError(null);
    } catch {
      if (current !== generation.current) return;
      setRows([]);
      setError("Page outcome coverage is unavailable. No zero totals can be inferred.");
    } finally {
      if (current === generation.current) setLoading(false);
    }
  }, [clientId, pageType, days]);

  useEffect(() => {
    void refresh();
    return () => { generation.current += 1; };
  }, [refresh]);

  const label = pageType === "landing" ? "Landing" : "Offer";
  return <Panel title={`${label} page outcomes`}>
    <p className="text-sm text-muted-foreground">
      These are first-source lead and recorded outcome associations for this client. A returning lead
      can submit another page form without changing its first source. Page visits, conversion rate,
      traffic source completeness and site analytics remain unknown until a site connector is verified.
      Sale and cash amounts do not have a recorded currency.
    </p>
    <div className="my-4 flex gap-2" aria-label="Page outcome window">
      {[7, 30, 90].map((windowDays) => <button key={windowDays} type="button"
        aria-pressed={days === windowDays} onClick={() => setDays(windowDays)}
        className="rounded-full border border-border px-3 py-1 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
        {windowDays} days
      </button>)}
    </div>
    {loading ? <p role="status">Loading recorded page outcomes…</p>
      : error ? <p role="alert" className="text-destructive">{error}</p>
        : <DataTable columns={["Page", "Leads", "Consent", "Sales", "Recorded cash", "Latest lead"]}
          emptyLabel={`No ${pageType} pages are recorded for this client.`}
          rows={rows.map((row) => [
            <span key={row.page_id} title={row.page_id}>{row.page_title}{row.archived_at ? " · archived" : ""}</span>,
            row.recorded_leads,
            `${row.consented_leads}/${row.recorded_leads}`,
            row.recorded_sales,
            Number(row.recorded_cash).toLocaleString(),
            row.latest_lead_at ? new Date(row.latest_lead_at).toLocaleDateString() : "none recorded",
          ])} />}
  </Panel>;
}
