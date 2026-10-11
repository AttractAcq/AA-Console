import type { Comparison, Delta } from "../../lib/metricsCompare";

/**
 * How a figure moved against the window before this one.
 *
 * The arithmetic is the mirrored module the commentary agent uses, not
 * something computed here, so a panel saying "+25%" cannot sit beside a
 * write-up saying "+30%". A reader has no way to know which to believe, and
 * both look authoritative.
 *
 * A withheld percentage is shown as a withheld percentage, with its reason —
 * one click becoming three is +200%, and a reader who repeats that to a
 * client has been misled by a green arrow.
 */
export function TrendLine({ comparison, label }: { comparison: Comparison; label: string }) {
  if (comparison.refusal) {
    // Said rather than hidden: an absent trend and a flat one look identical
    // otherwise, and they mean very different things.
    return <p className="mt-1 text-xs text-muted-foreground">{comparison.refusal}</p>;
  }
  const delta = comparison.deltas.find((d) => d.label === label);
  if (!delta) return null;
  return <p className="mt-1 text-xs">{describe(delta)}</p>;
}

function describe(d: Delta): JSX.Element {
  const direction = d.change > 0 ? "up" : d.change < 0 ? "down" : "flat";
  const tone =
    d.change === 0
      ? "text-muted-foreground"
      : d.change > 0
        ? "text-brand-strong"
        : "text-destructive";
  return (
    <>
      <span className={tone}>
        {direction === "flat" ? "Flat" : `${direction === "up" ? "Up" : "Down"} ${fmt(Math.abs(d.change))}`}
        {d.percent === null ? "" : ` (${d.percent > 0 ? "+" : ""}${d.percent}%)`}
      </span>{" "}
      <span className="text-muted-foreground">
        on {fmt(d.before)} before
        {d.note ? ` · no percentage: ${d.note}` : ""}
      </span>
    </>
  );
}

const fmt = (n: number): string =>
  Number.isInteger(n) ? n.toLocaleString() : n.toLocaleString(undefined, { maximumFractionDigits: 2 });
