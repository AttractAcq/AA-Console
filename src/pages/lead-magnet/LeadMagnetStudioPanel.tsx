import { useCallback, useEffect, useState } from "react";
import { useParams } from "react-router-dom";

import { Button } from "../../components/Button";
import { DataTable } from "../../components/DataTable";
import { ActionMenu } from "../../components/ActionMenu";
import { FormModal } from "../../components/forms/FormModal";
import { IndexDetail } from "../../components/index-detail/IndexDetail";
import { dayOrDash } from "../../lib/contentRecords";
import { supabase } from "../../lib/supabase";
import {
  CHANNEL_HINT, MAGNET_FORMATS,
  addVersion, createMagnet, decideApproval, fetchApprovals,
  fetchDeliveriesDue, fetchMagnets,
  fetchVersions, requestApproval, revokeApproval,
  type LeadMagnet, type LeadMagnetApproval,
  type LeadMagnetDue, type LeadMagnetVersion,
} from "../../lib/leadMagnets";
import {
  fetchEndpoints, fetchSubmissions,
  type CaptureEndpoint, type LeadSubmission,
} from "../../lib/leadCapture";

/**
 * Lead Magnet Studio.
 *
 * The one place in this system that makes a promise directly to a stranger:
 * hand over your email address and you will get this file. Everything on
 * this page exists to make that promise keepable.
 *
 * ONE PAGE, per v6.1 phase 3 item 7: "one page, table plus a build button.
 * Download only, no distribution. Opt-ins dropped."
 *
 * It was four tabs -- Magnets, Build, Delivery, Opt-ins -- and three of them
 * are gone. What each one held, and where it went, because none of it was
 * simply deleted:
 *
 *   Build     was a second list of the same magnets with a create button on
 *             top. The button is this page's action; the list was the table
 *             twice.
 *   Delivery  held three different things. The delivery switch was already
 *             duplicated on the Dashboard switch panel, which is where the
 *             notes say every switch lives, so this copy went. The approval
 *             queue moved into the row detail. What-is-owed moved with it,
 *             scoped to the magnet whose row is open.
 *   Opt-ins   is archived (docs/V6_1_ARCHIVED_SURFACES.md). Capture
 *             endpoints are still created and switched in Sales OS -> Capture,
 *             which the notes leave alone, so nothing became unreachable.
 *
 * The approval act did NOT flatten into a row menu. Approving a magnet means
 * approving exact bytes and the words that carry them, and the old Delivery
 * tab showed the message body before you decided. A menu item that approves
 * something you cannot see would have been a worse page, not a tidier one, so
 * the decision lives in the detail panel next to the thing it is deciding.
 *
 * The thing the layout is built to keep visible is that an approval is given
 * against a version rather than against a magnet. A magnet with three
 * versions where the second is approved is the normal case, not an error,
 * and a screen that showed only "approved" would hide which bytes that
 * referred to.
 */

export function LeadMagnetStudioPanel() {
  const { clientId } = useParams<{ clientId: string }>();
  const [magnets, setMagnets] = useState<LeadMagnet[]>([]);
  const [versions, setVersions] = useState<LeadMagnetVersion[]>([]);
  const [approvals, setApprovals] = useState<LeadMagnetApproval[]>([]);
  const [due, setDue] = useState<LeadMagnetDue[]>([]);
  const [endpoints, setEndpoints] = useState<CaptureEndpoint[]>([]);
  const [submissions, setSubmissions] = useState<LeadSubmission[]>([]);
  const [campaigns, setCampaigns] = useState<{ id: string; name: string }[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [building, setBuilding] = useState(false);
  const [versioning, setVersioning] = useState<LeadMagnet | null>(null);

  const refresh = useCallback(async () => {
    if (!clientId) {
      setLoading(false);
      return;
    }
    try {
      const [m, v, a, d, e, s, camps] = await Promise.all([
        fetchMagnets(clientId),
        fetchVersions(clientId),
        fetchApprovals(clientId),
        fetchDeliveriesDue(clientId),
        fetchEndpoints(clientId),
        fetchSubmissions(clientId),
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
      setSubmissions(s);
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
  const campaignName = (id: string | null) =>
    id ? (campaigns.find((c) => c.id === id)?.name ?? "A campaign") : null;

  /**
   * What is owed for one magnet. Filtered by the magnet's own version ids
   * rather than by `magnet_name`, which the view also carries: two magnets may
   * legitimately share a name, and a rename would silently empty the list.
   */
  const dueFor = (magnetId: string) => {
    const ids = new Set(versionsOf(magnetId).map((v) => v.id));
    return due.filter((row) => row.magnet_version_id && ids.has(row.magnet_version_id));
  };

  /** How many people opted in through a form promising this magnet. */
  const optInsFor = (magnetId: string) => {
    const versionIds = new Set(versionsOf(magnetId).map((v) => v.id));
    const theirs = new Set(
      endpoints.filter((e) => e.magnet_version_id && versionIds.has(e.magnet_version_id)).map((e) => e.id),
    );
    return submissions.filter((s) => theirs.has(s.endpoint_id)).length;
  };

  /** Why this magnet is not live, in the order a person would ask. */
  const blockerFor = (magnet: LeadMagnet) => {
    const all = versionsOf(magnet.id);
    if (all.length === 0) return "No file has been uploaded yet.";
    if (all.some((v) => liveApproval(v.id))) return null;
    if (all.some((v) => pendingApproval(v.id))) return "Waiting for a person to approve it.";
    return "Nobody has been asked to approve it.";
  };

  if (error && magnets.length === 0 && !loading) {
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

      <IndexDetail
        title="Magnets"
        paramKey="magnet"
        items={magnets}
        nameOf={(magnet) => magnet.name}
        emptyLabel={loading ? "Loading magnets…" : "No magnets yet — start with what the client already gives people"}
        unselectedLabel="Choose a magnet to see its versions and decide on them."
        action={<Button onClick={() => setBuilding(true)}>New magnet</Button>}
        columns={[
          {
            label: "Magnet",
            cell: (magnet) => (
              <>
                {magnet.name}
                <span className="block text-xs text-muted-foreground">
                  {campaignName(magnet.campaign_id) ?? "Evergreen"}
                </span>
              </>
            ),
          },
          {
            label: "Live version",
            cell: (magnet) => {
              const live = versionsOf(magnet.id).find((v) => liveApproval(v.id));
              return <span>{live ? `v${live.version}` : "—"}</span>;
            },
          },
          {
            label: "State",
            cell: (magnet) => {
              const all = versionsOf(magnet.id);
              const live = all.some((v) => liveApproval(v.id));
              const pending = all.some((v) => pendingApproval(v.id));
              return (
                <span className={live ? "text-brand-strong" : "text-muted-foreground"}>
                  {live ? "live" : pending ? "awaiting approval" : "draft"}
                </span>
              );
            },
          },
          {
            label: "What is stopping it",
            cell: (magnet) => {
              const blocker = blockerFor(magnet);
              return (
                <span className={blocker ? "text-destructive" : "text-brand-strong"}>
                  {blocker ?? "Nothing"}
                </span>
              );
            },
          },
          { label: "Opt-ins", cell: (magnet) => <span>{optInsFor(magnet.id)}</span> },
          { label: "Owed", cell: (magnet) => <span>{dueFor(magnet.id).length}</span> },
        ]}
        rowActions={(magnet) => {
          const newest = versionsOf(magnet.id)[0];
          return (
            <ActionMenu
              name={magnet.name}
              busy={busy === magnet.id}
              items={[
                { label: "New version", onSelect: () => setVersioning(magnet) },
                ...(newest && !liveApproval(newest.id) && !pendingApproval(newest.id)
                  ? [{
                      label: `Ask for approval of v${newest.version}`,
                      onSelect: () =>
                        void act(magnet.id, () => requestApproval(newest.id), "Sent for approval."),
                    }]
                  : []),
              ]}
            />
          );
        }}
        detail={(magnet) => (
          <MagnetDetail
            magnet={magnet}
            versions={versionsOf(magnet.id)}
            due={dueFor(magnet.id)}
            liveApproval={liveApproval}
            pendingApproval={pendingApproval}
            campaignName={campaignName}
            busy={busy}
            loading={loading}
            onNewVersion={() => setVersioning(magnet)}
            onAct={act}
          />
        )}
      />

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
    </div>
  );
}

/**
 * One magnet, opened. Its versions newest first, the decision on whichever
 * version is waiting for one, and what is owed to people who already opted in.
 *
 * The decision is here rather than on the row because it is a decision about
 * bytes: the file's hash and, for an emailed magnet, the exact message body
 * are both shown next to the buttons that approve them.
 */
function MagnetDetail({
  magnet, versions, due, liveApproval, pendingApproval, campaignName,
  busy, loading, onNewVersion, onAct,
}: {
  magnet: LeadMagnet;
  versions: LeadMagnetVersion[];
  due: LeadMagnetDue[];
  liveApproval: (versionId: string) => LeadMagnetApproval | undefined;
  pendingApproval: (versionId: string) => LeadMagnetApproval | undefined;
  campaignName: (id: string | null) => string | null;
  busy: string | null;
  loading: boolean;
  onNewVersion: () => void;
  onAct: (key: string, work: () => Promise<void>, said: string) => Promise<void>;
}) {
  return (
    <div className="space-y-5">
      <div>
        <p className="text-sm">{magnet.objective}</p>
        <p className="mt-1 text-xs text-muted-foreground">
          {MAGNET_FORMATS.find((f) => f.value === magnet.format)?.label ?? magnet.format}
          {campaignName(magnet.campaign_id) ? ` · ${campaignName(magnet.campaign_id)}` : " · evergreen"}
          {magnet.audience ? ` · for ${magnet.audience}` : ""}
        </p>
      </div>

      <section className="space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="font-semibold">Versions</h3>
          <Button onClick={onNewVersion}>New version</Button>
        </div>

        {versions.length === 0 ? (
          <p className="text-sm text-destructive">
            No file yet. Nothing can be promised until there is one.
          </p>
        ) : (
          versions.map((version) => {
            const live = liveApproval(version.id);
            const pending = pendingApproval(version.id);
            return (
              <article key={version.id} className="rounded-lg border border-border bg-card p-4">
                <div className="flex flex-wrap items-center gap-2 text-sm">
                  <span className="font-medium">v{version.version}</span>
                  <span className="text-muted-foreground">
                    {(version.file_bytes / 1024).toFixed(0)} KB · {version.delivery_channel.replace("_", " ")}
                  </span>
                  <code className="text-xs text-muted-foreground">
                    {version.content_sha256.slice(0, 12)}…
                  </code>
                  <span
                    className={
                      live ? "text-brand-strong" : pending ? "text-amber-600" : "text-muted-foreground"
                    }
                  >
                    {live ? `approved ${dayOrDash(live.decided_at)}` : pending ? "awaiting approval" : "not asked"}
                  </span>
                </div>

                {version.delivery_subject && (
                  <p className="mt-2 text-sm font-medium">{version.delivery_subject}</p>
                )}
                {version.delivery_body && (
                  <pre className="mt-2 max-h-40 overflow-auto rounded bg-muted p-3 text-xs whitespace-pre-wrap">
                    {version.delivery_body}
                  </pre>
                )}

                {pending && (
                  <>
                    {/* What the APPROVAL recorded, not what the version says
                        now. They are the same until someone re-exports either,
                        and the gap between them is exactly the "changed after
                        approval" blocker below — so a person deciding needs to
                        see the recorded scope and its hash, not a restatement
                        of the current row. */}
                    <dl className="mt-3 grid grid-cols-[auto,1fr] gap-x-3 gap-y-1 text-xs">
                      {Object.entries((pending.scope ?? {}) as Record<string, unknown>).map(
                        ([key, value]) => (
                          <div key={key} className="contents">
                            <dt className="text-muted-foreground">{key.replace(/_/g, " ")}</dt>
                            <dd className="break-all">{String(value)}</dd>
                          </div>
                        ),
                      )}
                      <dt className="text-muted-foreground">approving</dt>
                      <dd className="break-all font-mono">{pending.payload_hash.slice(0, 24)}…</dd>
                    </dl>
                    <div className="mt-3 flex flex-wrap gap-2">
                      <Button
                        disabled={busy === pending.id}
                        onClick={() =>
                          void onAct(pending.id, () => decideApproval(pending.id, true), "Approved.")
                        }
                      >
                        Approve this file and route
                      </Button>
                      <Button
                        disabled={busy === pending.id}
                        onClick={() => {
                          const why = window.prompt("Why is this not going out?");
                          if (why?.trim()) {
                            void onAct(
                              pending.id,
                              () => decideApproval(pending.id, false, why.trim()),
                              "Rejected.",
                            );
                          }
                        }}
                      >
                        Reject
                      </Button>
                    </div>
                  </>
                )}

                {live && (
                  <div className="mt-3">
                    <Button
                      disabled={busy === live.id}
                      onClick={() => {
                        const why = window.prompt("Why is it coming down?");
                        if (why?.trim()) {
                          void onAct(
                            live.id,
                            () => revokeApproval(live.id, why.trim()),
                            "Revoked. Anything not yet sent is cancelled.",
                          );
                        }
                      }}
                    >
                      Revoke
                    </Button>
                  </div>
                )}
              </article>
            );
          })
        )}
      </section>

      <section className="space-y-2">
        <h3 className="font-semibold">What is owed</h3>
        <DataTable
          columns={["To", "Status", "What is stopping it", "Reference"]}
          emptyLabel={loading ? "Loading…" : "Nobody is owed this magnet"}
          rows={due.map((row) => [
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
