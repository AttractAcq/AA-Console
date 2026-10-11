import { Link } from "react-router-dom";
import { cn } from "../lib/cn";

export type ContentStage = "ideation" | "brief" | "create" | "edit" | "approval" | "distribution";

const STAGES: { id: ContentStage; label: string; path: string }[] = [
  { id: "ideation", label: "Ideation", path: "ideation?tab=generation" },
  { id: "brief", label: "Brief", path: "ideation?tab=briefs" },
  { id: "create", label: "Create", path: "media?tab=reel-shots" },
  { id: "edit", label: "Edit / Repurpose", path: "edit-repurpose?tab=overview" },
  { id: "approval", label: "Approval", path: "approvals?tab=assets" },
  { id: "distribution", label: "Distribution", path: "distribution?tab=distribution-assets" },
];

/** One route through the same work item, with the active stage marked explicitly. */
export function ContentJourney({ clientId, current, briefId, engineApproval = false, reelEdit = false, humanVideo = false }: {
  clientId: string | undefined;
  current: ContentStage;
  briefId?: string | null;
  engineApproval?: boolean;
  reelEdit?: boolean;
  humanVideo?: boolean;
}) {
  const currentIndex = STAGES.findIndex((stage) => stage.id === current);
  return (
    <nav aria-label="Content production stages" className="mb-4">
      <ol className="flex flex-wrap items-center gap-1.5 text-xs">
        {STAGES.map((stage, index) => {
          const suffix = stage.id === "approval" && engineApproval
            ? "approvals?tab=engine-inbox"
            : stage.id === "edit" && reelEdit ? "media?tab=reel-shots"
              : stage.id === "create" && humanVideo ? "media?tab=video-library" : stage.path;
          const focused = briefId && (stage.id === "brief" || stage.id === "create" || stage.id === "edit")
            ? `${suffix}&brief=${encodeURIComponent(briefId)}` : suffix;
          const className = cn(
            "rounded-full border px-2.5 py-1",
            index === currentIndex ? "border-primary bg-primary/10 font-semibold text-brand-strong"
              : index < currentIndex ? "border-border text-foreground"
                : "border-border text-muted-foreground",
          );
          return <li key={stage.id} className="flex items-center gap-1.5">
            {index > 0 && <span aria-hidden="true" className="text-muted-foreground">→</span>}
            {clientId && stage.id !== current && (!(["create", "edit"] as ContentStage[]).includes(stage.id) || briefId)
              ? <Link className={className} to={`/clients/${clientId}/delivery/${focused}`}>{stage.label}</Link>
              : <span className={className} aria-current={stage.id === current ? "step" : undefined}>{stage.label}</span>}
          </li>;
        })}
      </ol>
    </nav>
  );
}
