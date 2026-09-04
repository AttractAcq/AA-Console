import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Users, Settings2, UsersRound, ShieldCheck, ChevronRight } from "lucide-react";
import { Panel } from "../components/Panel";
import { ClientCard } from "../components/ClientCard";
import { EmptyState } from "../components/EmptyState";
import { getRecentClientIds } from "../lib/routeEntities";
import { supabase } from "../lib/supabase";
import type { Client } from "../data/clients";

const quickLinks = [
  { id: "clients", label: "Clients", path: "/clients", icon: Users },
  { id: "operations", label: "Operations", path: "/operations", icon: Settings2 },
  { id: "team", label: "Team", path: "/team", icon: UsersRound },
  { id: "admin", label: "Admin", path: "/admin", icon: ShieldCheck },
];

type Stats = { mrr: number; clients: number; jobs: number; agents: number };

function toClient(c: {
  id: string;
  name: string;
  initials: string;
  sector: string | null;
  location: string | null;
  tier: string | null;
  is_internal: boolean;
}): Client {
  return {
    id: c.id,
    name: c.name,
    initials: c.initials,
    sector: c.sector ?? "",
    location: c.location ?? "",
    tier: c.tier ?? "",
    isInternal: c.is_internal,
  };
}

export function DashboardPanel() {
  const [stats, setStats] = useState<Stats>({ mrr: 0, clients: 0, jobs: 0, agents: 0 });
  const [recent, setRecent] = useState<Client[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      const select = "id, name, initials, sector, location, tier, is_internal";
      const recentIds = getRecentClientIds().slice(0, 3);

      const [mrr, clientCount, jobCount, agentCount, viewed, newest] = await Promise.all([
        supabase.from("mrr_from_billing").select("mrr").maybeSingle(),
        supabase.from("clients").select("id", { count: "exact", head: true }),
        supabase
          .from("job_assignments")
          .select("id", { count: "exact", head: true })
          .is("completed_at", null),
        supabase
          .from("agents")
          .select("agent_key", { count: "exact", head: true })
          .eq("paused", false),
        recentIds.length
          ? supabase.from("clients").select(select).in("id", recentIds)
          : Promise.resolve({ data: [] }),
        // Fallback so the panel is never empty before anything has been opened.
        supabase.from("clients").select(select).order("created_at", { ascending: false }).limit(3),
      ]);
      if (cancelled) return;

      setStats({
        mrr: Number(mrr.data?.mrr ?? 0),
        clients: clientCount.count ?? 0,
        jobs: jobCount.count ?? 0,
        agents: agentCount.count ?? 0,
      });

      // Restore the visit order, which the `in` filter does not preserve.
      const byId = new Map((viewed.data ?? []).map((c) => [c.id, c]));
      const ordered = recentIds.map((id) => byId.get(id)).filter(Boolean) as NonNullable<
        (typeof newest)["data"]
      >;
      const filled = [...ordered];
      for (const c of newest.data ?? []) {
        if (filled.length >= 3) break;
        if (!filled.some((x) => x.id === c.id)) filled.push(c);
      }
      setRecent(filled.map(toClient));
      setLoading(false);
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  const cards = [
    { id: "mrr", label: "MRR", value: stats.mrr.toFixed(2) },
    { id: "clients", label: "Active Clients", value: stats.clients },
    { id: "jobs", label: "Open Jobs", value: stats.jobs },
    { id: "agents", label: "Active Agents", value: stats.agents },
  ];

  return (
    <div className="space-y-6">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {cards.map((c) => (
          <Panel key={c.id} title={c.label}>
            <p className="text-2xl font-semibold text-card-foreground">{c.value}</p>
          </Panel>
        ))}
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-sm font-semibold text-foreground">Recently viewed</h2>
            <Link
              to="/clients"
              className="rounded text-sm text-brand-strong hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              View all
            </Link>
          </div>
          {loading ? (
            <p className="text-sm text-muted-foreground">Loading clients…</p>
          ) : recent.length === 0 ? (
            <EmptyState label="No clients yet" minHeight={160} />
          ) : (
            <div
              className="grid gap-4"
              style={{ gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))" }}
            >
              {recent.map((client) => (
                <ClientCard key={client.id} client={client} />
              ))}
            </div>
          )}
        </div>

        <div>
          <h2 className="mb-3 text-sm font-semibold text-foreground">Quick Links</h2>
          <div className="space-y-2">
            {quickLinks.map((link) => {
              const Icon = link.icon;
              return (
                <Link
                  key={link.id}
                  to={link.path}
                  className="flex items-center gap-3 rounded-lg border border-border bg-card px-4 py-3 text-sm transition-colors hover:border-primary/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
                >
                  <Icon className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                  <span className="flex-1 font-medium text-foreground">{link.label}</span>
                  <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                </Link>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
