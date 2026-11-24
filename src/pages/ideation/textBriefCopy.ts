type Copy = { script: string; argument: string };

/** Preserve every other byte of the Markdown the creative worker reads. */
export function revisedBriefBody(body: string, previous: Copy, revised: Copy): string {
  const changes = (["Argument", "Script"] as const).map(label => {
    const field = label === "Argument" ? "argument" : "script";
    const heading = `## ${label}\n\n`;
    const section = heading + previous[field];
    const start = body.indexOf(section);
    const end = start + section.length;
    if (!previous[field] || start < 0 || body.indexOf(section, start + 1) !== -1 ||
        (start !== 0 && body.slice(start - 2, start) !== "\n\n") ||
        (end !== body.length && !body.startsWith("\n\n## ", end))) {
      throw new Error("The saved brief body and its copy fields differ. Refresh and review the source before editing.");
    }
    return { start, end, text: heading + revised[field] };
  }).sort((a, b) => b.start - a.start);
  if (changes[0].start < changes[1].end) throw new Error("The saved brief sections overlap.");
  for (const change of changes) body = body.slice(0, change.start) + change.text + body.slice(change.end);
  return body;
}
