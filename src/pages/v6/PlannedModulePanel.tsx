import { Link, useParams } from "react-router-dom";

type PlannedModule = "google-ads-studio" | "google-profile" | "lead-magnet-studio";

const DETAILS: Record<PlannedModule, { outcome: string; dependency: string; related: string; relatedPath: string }> = {
  "google-ads-studio": {
    outcome: "Prepare, approve, deploy and measure paid search campaigns from the campaign plan.",
    dependency: "Campaign mode and approval contracts, Google Ads account access, conversion tracking and a verified destination are required.",
    related: "Open Campaign Factory", relatedPath: "campaign-factory",
  },
  "google-profile": {
    outcome: "Manage the client's Google Business Profile, reviews and approved proof updates.",
    dependency: "A client-owned profile connection, review ingestion and version-bound approval for external updates are required.",
    related: "Open Proof Production Factory", relatedPath: "proof-production-factory",
  },
  "lead-magnet-studio": {
    outcome: "Create a campaign-linked incentive and verify delivery, consent and sourced lead capture.",
    dependency: "The campaign offer, destination page and Sales OS lead contract must be linked first.",
    related: "Open Website Studio", relatedPath: "website-studio",
  },
};

export function PlannedModulePanel({ module }: { module: PlannedModule }) {
  const { clientId } = useParams<{ clientId: string }>();
  const detail = DETAILS[module];
  return <div className="max-w-2xl rounded-lg border border-border bg-card p-6">
    <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Planned capability</p>
    <p className="mt-3 text-sm text-foreground">{detail.outcome}</p>
    <p className="mt-3 text-sm text-muted-foreground">{detail.dependency}</p>
    {clientId && <Link className="mt-5 inline-block text-sm font-medium text-brand-strong hover:underline"
      to={`/clients/${clientId}/delivery/${detail.relatedPath}`}>{detail.related}</Link>}
  </div>;
}
