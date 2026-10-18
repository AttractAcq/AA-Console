import { useEffect, useState } from "react";
import { EditRepurposePanel } from "../../media/EditRepurposePanel";
import { supabase } from "../../../lib/supabase";

type Client = { client_id: string; clients: { name: string } | null };

/** Give the active assigned SMM the same intake and human-edit handoff as admin. */
export function SmmVideoEditing({ memberId }: { memberId: string }) {
  const [clients, setClients] = useState<Client[]>([]);
  const [selected, setSelected] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    void supabase.from("client_assignments").select("client_id, clients(name)")
      .eq("member_id", memberId).is("ended_at", null).then(({ data, error: failure }) => {
        if (!live) return;
        if (failure) setError(failure.message);
        else {
          const rows = (data ?? []) as unknown as Client[];
          setClients(rows);
          setSelected((current) => rows.some((row) => row.client_id === current)
            ? current : rows[0]?.client_id ?? "");
        }
        setLoading(false);
      });
    return () => { live = false; };
  }, [memberId]);

  if (loading) return <p className="text-sm text-muted-foreground">Loading assigned clients…</p>;
  if (error) return <p role="alert" className="text-sm text-destructive">{error}</p>;
  if (clients.length === 0) return <p className="text-sm text-muted-foreground">No active clients are assigned to you.</p>;
  return <div className="space-y-4">
    <label className="block text-sm font-medium">Client
      <select aria-label="Client for video editing" value={selected}
        onChange={(event) => setSelected(event.target.value)}
        className="mt-1 block w-full max-w-sm rounded-md border border-input bg-background px-3 py-2 text-sm">
        {clients.map((row) => <option key={row.client_id} value={row.client_id}>
          {row.clients?.name ?? "Client"}</option>)}
      </select>
    </label>
    <EditRepurposePanel key={selected} clientIdOverride={selected} employeeMode />
  </div>;
}
