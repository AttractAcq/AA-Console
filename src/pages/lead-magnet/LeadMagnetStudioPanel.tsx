import { useCallback, useEffect, useState } from "react";
import { useParams } from "react-router-dom";

import { Button } from "../../components/Button";
import { DataTable } from "../../components/DataTable";
import { ActionMenu } from "../../components/ActionMenu";
import { EmptyState } from "../../components/EmptyState";
import { FormModal } from "../../components/forms/FormModal";
import { dayOrDash } from "../../lib/contentRecords";
import { supabase } from "../../lib/supabase";
import {
  CHANNEL_HINT, MAGNET_FORMATS,
  addVersion, createEndpoint, createMagnet, decideApproval, fetchApprovals,
  fetchDeliveriesDue, fetchDeliverySwitch, fetchEndpoints, fetchMagnets,
  fetchSubmissions, fetchVersions, requestApproval, revokeApproval,
  setDeliveryEnabled, setEndpointEnabled,
  type CaptureDue, type CaptureEndpoint, type LeadMagnet, type LeadMagnetApproval,
  type LeadMagnetDue, type LeadMagnetVersion, type LeadSubmission,
} from "../../lib/leadMagnets";

/**
 * Lead Magnet Studio.
 *
 * The one place in this system that makes a promise directly to a stranger:
 * hand over your email address and you will get this file. Everything on
 * this page exists to make that promise keepable.
 *
 * Four tabs, and they are four questions:
 *
 *   Magnets   what we offer, and which version of it is live
 *   Build     the file and the words that carry it
 *   Delivery  what has gone, what has not, and why not
 *   Opt-ins   where people can ask for it, and who did
 *
 * The thing the layout is built to keep visible is that an approval is given
 * against a version rather than against a magnet. A magnet with three
 * versions where the second is approved is the normal case, not an error,
 * and a screen that showed only "approved" would hide which bytes that
 * referred to.
 */

type Tab = "magnets" | "build" | "delivery" | "optins";

export function LeadMagnetStudioPanel({ tab }: { tab: Tab }) {
  const { clientId } = useParams<{ clientId: string }>();
  const [magnets, setMagnets] = useState<LeadMagnet[]>([]);
  const [versions, setVersions] = useState<LeadMagnetVersion[]>([]);
  const [approvals, setApprovals] = useState<LeadMagnetApproval[]>([]);
  const [due, setDue] = useState<LeadMagnetDue[]>([]);
  const [endpoints, setEndpoints] = useState<CaptureEndpoint[]>([]);
  const [endpointDue, setEndpointDue] = useState<ReadonlyMap<string, CaptureDue>>(new Map());
  const [submissions, setSubmissions] = useState<LeadSubmission[]>([]);
  const [campaigns, setCampaigns] = useState<{ id: string; name: string }[]>([]);
  const [deliveryOn, setDeliveryOn] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [building, setBuilding] = useState(false);
  const [versioning, setVersioning] = useState<LeadMagnet | null>(null);
  const [opening, setOpening] = useState<LeadMagnetVersion | null>(null);
  /** Shown once, because only the hash is stored. */
  const [issued, setIssued] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!clientId) {
      setLoading(false);
      return;
    }
    try {
      const [m, v, a, d, e, s, on, camps] = await Promise.all([
        fetchMagnets(clientId),
        fetchVersions(clientId),
        fetchApprovals(clientId),
        fetchDeliveriesDue(clientId),
        fetchEndpoints(clientId),
        fetchSubmissions(clientId),
        fetchDeliverySwitch(clientId),
        supabase
          .from("client_campaigns")
          .select("id, name")
          .eq("client_id", clientId)
          .is("archived_at", null)
          .order("created_at", { ascending: false }),
      ]);
      setMagnets(m);
      setVersions(v);
      setApprovals(a);
      setDue(d);
      setEndpoints(e.endpoints);
      setEndpointDue(e.due);
      setSubmissions(s);
      setDeliveryOn(on);
      setCampaigns((camps.data ?? []) as { id: string; name: string }[]);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not load lead magnets.");
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

  /** The live approval for a version, where there is one. */
  const liveApproval = (versionId: string) =>
    approvals.find((a) => a.magnet_version_id === versionId && a.status === "approved");
  const pendingApproval = (versionId: string) =>
    approvals.find((a) => a.magnet_version_id === versionId && a.status === "pending");
  const versionsOf = (magnetId: string) =>
    versions.filter((v) => v.magnet_id === magnetId).sort((a, b) => b.version - a.version);
  const magnetName = (magnetId: string) =>
    magnets.find((m) => m.id === magnetId)?.name ?? "Untitled magnet";
  const campaignName = (id: string | null) =>
    id ? (campaigns.find((c) => c.id === id)?.name ?? "A campaign") : null;

  if (error && magnets.length === 0 && endpoints.length === 0 && !loading) {
    return (
      <div role="alert" className="space-y-2">
        <p className="text-sm text-destructive">{error}</p>
        <Button onClick={() => void refresh()}>Retry</Button>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      {notice && <p role="status" className="text-sm text-brand-strong">{notice}</p>}
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      {issued && (
        <div className="rounded-lg border border-brand-strong/40 bg-brand-subtle/30 p-4">
          <p className="text-sm font-medium">Capture link — copy it now</p>
          <p className="mt-1 text-xs text-muted-foreground">
            Only the hash of this token is stored, so this is the one time it can be read. Losing
            it means opening a new endpoint rather than recovering this one.
          </p>
          <code className="mt-2 block break-all rounded bg-muted p-2 text-xs">{issued}</code>
          <Button className="mt-2" onClick={() => setIssued(null)}>I have it</Button>
        </div>
      )}

      {tab === "magnets" && (
        <MagnetsTab
          magnets={magnets}
          loading={loading}
          versionsOf={versionsOf}
          liveApproval={liveApproval}
          pendingApproval={pendingApproval}
          campaignName={campaignName}
          submissions={submissions}
          endpoints={endpoints}
          busy={busy}
          onNewVersion={setVersioning}
          onAct={act}
        />
      )}

      {tab === "build" && (
        <div className="space-y-4">
          <div className="rounded-lg border border-border bg-card p-4">
            <h3 className="font-semibold">Build a magnet</h3>
            <p className="mt-1 text-sm text-muted-foreground">
              A magnet is what the client offers. The file is a version of it, and every new file
              is a new version — there is no editing one, because an approval names the hash of
              the bytes and the database will not let that row change underneath it.
            </p>
            <div className="mt-3 flex flex-wrap gap-2">
              <Button onClick={() => setBuilding(true)}>New magnet</Button>
              {magnets.length > 0 && (
                <Button onClick={() => setVersioning(magnets[0]!)}>Add a version</Button>
              )}
            </div>
          </div>
          {magnets.length === 0 && !loading && (
            <EmptyState label="No magnets yet — start with what the client already gives people" />
          )}
          {magnets.map((m) => (
            <section key={m.id} className="rounded-lg border border-border bg-card p-4">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div>
                  <h4 className="font-medium">{m.name}</h4>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {MAGNET_FORMATS.find((f) => f.value === m.format)?.label ?? m.format}
                    {campaignName(m.campaign_id) ? ` · ${campaignName(m.campaign_id)}` : " · evergreen"}
                  </p>
                </div>
                <Button onClick={() => setVersioning(m)}>New version</Button>
              </div>
              <p className="mt-2 text-sm">{m.objective}</p>
              {versionsOf(m.id).length === 0 ? (
                <p className="mt-3 text-xs text-destructive">
                  No file yet. Nothing can be promised until there is one.
                </p>
              ) : (
                <ul className="mt-3 space-y-1 text-xs">
                  {versionsOf(m.id).map((v) => {
                    const live = liveApproval(v.id);
                    const pending = pendingApproval(v.id);
                    return (
                      <li key={v.id} className="flex flex-wrap items-center gap-2">
                        <span className="font-medium">v{v.version}</span>
                        <span className="text-muted-foreground">
                          {(v.file_bytes / 1024).toFixed(0)} KB · {v.delivery_channel.replace("_", " ")}
                        </span>
                        <code className="text-muted-foreground">{v.content_sha256.slice(0, 12)}…</code>
                        <span
                          className={
                            live ? "text-brand-strong" : pending ? "text-amber-600" : "text-muted-foreground"
                          }
                        >
                          {live ? "approved" : pending ? "awaiting approval" : "not asked"}
                        </span>
                      </li>
                    );
                  })}
                </ul>
              )}
            </section>
          ))}
        </div>
      )}

      {tab === "delivery" && (
        <DeliveryTab
          clientId={clientId}
          deliveryOn={deliveryOn}
          due={due}
          approvals={approvals}
          versions={versions}
          magnetName={magnetName}
          busy={busy}
          loading={loading}
          onAct={act}
        />
      )}

      {tab === "optins" && (
        <OptInsTab
          endpoints={endpoints}
          endpointDue={endpointDue}
          submissions={submissions}
          versions={versions}
          magnetName={magnetName}
          campaignName={campaignName}
          busy={busy}
          loading={loading}
          onOpen={setOpening}
          onAct={act}
        />
      )}

      <FormModal
        open={building}
        onClose={() => setBuilding(false)}
        title="New lead magnet"
        submitLabel="Create"
        intro="What the client offers in exchange for contact details. The file comes next, as its first version."
        fields={[
          { name: "name", label: "Name", kind: "text", required: true },
          {
            name: "objective", label: "What it is for", kind: "textarea", required: true, rows: 3,
            hint: "A magnet without a stated objective is a PDF. This is the sentence the planner and the QA read.",
          },
          { name: "audience", label: "Who it is for", kind: "text" },
          {
            name: "format", label: "Format", kind: "select", required: true,
            options: MAGNET_FORMATS.map((f) => ({ value: f.value, label: f.label })),
          },
          {
            name: "campaign_id", label: "Campaign", kind: "select",
            options: [
              { value: "", label: "Evergreen — no campaign" },
              ...campaigns.map((c) => ({ value: c.id, label: c.name })),
            ],
            hint: "A magnet bound to a campaign is scoped by that campaign's package. Evergreen is a legitimate thing to have.",
          },
        ]}
        onSubmit={async (values) => {
          if (!clientId) throw new Error("No client selected.");
          await createMagnet({
            clientId,
            name: String(values.name),
            objective: String(values.objective),
            audience: values.audience ? String(values.audience) : null,
            format: String(values.format),
            campaignId: values.campaign_id ? String(values.campaign_id) : null,
          });
          setNotice("Created. Add the file as its first version.");
        }}
        onSaved={() => {
          setBuilding(false);
          void refresh();
        }}
      />

      <FormModal
        open={versioning !== null}
        onClose={() => setVersioning(null)}
        title={versioning ? `New version of ${versioning.name}` : "New version"}
        submitLabel="Upload"
        intro="The file, and the words that carry it. Both are hashed together: changing either afterwards means asking for approval again, which is the point."
        fields={[
          {
            name: "magnet_id", label: "Magnet", kind: "select", required: true,
            options: magnets.map((m) => ({ value: m.id, label: m.name })),
          },
          { name: "file", label: "File", kind: "file", required: true },
          {
            name: "channel", label: "How it reaches them", kind: "select", required: true,
            options: [
              { value: "email", label: "Email with the file attached" },
              { value: "download_link", label: "Download at opt-in" },
            ],
            hint: CHANNEL_HINT.email,
          },
          {
            name: "subject", label: "Subject", kind: "text",
            showIf: { field: "channel", equals: ["email"] },
          },
          {
            name: "body", label: "Message", kind: "textarea", rows: 4,
            showIf: { field: "channel", equals: ["email"] },
          },
        ]}
        initialValues={versioning ? { magnet_id: versioning.id } : undefined}
        onSubmit={async (values) => {
          if (!clientId) throw new Error("No client selected.");
          const file = values.file;
          if (!(file instanceof File)) throw new Error("Choose a file.");
          await addVersion({
            clientId,
            magnetId: String(values.magnet_id),
            file,
            channel: values.channel === "download_link" ? "download_link" : "email",
            subject: values.subject ? String(values.subject) : null,
            body: values.body ? String(values.body) : null,
          });
          setNotice("Uploaded. Ask for approval when the file is right.");
        }}
        onSaved={() => {
          setVersioning(null);
          void refresh();
        }}
      />

      <FormModal
        open={opening !== null}
        onClose={() => setOpening(null)}
        title="Open a capture link"
        submitLabel="Open it"
        intro="Where people can ask for this magnet. It opens switched off, with an expiry and a submission ceiling, and the token is shown once."
        fields={[
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
          { name: "source_channel", label: "Source channel", kind: "text", placeholder: "paid_social" },
          { name: "days", label: "Valid for (days)", kind: "number", placeholder: "90" },
        ]}
        onSubmit={async (values) => {
          if (!clientId || !opening) throw new Error("No magnet version selected.");
          const result = await createEndpoint({
            clientId,
            purpose: "magnet_optin",
            consentWording: String(values.consent_wording),
            campaignId: values.campaign_id ? String(values.campaign_id) : null,
            sourceChannel: values.source_channel ? String(values.source_channel) : null,
            magnetVersionId: opening.id,
            days: values.days ? Number(values.days) : undefined,
          });
          setIssued(result.token);
          setNotice("Opened, and switched off until you turn it on.");
        }}
        onSaved={() => {
          setOpening(null);
          void refresh();
        }}
      />
    </div>
  );
}

function MagnetsTab({
  magnets, loading, versionsOf, liveApproval, pendingApproval, campaignName,
  submissions, endpoints, busy, onNewVersion, onAct,
}: {
  magnets: LeadMagnet[];
  loading: boolean;
  versionsOf: (id: string) => LeadMagnetVersion[];
  liveApproval: (versionId: string) => LeadMagnetApproval | undefined;
  pendingApproval: (versionId: string) => LeadMagnetApproval | undefined;
  campaignName: (id: string | null) => string | null;
  submissions: LeadSubmission[];
  endpoints: CaptureEndpoint[];
  busy: string | null;
  onNewVersion: (magnet: LeadMagnet) => void;
  onAct: (key: string, work: () => Promise<void>, said: string) => Promise<void>;
}) {
  if (!loading && magnets.length === 0) {
    return <EmptyState label="No magnets yet — build one on the Build tab" />;
  }

  /** How many people opted in through a form promising this magnet. */
  const optInsFor = (magnetId: string) => {
    const versionIds = new Set(versionsOf(magnetId).map((v) => v.id));
    const theirs = new Set(
      endpoints.filter((e) => e.magnet_version_id && versionIds.has(e.magnet_version_id)).map((e) => e.id),
    );
    return submissions.filter((s) => theirs.has(s.endpoint_id)).length;
  };

  return (
    <DataTable
      columns={["Magnet", "Live version", "State", "What is stopping it", "Opt-ins", "Actions"]}
      emptyLabel={loading ? "Loading magnets…" : "No magnets yet"}
      rows={magnets.map((magnet) => {
        const all = versionsOf(magnet.id);
        const live = all.find((v) => liveApproval(v.id));
        const pending = all.find((v) => pendingApproval(v.id));
        const newest = all[0];
        const blocker =
          all.length === 0
            ? "No file has been uploaded yet."
            : live
              ? null
              : pending
                ? "Waiting for a person to approve it."
                : "Nobody has been asked to approve it.";
        return [
          <span key="n">
            {magnet.name}
            <span className="block text-xs text-muted-foreground">
              {campaignName(magnet.campaign_id) ?? "Evergreen"}
            </span>
          </span>,
          <span key="v">{live ? `v${live.version}` : "—"}</span>,
          <span key="s" className={live ? "text-brand-strong" : "text-muted-foreground"}>
            {live ? "live" : pending ? "awaiting approval" : "draft"}
          </span>,
          <span key="b" className={blocker ? "text-destructive" : "text-brand-strong"}>
            {blocker ?? "Nothing"}
          </span>,
          <span key="o">{optInsFor(magnet.id)}</span>,
          <ActionMenu
            key="a"
            name={magnet.name}
            busy={busy === magnet.id}
            items={[
              { label: "New version", onSelect: () => onNewVersion(magnet) },
              ...(newest && !liveApproval(newest.id) && !pendingApproval(newest.id)
                ? [{
                    label: `Ask for approval of v${newest.version}`,
                    onSelect: () =>
                      void onAct(magnet.id, () => requestApproval(newest.id), "Sent for approval."),
                  }]
                : []),
            ]}
          />,
        ];
      })}
    />
  );
}

function DeliveryTab({
  clientId, deliveryOn, due, approvals, versions, magnetName, busy, loading, onAct,
}: {
  clientId: string | undefined;
  deliveryOn: boolean;
  due: LeadMagnetDue[];
  approvals: LeadMagnetApproval[];
  versions: LeadMagnetVersion[];
  magnetName: (id: string) => string;
  busy: string | null;
  loading: boolean;
  onAct: (key: string, work: () => Promise<void>, said: string) => Promise<void>;
}) {
  const pending = approvals.filter((a) => a.status === "pending");
  const live = approvals.filter((a) => a.status === "approved");
  const versionOf = (id: string) => versions.find((v) => v.id === id);

  return (
    <div className="space-y-5">
      {/* The switch this screen owns. Approving a magnet and letting the
          runtime send it are two separate acts: one is about the file, the
          other is about whether a machine may email strangers at all. */}
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-card p-4">
        <div>
          <p className="text-sm font-medium">
            Magnet delivery is {deliveryOn ? "on" : "off"} for this client
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            {deliveryOn
              ? "Approved magnets are sent to people who opt in. Each file is re-hashed immediately before it goes."
              : "Nothing is sent while this is off. Opt-ins are still captured and still owe a file."}
          </p>
        </div>
        <Button
          disabled={!clientId || busy === "switch"}
          onClick={() => {
            if (!clientId) return;
            void onAct(
              "switch",
              () => setDeliveryEnabled(clientId, !deliveryOn),
              deliveryOn ? "Delivery switched off." : "Delivery switched on.",
            );
          }}
        >
          {deliveryOn ? "Switch off" : "Switch on"}
        </Button>
      </div>

      <section className="space-y-3">
        <div>
          <h3 className="font-semibold">Waiting on a person</h3>
          <p className="mt-1 text-sm text-muted-foreground">
            One decision covers the file and the words together. Re-export either and this is
            asked again.
          </p>
        </div>
        {pending.length === 0 ? (
          <p className="text-sm text-muted-foreground">Nothing is waiting for approval.</p>
        ) : (
          pending.map((approval) => {
            const version = versionOf(approval.magnet_version_id);
            const scope = (approval.scope ?? {}) as Record<string, unknown>;
            return (
              <article key={approval.id} className="rounded-lg border border-border bg-card p-4">
                <h4 className="font-medium">
                  {version ? `${magnetName(version.magnet_id)} v${version.version}` : "A magnet version"}
                </h4>
                <dl className="mt-3 grid gap-2 text-xs sm:grid-cols-2">
                  <div>
                    <dt className="text-muted-foreground">File</dt>
                    <dd className="break-all font-mono">{String(scope.file ?? "—")}</dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground">Bytes approved</dt>
                    <dd className="break-all font-mono">{approval.payload_hash.slice(0, 24)}…</dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground">Route</dt>
                    <dd>{String(scope.channel ?? "—")}</dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground">Subject</dt>
                    <dd>{String(scope.subject ?? "—")}</dd>
                  </div>
                </dl>
                {version?.delivery_body && (
                  <pre className="mt-3 max-h-40 overflow-auto rounded bg-muted p-3 text-xs">
                    {version.delivery_body}
                  </pre>
                )}
                <div className="mt-3 flex flex-wrap gap-2">
                  <Button
                    disabled={busy === approval.id}
                    onClick={() =>
                      void onAct(approval.id, () => decideApproval(approval.id, true), "Approved.")
                    }
                  >
                    Approve this file and route
                  </Button>
                  <Button
                    disabled={busy === approval.id}
                    onClick={() => {
                      const why = window.prompt("Why is this not going out?");
                      if (why?.trim()) {
                        void onAct(
                          approval.id,
                          () => decideApproval(approval.id, false, why.trim()),
                          "Rejected.",
                        );
                      }
                    }}
                  >
                    Reject
                  </Button>
                </div>
              </article>
            );
          })
        )}
      </section>

      {live.length > 0 && (
        <section className="space-y-2">
          <h3 className="font-semibold">Live magnets</h3>
          {live.map((approval) => {
            const version = versionOf(approval.magnet_version_id);
            return (
              <div
                key={approval.id}
                className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border bg-card p-3 text-sm"
              >
                <span>
                  {version ? `${magnetName(version.magnet_id)} v${version.version}` : "A magnet"}
                  <span className="block text-xs text-muted-foreground">
                    approved {dayOrDash(approval.decided_at)}
                  </span>
                </span>
                <Button
                  disabled={busy === approval.id}
                  onClick={() => {
                    const why = window.prompt("Why is it coming down?");
                    if (why?.trim()) {
                      void onAct(
                        approval.id,
                        () => revokeApproval(approval.id, why.trim()),
                        "Revoked. Anything not yet sent is cancelled.",
                      );
                    }
                  }}
                >
                  Revoke
                </Button>
              </div>
            );
          })}
        </section>
      )}

      <section className="space-y-2">
        <h3 className="font-semibold">What is owed</h3>
        <DataTable
          columns={["Magnet", "To", "Status", "What is stopping it", "Reference"]}
          emptyLabel={loading ? "Loading…" : "Nobody is owed a magnet"}
          rows={due.map((row) => [
            <span key="m">{row.magnet_name}</span>,
            <span key="r">{row.recipient}</span>,
            <span key="s">
              {row.status?.replace(/_/g, " ")}
              {(row.attempts ?? 0) > 0 && (
                <span className="block text-xs text-muted-foreground">
                  {row.attempts} attempt{row.attempts === 1 ? "" : "s"}
                </span>
              )}
            </span>,
            <span key="b" className={row.blocker ? "text-destructive" : "text-brand-strong"}>
              {row.blocker ?? "Going out next sweep"}
            </span>,
            <span key="p" className="font-mono text-xs">
              {row.provider_ref ?? "—"}
            </span>,
          ])}
        />
      </section>
    </div>
  );
}

function OptInsTab({
  endpoints, endpointDue, submissions, versions, magnetName, campaignName,
  busy, loading, onOpen, onAct,
}: {
  endpoints: CaptureEndpoint[];
  endpointDue: ReadonlyMap<string, CaptureDue>;
  submissions: LeadSubmission[];
  versions: LeadMagnetVersion[];
  magnetName: (id: string) => string;
  campaignName: (id: string | null) => string | null;
  busy: string | null;
  loading: boolean;
  onOpen: (version: LeadMagnetVersion) => void;
  onAct: (key: string, work: () => Promise<void>, said: string) => Promise<void>;
}) {
  const versionOf = (id: string | null) => (id ? versions.find((v) => v.id === id) : undefined);

  return (
    <div className="space-y-5">
      <div className="rounded-lg border border-border bg-card p-4">
        <h3 className="font-semibold">Where people can ask for a magnet</h3>
        <p className="mt-1 text-sm text-muted-foreground">
          Each link is scoped to one client, promises one magnet version, and carries the exact
          wording people agree to. It opens switched off, expires, and stops at a submission
          ceiling — the three things that make a public write path survivable.
        </p>
        {versions.length > 0 && (
          <div className="mt-3 flex flex-wrap gap-2">
            {versions.slice(0, 4).map((v) => (
              <Button key={v.id} onClick={() => onOpen(v)}>
                Open a link for {magnetName(v.magnet_id)} v{v.version}
              </Button>
            ))}
          </div>
        )}
      </div>

      <DataTable
        columns={["Promises", "Attributed to", "What is stopping it", "Used", "Actions"]}
        emptyLabel={loading ? "Loading links…" : "No capture links yet"}
        rows={endpoints.map((endpoint) => {
          const blocker = endpointDue.get(endpoint.id)?.blocker ?? null;
          const version = versionOf(endpoint.magnet_version_id);
          return [
            <span key="p">
              {version ? `${magnetName(version.magnet_id)} v${version.version}` : endpoint.purpose.replace(/_/g, " ")}
              {endpoint.purpose === "magnet_optin" && !version && (
                <span className="block text-xs text-destructive">
                  Promises a magnet but names no version.
                </span>
              )}
            </span>,
            <span key="c">{campaignName(endpoint.campaign_id) ?? "No campaign"}</span>,
            <span key="b" className={blocker ? "text-destructive" : "text-brand-strong"}>
              {blocker ?? "Taking submissions"}
            </span>,
            <span key="u">
              {endpoint.submissions} / {endpoint.max_submissions}
            </span>,
            <ActionMenu
              key="a"
              name={version ? magnetName(version.magnet_id) : endpoint.purpose}
              busy={busy === endpoint.id}
              items={[
                {
                  label: endpoint.enabled ? "Switch off" : "Switch on",
                  onSelect: () =>
                    void onAct(
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

      <section className="space-y-2">
        <h3 className="font-semibold">Who opted in</h3>
        <DataTable
          columns={["When", "Who", "Consent", "Became a lead"]}
          emptyLabel={loading ? "Loading…" : "Nobody has opted in yet"}
          rows={submissions.map((s) => [
            <span key="w">{dayOrDash(s.created_at)}</span>,
            <span key="n">
              {s.name ?? "No name given"}
              <span className="block text-xs text-muted-foreground">{s.email ?? s.phone}</span>
            </span>,
            <span key="c" className="text-xs">
              {s.consent_given_at ? (
                <>
                  <span className="text-brand-strong">given</span>
                  <span className="block text-muted-foreground">
                    {s.consent_wording.slice(0, 60)}
                    {s.consent_wording.length > 60 ? "…" : ""}
                  </span>
                </>
              ) : (
                <span className="text-destructive">none recorded</span>
              )}
            </span>,
            <span key="l" className={s.lead_id ? "text-brand-strong" : "text-muted-foreground"}>
              {s.status === "promoted" ? "yes" : s.status}
            </span>,
          ])}
        />
      </section>
    </div>
  );
}
