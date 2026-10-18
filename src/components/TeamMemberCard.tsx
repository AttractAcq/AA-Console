import { Link } from "react-router-dom";
import type { TeamCategory, TeamMember } from "../data/team";
import { cn } from "../lib/cn";

export function TeamMemberCard({
  category,
  member,
  onEdit,
  onRetire,
  onRestore,
}: {
  category: TeamCategory;
  member: TeamMember;
  onEdit?: () => void;
  onRetire?: () => void;
  onRestore?: () => void;
}) {
  return (
    <div className="rounded-lg border border-border bg-card p-5">
      <Link
        to={`/team/${category}/${member.id}/overview`}
        className="flex flex-col gap-4 rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <div className="flex h-11 w-11 items-center justify-center rounded-md border border-border bg-cool-surface text-sm font-semibold text-ink-subtle">
          {member.initials}
        </div>
        <p className="text-sm font-semibold text-card-foreground hover:text-brand-strong">{member.name}</p>
        <span
          className={cn(
            "w-fit rounded-full px-2.5 py-1 text-xs font-medium",
            member.engagementType === "Employee"
              ? "bg-secondary text-secondary-foreground"
              : "bg-primary/10 text-brand-strong",
          )}
        >
          {member.engagementType}
        </span>
      </Link>
      {(onEdit || onRetire || onRestore) && (
        <div className="mt-4 flex gap-3 border-t border-border pt-3 text-sm">
          {onEdit && <button type="button" onClick={onEdit} className="text-brand-strong hover:underline">Edit profile</button>}
          {onRetire && <button type="button" onClick={onRetire} className="text-destructive hover:underline">Retire</button>}
          {onRestore && <button type="button" onClick={onRestore} className="text-brand-strong hover:underline">Restore</button>}
        </div>
      )}
    </div>
  );
}
