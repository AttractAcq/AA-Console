export function EmptyState({
  label,
  minHeight = 320,
}: {
  label: string;
  minHeight?: number;
}) {
  return (
    <div
      className="flex items-center justify-center rounded-lg border border-dashed border-input bg-cool-surface"
      style={{ minHeight }}
    >
      <p className="text-sm text-muted-foreground">{label}</p>
    </div>
  );
}
