import { useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";

import { Button } from "../../components/Button";
import { DataTable } from "../../components/DataTable";
import { EmptyState } from "../../components/EmptyState";
import { dayOrDash } from "../../lib/contentRecords";
import { enqueueAgentJob, supabase } from "../../lib/supabase";
import type { Database } from "../../types/database";

type SheetDue = Database["public"]["Views"]["google_ads_sheet_due"]["Row"];
type Sheet = Database["public"]["Tables"]["google_ads_build_sheets"]["Row"];

type Tab = "sheet" | "account" | "build";

/** The sheet's own shape, as the agent writes it. */
interface Derived {
  campaign?: {
    name?: string;
    type?: string;
    daily_budget?: number | null;
    monthly_ceiling?: number | null;
    geography?: string[];
    conversion_action?: string | null;
  };
  keyword_groups?: { name: string; seeds: string[]; match: string; note: string }[];
  negatives?: string[];
  destination?: { url?: string | null };
  offer?: { promise?: string | null };
}

/**
 * Google Ads Studio.
 *
 * There is no Google Ads adapter in this repository, and this page does not
 * pretend otherwise. What it does is the half that can be proven without an
 * account: every object a paid-Google campaign needs, written out from its own
 * package for somebody with Ads Manager access to build by hand.
 *
 * The line it holds is about keyword research. A sheet that turned a service
 * name into "garage conversion portsmouth, exact, 12" and presented it as a
 * plan would be the most expensive kind of plausible output, because somebody
 * would spend against it. So seeds are labelled as seeds, and what the sheet
 * does not know is listed beside what it does.
 */
export function GoogleAdsStudioPanel({ tab }: { tab: Tab }) {
  const { clientId } = useParams<{ clientId: string }>();
  const [due, setDue] = useState<SheetDue[]>([]);
  const [sheets, setSheets] = useState<Sheet[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!clientId) {
      setLoading(false);
      return;
    }
    try {
      const [board, written] = await Promise.all([
        supabase.from("google_ads_sheet_due").select("*").eq("client_id", clientId),
        supabase
          .from("google_ads_build_sheets")
          .select("*")
          .eq("client_id", clientId)
          .order("created_at", { ascending: false })
          .limit(20),
      ]);
      if (board.error) throw new Error(board.error.message);
      if (written.error) throw new Error(written.error.message);
      setDue(board.data ?? []);
      setSheets(written.data ?? []);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not load Google Ads.");
    } finally {
      setLoading(false);
    }
  }, [clientId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function derive(campaignId: string) {
    if (!clientId || busy) return;
    setBusy(campaignId);
    setNotice(null);
    setError(null);
    try {
      await enqueueAgentJob({
        agentKey: "google_ads_sheet",
        clientId,
        inputTable: "client_campaigns",
        inputId: campaignId,
      });
      setNotice("Queued. The sheet reads the campaign and calls nothing.");
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not queue the sheet.");
    } finally {
      setBusy(null);
    }
  }

  const latest = sheets[0];
  const derivedLatest = (latest?.derived ?? {}) as Derived;

  return (
    <div className="space-y-5">
      {notice && <p role="status" className="text-sm text-brand-strong">{notice}</p>}
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}

      {tab === "sheet" && (
        <div className="space-y-4">
          <div className="rounded-lg border border-border bg-card p-4">
            <h3 className="font-semibold">The build a person does by hand</h3>
            <p className="mt-1 text-sm text-muted-foreground">
              There is no Google Ads adapter in this runtime, so a paid-Google campaign is built in
              Ads Manager. This writes out every object from the campaign's own package, so a hand
              build and a later automated one cannot disagree about what was intended. It holds no
              credential, which is why it works precisely when the automated path would not.
            </p>
          </div>

          {due.length === 0 && !loading ? (
            <EmptyState label="No paid Google campaign yet — create one in Campaign Factory" />
          ) : (
            <DataTable
              columns={["Campaign", "Budget", "Geography", "What is stopping it", "Sheet", "Actions"]}
              emptyLabel={loading ? "Loading…" : "Nothing yet"}
              rows={due.map((row) => {
                const ready = row.blocker === null;
                const hasSheet = Boolean(row.sheet_id);
                return [
                  <span key="c">
                    {row.name}
                    {row.campaign_id && clientId && (
                      <Link
                        className="block text-xs text-brand-strong underline"
                        to={`/clients/${clientId}/delivery/campaign-factory/${row.campaign_id}`}
                      >
                        View campaign
                      </Link>
                    )}
                  </span>,
                  <span key="b">{row.daily_budget == null ? "not set" : `${row.daily_budget}/day`}</span>,
                  <span key="g" className="text-xs">
                    {(row.target_countries ?? []).join(", ") || "none"}
                  </span>,
                  <span
                    key="s"
                    className={
                      hasSheet ? "text-brand-strong" : ready ? "text-amber-600" : "text-destructive"
                    }
                  >
                    {row.blocker ?? "Everything it needs is here"}
                  </span>,
                  <span key="v" className="text-xs">
                    {row.sheet_version ? (
                      <>
                        v{row.sheet_version}
                        <span className="block text-muted-foreground">
                          {dayOrDash(row.sheet_created_at)}
                        </span>
                        {(row.missing ?? []).length > 0 && (
                          <span className="block text-destructive">
                            missing: {(row.missing ?? []).join(", ")}
                          </span>
                        )}
                      </>
                    ) : (
                      "none"
                    )}
                  </span>,
                  <span key="x">
                    {row.campaign_id && (
                      <Button
                        disabled={busy === row.campaign_id}
                        onClick={() => void derive(row.campaign_id!)}
                      >
                        {hasSheet ? "Derive again" : "Derive the sheet"}
                      </Button>
                    )}
                  </span>,
                ];
              })}
            />
          )}

          {latest && (
            <section className="rounded-lg border border-border bg-card p-4">
              <h4 className="font-medium">
                Sheet v{latest.version} · {derivedLatest.campaign?.name ?? "a campaign"}
              </h4>
              <dl className="mt-3 grid gap-2 text-xs sm:grid-cols-2">
                <div>
                  <dt className="text-muted-foreground">Budget</dt>
                  <dd>
                    {derivedLatest.campaign?.daily_budget ?? "not set"} daily
                    {derivedLatest.campaign?.monthly_ceiling
                      ? ` · ceiling ${derivedLatest.campaign.monthly_ceiling} per 30 days`
                      : ""}
                  </dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">Conversion action</dt>
                  <dd>{derivedLatest.campaign?.conversion_action ?? "not named"}</dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">Geography</dt>
                  <dd>{(derivedLatest.campaign?.geography ?? []).join(", ") || "none"}</dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">Destination</dt>
                  <dd className="break-all">{derivedLatest.destination?.url ?? "no page attached"}</dd>
                </div>
              </dl>

              <p className="mt-4 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                Search intent groups
              </p>
              {(derivedLatest.keyword_groups ?? []).length === 0 ? (
                <p className="mt-1 text-xs text-destructive">
                  Nothing to seed from — the campaign has no content pillars and no signed offer.
                </p>
              ) : (
                <ul className="mt-1 space-y-2 text-xs">
                  {(derivedLatest.keyword_groups ?? []).map((group) => (
                    <li key={group.name}>
                      <span className="font-medium">{group.name}</span> ({group.match}):{" "}
                      {group.seeds.join(" · ")}
                      <span className="block text-muted-foreground">{group.note}</span>
                    </li>
                  ))}
                </ul>
              )}

              <p className="mt-3 text-xs text-muted-foreground">
                Negatives ({(derivedLatest.negatives ?? []).length}):{" "}
                {(derivedLatest.negatives ?? []).join(", ")}
              </p>

              {(latest.missing ?? []).length > 0 && (
                <p className="mt-3 border-t border-border pt-3 text-xs text-destructive">
                  Still needed before this is a plan: {(latest.missing ?? []).join(", ")}.{" "}
                  <span className="text-muted-foreground">
                    Seeds are a starting point for research, not research — a sheet that says what
                    it does not know is worth more than one that reads complete.
                  </span>
                </p>
              )}
            </section>
          )}
        </div>
      )}

      {tab === "account" && (
        <div className="space-y-4">
          <div className="rounded-lg border border-border bg-card p-4">
            <h3 className="font-semibold">Account</h3>
            {due.some((row) => row.google_account) ? (
              <p className="mt-2 text-sm">
                Google account on file:{" "}
                <code className="text-xs">
                  {due.find((row) => row.google_account)?.google_account}
                </code>
                <span className="mt-1 block text-xs text-muted-foreground">
                  Recorded for reference only. Nothing in this runtime calls the Google Ads API, so
                  this credential is not used to build anything.
                </span>
              </p>
            ) : (
              <p className="mt-2 text-sm text-muted-foreground">
                No Google credential is recorded. Add one on the Integrations page if you want the
                account id to appear on the sheet — the sheet works without it, because a hand
                build is wanted precisely when the credential is missing.
              </p>
            )}
          </div>
        </div>
      )}

      {tab === "build" && (
        <div className="space-y-4">
          <div className="rounded-lg border border-border bg-card p-4">
            <h3 className="font-semibold">Automated build</h3>
            <p className="mt-2 text-sm text-muted-foreground">
              Not built, and this page says so rather than offering a button that would fail.
              <code className="mx-1 text-xs">google_ad_build</code> is a reserved action with no
              executor: the approval ledger and the execution gate both exist, so what is missing
              is the Google adapter itself, and the honest order is a sheet first.
            </p>
            <p className="mt-2 text-sm text-muted-foreground">
              Its acceptance gate is a real account: draft and build, exact approval, object
              creation, activation as a separate decision, change control, and measured outcomes
              with reliable external ids and spend limits. None of that can be proven from here.
            </p>
            <p className="mt-2 text-sm text-muted-foreground">
              Meta's path is the template — three approvals, paused objects first, activation never
              a side effect of a build.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
