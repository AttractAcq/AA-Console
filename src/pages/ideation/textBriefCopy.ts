type Copy = { script: string; argument: string; visual_direction?: string };

/** Preserve every other byte of the Markdown the creative worker reads. */
export function revisedBriefBody(body: string, previous: Copy, revised: Copy): string {
  const sections: [keyof Copy, string][] = [["argument", "Argument"], ["script", "Script"]];
  if (previous.visual_direction !== undefined || revised.visual_direction !== undefined) {
    sections.push(["visual_direction", "Visual direction"]);
  }
  const changes = sections.map(([field, label]) => {
    const heading = `## ${label}\n\n`;
    const section = heading + previous[field];
    const start = body.indexOf(section);
    const end = start + section.length;
    if (!previous[field] || !revised[field]?.trim() || start < 0 || body.indexOf(section, start + 1) !== -1 ||
        (start !== 0 && body.slice(start - 2, start) !== "\n\n") ||
        (end !== body.length && !body.startsWith("\n\n## ", end))) {
      throw new Error("The saved brief body and its copy fields differ. Refresh and review the source before editing.");
    }
    return { start, end, text: heading + revised[field] };
  }).sort((a, b) => b.start - a.start);
  if (changes.some((change, i) => i > 0 && change.end > changes[i - 1].start)) throw new Error("The saved brief sections overlap.");
  for (const change of changes) body = body.slice(0, change.start) + change.text + body.slice(change.end);
  return body;
}
