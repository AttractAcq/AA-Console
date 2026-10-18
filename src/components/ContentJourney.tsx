import { Link } from "react-router-dom";
import { cn } from "../lib/cn";

export type ContentStage = "ideation" | "brief" | "create" | "edit" | "approval" | "distribution";

const STAGES: { id: ContentStage; label: string; path: string }[] = [
  { id: "ideation", label: "Ideation", path: "content-production-factory?tab=generation" },
  { id: "brief", label: "Brief", path: "content-production-factory?tab=briefs" },
  { id: "create", label: "Create", path: "content-production-factory?tab=create" },
  { id: "edit", label: "Edit / Repurpose", path: "content-production-factory?tab=edit" },
  { id: "approval", label: "Approval", path: "approval-inbox?tab=assets" },
  { id: "distribution", label: "Distribution", path: "content-distribution?tab=distribution-assets" },
];

/** One route through the same work item, with the active stage marked explicitly. */
export function ContentJourney({ clientId, current, briefId, engineApproval = false }: {
  clientId: string | undefined;
  current: ContentStage;
  briefId?: string | null;
  engineApproval?: boolean;
}) {
  const currentIndex = STAGES.findIndex((stage) => stage.id === current);
  return (
    <nav aria-label="Content production stages" className="mb-4">
      <ol className="flex flex-wrap items-center gap-1.5 text-xs">
        {STAGES.map((stage, index) => {
          const suffix = stage.id === "approval" && engineApproval
            ? "approval-inbox?tab=engine-inbox" : stage.path;
          const focused = briefId && (stage.id === "brief" || stage.id === "create" || stage.id === "edit")
            ? `${suffix}${suffix.includes("?") ? "&" : "?"}brief=${encodeURIComponent(briefId)}` : suffix;
          const className = cn(
            "rounded-full border px-2.5 py-1",
            index === currentIndex ? "border-primary bg-primary/10 font-semibold text-brand-strong"
              : index < currentIndex ? "border-border text-foreground"
                : "border-border text-muted-foreground",
          );
          return <li key={stage.id} className="flex items-center gap-1.5">
            {index > 0 && <span aria-hidden="true" className="text-muted-foreground">→</span>}
            {clientId && stage.id !== current
              ? <Link className={className} to={`/clients/${clientId}/delivery/${focused}`}>{stage.label}</Link>
              : <span className={className} aria-current={stage.id === current ? "step" : undefined}>{stage.label}</span>}
          </li>;
        })}
      </ol>
    </nav>
  );
}
