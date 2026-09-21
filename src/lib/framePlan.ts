/**
 * A typed frame plan, as lines.
 *
 * Blank lines are dropped rather than counted. A textarea with a trailing
 * newline is the normal way to finish typing four lines, not a request for a
 * fifth frame with nothing briefed for it — and a blank entry is refused by
 * frame_plan_is_usable() in migration 113, so counting it would make the
 * button offer a build the database will not accept.
 *
 * Mirrors the same trim-and-drop the RPC performs, so the count shown under
 * the box is the count that gets stored.
 */
export function framePlanLines(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}
