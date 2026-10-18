/**
 * Turning hashtags between the one text field a person types into and the
 * array the database stores.
 *
 * Here rather than in the editor component so the copywriter agent's output
 * and a person's typing go through the same parse, and so the component file
 * exports only a component.
 */
export function parseHashtags(value: string): string[] {
  return value
    .split(/[\s,]+/)
    .map((tag) => tag.trim())
    .filter(Boolean);
}

export function formatHashtags(tags: readonly string[] | null | undefined): string {
  return (tags ?? []).join(" ");
}
