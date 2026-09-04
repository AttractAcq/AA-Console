import { Link } from "react-router-dom";
import type { TeamCategory, TeamMember } from "../data/team";
import { cn } from "../lib/cn";

export function TeamMemberCard({
  category,
  member,
}: {
  category: TeamCategory;
  member: TeamMember;
}) {
  return (
    <Link
      to={`/team/${category}/${member.id}/overview`}
      className="flex flex-col gap-4 rounded-lg border border-border bg-card p-5 text-left transition-colors hover:border-primary/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
    >
      <div className="flex h-11 w-11 items-center justify-center rounded-md border border-border bg-cool-surface text-sm font-semibold text-ink-subtle">
        {member.initials}
      </div>
      <p className="text-sm font-semibold text-card-foreground">{member.name}</p>
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
  );
}
