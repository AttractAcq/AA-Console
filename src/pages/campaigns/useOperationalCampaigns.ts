import { useEffect, useState } from "react";
import { supabase } from "../../lib/supabase";
import type { Requirement } from "./CampaignExecutionPanel";

export type OperationalCampaign = {
  id: string; client_id: string; name: string; status: string;
  objective: string | null; channels: string[]; starts_on: string | null;
  ends_on: string | null; needs_landing_page: boolean; needs_sales_agent: boolean;
};
export const campaignError = (error: unknown) =>
  (error as { message?: string })?.message ?? "Unknown query error";

export function useOperationalCampaigns(clientId?: string) {
  const [state, setState] = useState({
    rows: [] as OperationalCampaign[], clients: [] as { id: string; name: string }[],
    readiness: {} as Record<string, Requirement[]>, loading: true, error: "", readinessError: "",
  });
  useEffect(() => {
    let current = true;
    setState({ rows: [], clients: [], readiness: {}, loading: true, error: "", readinessError: "" });
    void (async () => {
      try {
        let query = supabase.from("client_campaigns").select("id, client_id, name, status, objective, channels, starts_on, ends_on, needs_landing_page, needs_sales_agent").order("created_at", { ascending: false });
        if (clientId) query = query.eq("client_id", clientId);
        const [campaigns, clients] = await Promise.all([
          query, clientId ? Promise.resolve({ data: [], error: null }) : supabase.from("clients").select("id, name").order("name"),
        ]);
        if (campaigns.error) throw campaigns.error;
        if (clients.error) throw clients.error;
        const rows = (campaigns.data ?? []) as OperationalCampaign[];
        const readiness: Record<string, Requirement[]> = {};
        let readinessError = "";
        if (!clientId) await Promise.all(rows.map(async (row) => {
          try {
            const result = await supabase.rpc("campaign_readiness", { p_campaign_id: row.id });
            if (result.error) throw result.error;
            readiness[row.id] = result.data ?? [];
          } catch (error) { readinessError = `Failed to load readiness: ${campaignError(error)}`; }
        }));
        if (current) setState({ rows, clients: clients.data ?? [], readiness, loading: false, error: "", readinessError });
      } catch (error) {
        if (current) setState(s => ({ ...s, loading: false, error: `Failed to load campaigns: ${campaignError(error)}` }));
      }
    })();
    return () => { current = false; };
  }, [clientId]);
  return state;
}
