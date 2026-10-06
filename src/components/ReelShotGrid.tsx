import { DataTable } from "./DataTable";
import { ApprovalActions } from "./ApprovalActions";
import { RequestCutButton } from "./RequestCutButton";
import { StatusBadge } from "./MediaCard";
import { REVIEW_TONE } from "../lib/media";
import { cn } from "../lib/cn";
import type { ReelMasterView, ShotRow } from "../lib/reelShots";

const CLIP_TONE: Record<ShotRow["clip"], string> = {
  "Clip on file": "bg-primary/10 text-brand-strong",
  Submitted: "bg-secondary text-secondary-foreground",
  "No clip": "bg-muted text-muted-foreground",
};

const STILL_TONE: Record<ShotRow["still"], string> = {
  "Still on file": "bg-primary/10 text-brand-strong",
  "No still": "bg-muted text-muted-foreground",
};

function pill(label: string, tone: string) {
  return (
    <span className={cn("inline-block rounded-full px-2 py-0.5 text-xs font-medium", tone)}>
      {label}
    </span>
  );
}

function shotTable(shots: ShotRow[]) {
  return (
    <DataTable
      columns={["Shot", "Beat", "Duration", "Source", "Motion", "Still", "Clip"]}
      emptyLabel="No shots on this reel."
      rows={shots.map((shot) => [
        <span key="n">{shot.position}</span>,
        <span key="b">{shot.beat}</span>,
        <span key="d">{shot.durationLabel}</span>,
        <span key="s">{shot.source}</span>,
        <span key="m">{shot.motion}</span>,
        pill(shot.still, STILL_TONE[shot.still]),
        pill(shot.clip, CLIP_TONE[shot.clip]),
      ])}
    />
  );
}

/**
 * One reel, then its shots.
 *
 * Grouped by the brief because that is the master. The parent asset, when
 * one exists, is what gets approved — the same decision as every other
 * piece of media. There is nothing to approve until that asset is on file.
 */
export function ReelShotGrid({
  masters,
  onChanged,
  onError,
}: {
  masters: ReelMasterView[];
  onChanged: () => void;
  onError: (message: string) => void;
}) {
  if (masters.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No Phase 1 reels yet. An F6 or F7 brief shows its shot plan here after it is written.
      </p>
    );
  }

  return (
    <div className="space-y-6">
      {masters.map((master) => (
        <section key={master.briefId} className="space-y-3">
          <header className="flex flex-wrap items-baseline gap-2">
            <h3 className="text-sm font-semibold text-foreground">{master.title}</h3>
            {master.briefRef && (
              <span className="text-xs text-muted-foreground">{master.briefRef}</span>
            )}
            {master.formatCode && (
              <span className="text-xs text-muted-foreground">{master.formatCode}</span>
            )}
            <span className="text-xs capitalize text-muted-foreground">
              {master.briefStatus.replace(/_/g, " ")}
            </span>
          </header>

          {master.planProblem && (
            <p role="alert" className="text-sm text-destructive">
              {master.planProblem}
            </p>
          )}

          {master.assets.length === 0 ? (
            <div className="space-y-2">
              <p className="text-xs text-muted-foreground">
                No master yet. Stills and the clip are not on file. Nothing to approve until a master exists.
              </p>
              {shotTable(master.plannedShots)}
            </div>
          ) : (
            master.assets.map((asset) => (
              <div key={asset.id} className="space-y-2">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-xs text-muted-foreground">
                    {asset.refNumber ?? "Master"}
                    {asset.title ? ` · ${asset.title}` : ""}
                  </span>
                  <StatusBadge status={asset.reviewStatus} tone={REVIEW_TONE[asset.reviewStatus]} />
                  {asset.reviewStatus === "pending" && (
                    <ApprovalActions
                      assetId={asset.id}
                      title={asset.title ?? master.title}
                      onDone={onChanged}
                      onError={onError}
                    />
                  )}
                  <RequestCutButton
                    assetId={asset.id}
                    state={asset.cut}
                    onRequested={onChanged}
                    onError={onError}
                  />
                </div>
                {shotTable(asset.shots.length > 0 ? asset.shots : master.plannedShots)}
              </div>
            ))
          )}
        </section>
      ))}
    </div>
  );
}
