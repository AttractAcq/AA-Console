import { useCallback, useEffect, useState } from "react";
import { Panel } from "../../components/Panel";
import { DataTable } from "../../components/DataTable";
import { useAuth } from "../../context/auth";
import { supabase } from "../../lib/supabase";

type Client = {
  name: string;
  sector: string | null;
  location: string | null;
  tier: string | null;
};

type Billing = {
  current_plan: string | null;
  monthly_amount: number | null;
  started_on: string | null;
};

type Contract = { id: string; title: string; signed_at: string | null };
type Step = { id: string; title: string; status: string; display_order: number };
type Member = { name: string; category: string };

const CATEGORY_LABEL: Record<string, string> = {
  smm: "Social media manager",
  editors: "Editor",
  avatars: "Avatar",
};

/**
 * The client's own account page.
 *
 * Scoped to what a client can genuinely read: their own record, billing,
 * contracts and onboarding all have client read policies. The team is the
 * exception — team_members is closed to clients because it carries contact
 * details and engagement terms — so the names come from my_account_team(),
 * which returns a name and a role and nothing else.
 */
export function ClientAccountView({ clientId }: { clientId: string }) {
  const { profile } = useAuth();
  const [client, setClient] = useState<Client | null>(null);
  const [billing, setBilling] = useState<Billing | null>(null);
  const [contracts, setContracts] = useState<Contract[]>([]);
  const [steps, setSteps] = useState<Step[]>([]);
  const [team, setTeam] = useState<Member[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    const [c, b, ct, st, tm] = await Promise.all([
      supabase.from("clients").select("name, sector, location, tier").eq("id", clientId).maybeSingle(),
      supabase
        .from("client_billing")
        .select("current_plan, monthly_amount, started_on")
        .eq("client_id", clientId)
        .maybeSingle(),
      supabase
        .from("client_contracts")
        .select("id, title, signed_at")
        .eq("client_id", clientId)
        .order("signed_at", { ascending: false, nullsFirst: false }),
      supabase
        .from("client_onboarding_steps")
        .select("id, title, status, display_order")
        .eq("client_id", clientId)
        .order("display_order"),
      supabase.rpc("my_account_team"),
    ]);
    setClient((c.data ?? null) as Client | null);
    setBilling((b.data ?? null) as Billing | null);
    setContracts((ct.data ?? []) as Contract[]);
    setSteps((st.data ?? []) as Step[]);
    setTeam((tm.data ?? []) as Member[]);
    setLoading(false);
  }, [clientId]);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading) return <p className="text-sm text-muted-foreground">Loading…</p>;

  const done = steps.filter((s) => s.status === "complete" || s.status === "done").length;
  const money = (v: number | null) => (v === null ? "—" : Number(v).toFixed(2));

  return (
    <div className="space-y-6">
      <div className="grid gap-4 sm:grid-cols-2">
        <Panel title="Your account">
          <dl className="space-y-1.5 text-sm">
            {[
              ["Business", client?.name],
              ["Sector", client?.sector],
              ["Location", client?.location],
            ].map(([label, value]) =>
              value ? (
                <div key={label as string} className="flex gap-2">
                  <dt className="w-24 shrink-0 text-muted-foreground">{label}</dt>
                  <dd className="text-card-foreground">{value}</dd>
                </div>
              ) : null,
            )}
          </dl>
        </Panel>

        <Panel title="Your login">
          <dl className="space-y-1.5 text-sm">
            <div className="flex gap-2">
              <dt className="w-24 shrink-0 text-muted-foreground">Name</dt>
              <dd className="text-card-foreground">{profile?.full_name ?? "—"}</dd>
            </div>
            <div className="flex min-w-0 gap-2">
              <dt className="w-24 shrink-0 text-muted-foreground">Email</dt>
              <dd className="truncate text-card-foreground">{profile?.email ?? "—"}</dd>
            </div>
          </dl>
          <p className="mt-3 text-xs text-muted-foreground">
            To change your password or add someone else from your team, ask your account manager.
          </p>
        </Panel>
      </div>

      <div>
        <h2 className="mb-3 text-sm font-semibold text-foreground">Who works on your account</h2>
        {team.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Nobody is assigned yet. Your account manager will introduce the team here.
          </p>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {team.map((m) => (
              <div key={`${m.category}-${m.name}`} className="rounded-lg border border-border bg-card p-4">
                <p className="text-sm font-medium text-card-foreground">{m.name}</p>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {CATEGORY_LABEL[m.category] ?? m.category}
                </p>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <div>
          <h2 className="mb-3 text-sm font-semibold text-foreground">Plan</h2>
          {billing ? (
            <div className="rounded-lg border border-border bg-card p-4">
              <p className="text-sm font-medium text-card-foreground">
                {billing.current_plan ?? "No plan recorded"}
              </p>
              <p className="mt-1 text-2xl font-semibold text-card-foreground">
                {money(billing.monthly_amount)}
                <span className="ml-1 text-sm font-normal text-muted-foreground">/ month</span>
              </p>
              {billing.started_on && (
                <p className="mt-1 text-xs text-muted-foreground">Since {billing.started_on}</p>
              )}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">
              No billing details on file. Your account manager can add them.
            </p>
          )}
        </div>

        <div>
          <h2 className="mb-3 text-sm font-semibold text-foreground">
            Getting set up{steps.length > 0 ? ` (${done}/${steps.length})` : ""}
          </h2>
          {steps.length === 0 ? (
            <p className="text-sm text-muted-foreground">Nothing outstanding.</p>
          ) : (
            <ul className="space-y-1.5">
              {steps.map((s) => {
                const complete = s.status === "complete" || s.status === "done";
                return (
                  <li key={s.id} className="flex items-center gap-2 text-sm">
                    <span
                      aria-hidden="true"
                      className={
                        complete
                          ? "h-4 w-4 shrink-0 rounded-full bg-primary/20"
                          : "h-4 w-4 shrink-0 rounded-full border border-border"
                      }
                    />
                    <span className={complete ? "text-muted-foreground line-through" : "text-foreground"}>
                      {s.title}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>

      <div>
        <h2 className="mb-3 text-sm font-semibold text-foreground">Agreements</h2>
        <DataTable
          columns={["Document", "Signed"]}
          emptyLabel="No agreements on file yet"
          rows={contracts.map((c) => [c.title, c.signed_at ?? "Not signed"])}
        />
        {/* Contracts live in a private bucket the client has no policy for, so
            the page lists what exists rather than offering a download that
            would fail. */}
        <p className="mt-2 text-xs text-muted-foreground">
          Ask your account manager for a copy of any document listed here.
        </p>
      </div>
    </div>
  );
}
