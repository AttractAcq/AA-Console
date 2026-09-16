import type { ProfileEntry } from "../lib/teamMemberProfile";
import { cn } from "../lib/cn";

export function ProfileDefinitionList({ entries }: { entries: ProfileEntry[] }) {
  if (entries.length === 0) return null;
  return (
    <dl className="space-y-2 text-sm">
      {entries.map((entry) => (
        <div key={entry.label} className="flex min-w-0 gap-3">
          <dt className="w-32 shrink-0 text-muted-foreground">{entry.label}</dt>
          <dd className="min-w-0 flex-1 text-card-foreground">
            {entry.href ? (
              <a
                href={entry.href}
                className="break-words rounded hover:text-brand-strong hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                {entry.value}
              </a>
            ) : (
              <p className={cn("break-words", entry.multiline && "whitespace-pre-wrap")}>{entry.value}</p>
            )}
          </dd>
        </div>
      ))}
    </dl>
  );
}
