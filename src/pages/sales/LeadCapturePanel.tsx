import { useCallback, useEffect, useMemo, useState } from "react";
import { useParams } from "react-router-dom";

import { Button } from "../../components/Button";
import { DataTable } from "../../components/DataTable";
import { ActionMenu } from "../../components/ActionMenu";
import { FormModal } from "../../components/forms/FormModal";
import { dayOrDash } from "../../lib/contentRecords";
import { supabase } from "../../lib/supabase";
import {
  CAPTURE_PURPOSES,
  createEndpoint, fetchCapturedLeads, fetchEndpoints, fetchSubmissions, setEndpointEnabled,
  type CapturedLead, type CaptureDue, type CaptureEndpoint, type LeadSubmission,
} from "../../lib/leadCapture";

/**
 * Sales OS v2 — Capture.
 *
 * v1's pipeline is complete and operable, and every lead in it was typed in
 * by somebody. So the column that matters most — where this person came from
 * — was blank by construction, and "which campaign produced that sale" had
 * no answer that did not involve somebody remembering.
 *
 * This is the surface the lead capture spine pays off in. Three things, in
 * the order a person asks them:
 *
 *   Who arrived, and what we can prove about why they did
 *   Where they can arrive from, and which of those doors is open
 *   What came in that did not become a new lead, and what happened instead
 *
 * The pipeline and the agent builder are untouched, on their own tabs.
 */

export function LeadCapturePanel() {
  const { clientId } = useParams<{ clientId: string }>();
  const [leads, setLeads] = useState<CapturedLead[]>([]);
  const [endpoints, setEndpoints] = useState<CaptureEndpoint[]>([]);
  const [due, setDue] = useState<ReadonlyMap<string, CaptureDue>>(new Map());
  const [submissions, setSubmissions] = useState<LeadSubmission[]>([]);
  const [campaigns, setCampaigns] = useState<{ id: string; name: string }[]>([]);
  const [pages, setPages] = useState<{ id: string; title: string | null }[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [opening, setOpening] = useState(false);
  const [issued, setIssued] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!clientId) {
      setLoading(false);
      return;
    }
    try {
      const [captured, ends, subs, camps, pgs] = await Promise.all([
        fetchCapturedLeads(clientId),
        fetchEndpoints(clientId),
        fetchSubmissions(clientId),
        supabase
          .from("client_campaigns")
          .select("id, name")
          .eq("client_id", clientId)
          .is("archived_at", null)
          .order("created_at", { ascending: false }),
        supabase
          .from("client_pages")
          .select("id, title")
          .eq("client_id", clientId)
          .order("created_at", { ascending: false }),
      ]);
      setLeads(captured);
      setEndpoints(ends.endpoints);
      setDue(ends.due);
      setSubmissions(subs);
      setCampaigns((camps.data ?? []) as { id: string; name: string }[]);
      setPages((pgs.data ?? []) as { id: string; title: string | null }[]);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not load captured leads.");
    } finally {
      setLoading(false);
    }
  }, [clientId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function act(key: string, work: () => Promise<void>, said: string) {
    if (busy) return;
    setBusy(key);
    setNotice(null);
    setError(null);
    try {
      await work();
      setNotice(said);
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Something went wrong.");
    } finally {
      setBusy(null);
    }
  }

  const campaignName = (id: string | null) =>
    id ? (campaigns.find((c) => c.id === id)?.name ?? "A campaign") : null;

  /**
   * How many submissions each lead has.
   *
   * More than one is a returning person rather than a duplicate, and saying
   * so is the point: the deduplication is invisible otherwise, and somebody
   * would eventually "fix" it by creating a second lead.
   */
  const touches = useMemo(() => {
    const counts = new Map<string, number>();
    for (const submission of submissions) {
      if (!submission.lead_id) continue;
      counts.set(submission.lead_id, (counts.get(submission.lead_id) ?? 0) + 1);
    }
    return counts;
  }, [submissions]);

  /** Submissions that did not create a lead: merged, or refused. */
  const unpromoted = submissions.filter((s) => s.status !== "promoted");

  const open = endpoints.filter((e) => !due.get(e.id)?.blocker).length;

  return (
    <div className="space-y-5">
      {notice && <p role="status" className="text-sm text-brand-strong">{notice}</p>}
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      {issued && (
        <div className="rounded-lg border border-brand-strong/40 bg-brand-subtle/30 p-4">
          <p className="text-sm font-medium">Capture link — copy it now</p>
          <p className="mt-1 text-xs text-muted-foreground">
            Only its hash is stored, so this is the one time the token can be read. Put it in the
            form that will post to it; losing it means opening a new endpoint.
          </p>
          <code className="mt-2 block break-all rounded bg-muted p-2 text-xs">{issued}</code>
          <Button className="mt-2" onClick={() => setIssued(null)}>I have it</Button>
        </div>
      )}

      <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-card p-4">
        <div>
          <p className="text-sm font-medium">
            {leads.length} lead{leads.length === 1 ? "" : "s"} arrived from outside ·{" "}
            {open} of {endpoints.length} door{endpoints.length === 1 ? "" : "s"} open
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            Counted by recorded consent rather than by a source string: a lead somebody typed in
            from a phone call has a source too, and never saw a form.
          </p>
        </div>
        <Button onClick={() => setOpening(true)}>Open a capture link</Button>
      </div>

      <section className="space-y-2">
        <h3 className="font-semibold">Who arrived</h3>
        <DataTable
          columns={["Who", "Came from", "Consent", "Touches", "Stage", "When"]}
          emptyLabel={loading ? "Loading leads…" : "Nobody has arrived from outside yet"}
          rows={leads.map((lead) => [
            <span key="w">
              {lead.name ?? "No name given"}
              <span className="block text-xs text-muted-foreground">{lead.email ?? lead.phone}</span>
            </span>,
            <span key="f" className="text-xs">
              {lead.source_channel ?? lead.source ?? "unrecorded"}
              {campaignName(lead.source_client_campaign_id) && (
                <span className="block text-muted-foreground">
                  {campaignName(lead.source_client_campaign_id)}
                </span>
              )}
              {lead.source_click_id && (
                <span className="block font-mono text-muted-foreground">
                  {lead.source_click_id.slice(0, 18)}
                </span>
              )}
            </span>,
            <span key="c" className="text-xs">
              <span className="text-brand-strong">{dayOrDash(lead.consent_given_at)}</span>
              {lead.consent_wording && (
                <span className="block text-muted-foreground">
                  {lead.consent_wording.slice(0, 48)}
                  {lead.consent_wording.length > 48 ? "…" : ""}
                </span>
              )}
            </span>,
            <span key="t">
              {touches.get(lead.id) ?? 1}
              {(touches.get(lead.id) ?? 1) > 1 && (
                <span className="block text-xs text-muted-foreground">returning</span>
              )}
            </span>,
            <span key="s">{lead.stage.replace(/_/g, " ")}</span>,
            <span key="d">{dayOrDash(lead.created_at)}</span>,
          ])}
        />
      </section>

      <section className="space-y-2">
        <h3 className="font-semibold">Where they can arrive from</h3>
        <DataTable
          columns={["Purpose", "Attributed to", "What is stopping it", "Used", "Actions"]}
          emptyLabel={loading ? "Loading links…" : "No capture links yet"}
          rows={endpoints.map((endpoint) => {
            const blocker = due.get(endpoint.id)?.blocker ?? null;
            return [
              <span key="p">
                {endpoint.purpose.replace(/_/g, " ")}
                {endpoint.purpose === "magnet_optin" && !endpoint.magnet_version_id && (
                  <span className="block text-xs text-destructive">
                    Promises a magnet but names no version.
                  </span>
                )}
              </span>,
              <span key="c" className="text-xs">
                {campaignName(endpoint.campaign_id) ?? "No campaign"}
                <span className="block text-muted-foreground">
                  {endpoint.source_channel ?? "no channel recorded"}
                </span>
              </span>,
              <span key="b" className={blocker ? "text-destructive" : "text-brand-strong"}>
                {blocker ?? "Taking submissions"}
              </span>,
              <span key="u">
                {endpoint.submissions} / {endpoint.max_submissions}
                <span className="block text-xs text-muted-foreground">
                  expires {dayOrDash(endpoint.expires_at)}
                </span>
              </span>,
              <ActionMenu
                key="a"
                name={endpoint.purpose.replace(/_/g, " ")}
                busy={busy === endpoint.id}
                items={[
                  {
                    label: endpoint.enabled ? "Switch off" : "Switch on",
                    onSelect: () =>
                      void act(
                        endpoint.id,
                        () => setEndpointEnabled(endpoint.id, !endpoint.enabled),
                        endpoint.enabled ? "Switched off." : "Switched on.",
                      ),
                  },
                ]}
              />,
            ];
          })}
        />
      </section>

      {unpromoted.length > 0 && (
        <section className="space-y-2">
          <h3 className="font-semibold">Came in without creating a lead</h3>
          <p className="text-sm text-muted-foreground">
            Kept deliberately. A submission that merged into an existing lead still happened, and
            "did this person ever contact us" has to stay answerable.
          </p>
          <DataTable
            columns={["When", "Who", "What happened"]}
            emptyLabel="Nothing"
            rows={unpromoted.map((s) => [
              <span key="w">{dayOrDash(s.created_at)}</span>,
              <span key="n">{s.email ?? s.phone ?? "no contact given"}</span>,
              <span key="h" className="text-xs">
                {s.status}
                {s.rejected_reason && (
                  <span className="block text-destructive">{s.rejected_reason}</span>
                )}
              </span>,
            ])}
          />
        </section>
      )}

      <FormModal
        open={opening}
        onClose={() => setOpening(false)}
        title="Open a capture link"
        submitLabel="Open it"
        intro="A door into this client's pipeline. It opens switched off, with an expiry and a submission ceiling, and the token is shown once."
        fields={[
          {
            name: "purpose", label: "What it is for", kind: "select", required: true,
            options: CAPTURE_PURPOSES.map((p) => ({ value: p.value, label: p.label })),
            hint: "A magnet opt-in promises a file, so open those from Lead Magnet Studio where the version can be named.",
          },
          {
            name: "consent_wording", label: "What they are agreeing to", kind: "textarea",
            required: true, rows: 3,
            hint: "Stored verbatim with every lead captured here. Changing it later is a new endpoint, because the people already captured agreed to these words.",
          },
          {
            name: "campaign_id", label: "Attribute to campaign", kind: "select",
            options: [
              { value: "", label: "No campaign" },
              ...campaigns.map((c) => ({ value: c.id, label: c.name })),
            ],
          },
          {
            name: "page_id", label: "On which page", kind: "select",
            options: [
              { value: "", label: "Not a page" },
              ...pages.map((p) => ({ value: p.id, label: p.title ?? p.id.slice(0, 8) })),
            ],
          },
          { name: "source_channel", label: "Source channel", kind: "text", placeholder: "paid_search" },
          { name: "days", label: "Valid for (days)", kind: "number", placeholder: "90" },
        ]}
        onSubmit={async (values) => {
          if (!clientId) throw new Error("No client selected.");
          const purpose = String(values.purpose);
          if (purpose !== "page_form" && purpose !== "agent_handoff" && purpose !== "magnet_optin") {
            throw new Error("Choose what the link is for.");
          }
          const result = await createEndpoint({
            clientId,
            purpose,
            consentWording: String(values.consent_wording),
            campaignId: values.campaign_id ? String(values.campaign_id) : null,
            pageId: values.page_id ? String(values.page_id) : null,
            sourceChannel: values.source_channel ? String(values.source_channel) : null,
            days: values.days ? Number(values.days) : undefined,
          });
          setIssued(result.token);
          setNotice("Opened, and switched off until you turn it on.");
        }}
        onSaved={() => {
          setOpening(false);
          void refresh();
        }}
      />
    </div>
  );
}
