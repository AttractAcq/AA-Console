import { EmptyState } from "./EmptyState";
import { cn } from "../lib/cn";

export function SectionCard({
  title,
  variant = "default",
  minHeight,
}: {
  title: string;
  variant?: "default" | "hero";
  minHeight?: number;
}) {
  const isHero = variant === "hero";
  return (
    <div className={cn("rounded-lg border border-border bg-card", isHero ? "p-6" : "p-5")}>
      <h2
        className={cn(
          "mb-3 font-semibold text-card-foreground",
          isHero ? "text-base" : "text-sm",
        )}
      >
        {title}
      </h2>
      <EmptyState label={title} minHeight={minHeight ?? (isHero ? 180 : 140)} />
    </div>
  );
}
