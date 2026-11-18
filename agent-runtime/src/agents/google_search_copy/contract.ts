/** Google search text is a paid-route creative artifact, never a social post. */
export interface GoogleSearchCopy {
  headlines: string[];
  descriptions: string[];
  rationale: string;
}

export const GOOGLE_SEARCH_COPY_TOOL = {
  name: "submit_google_search_copy",
  description: "Submit bounded Google search ad copy for human review. This does not build or activate an ad.",
  inputSchema: {
    type: "object",
    properties: {
      headlines: {
        type: "array", items: { type: "string" },
        description: "Three to fifteen distinct search headlines, each at most 30 characters.",
      },
      descriptions: {
        type: "array", items: { type: "string" },
        description: "Two to four distinct search descriptions, each at most 90 characters.",
      },
      rationale: {
        type: "string",
        description: "Explain the intended audience and offer alignment. Do not present keyword seeds as researched keywords.",
      },
    },
    required: ["headlines", "descriptions", "rationale"],
    additionalProperties: false,
  },
} as const;

function checkedLines(value: unknown, label: string, min: number, max: number, length: number): string[] {
  if (!Array.isArray(value) || value.length < min || value.length > max) {
    throw new Error(`${label} need ${min}–${max} entries.`);
  }
  const lines = value.map((entry) => {
    if (typeof entry !== "string") throw new Error(`${label} must contain text only.`);
    const line = entry.trim();
    if (!line || Array.from(line).length > length || /[\r\n\t]/u.test(line) || /\s{2,}/u.test(line)) {
      throw new Error(`${label} must be nonempty, single-spaced and at most ${length} characters each.`);
    }
    return line;
  });
  if (new Set(lines.map((line) => line.toLocaleLowerCase("en"))).size !== lines.length) {
    throw new Error(`${label} must be distinct.`);
  }
  return lines;
}

export function parseGoogleSearchCopy(value: unknown): GoogleSearchCopy {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Google search copy must be an object.");
  }
  const row = value as Record<string, unknown>;
  if (Object.keys(row).some((key) => !["headlines", "descriptions", "rationale"].includes(key))) {
    throw new Error("Google search copy contains unexpected fields.");
  }
  const headlines = checkedLines(row.headlines, "Headlines", 3, 15, 30);
  const descriptions = checkedLines(row.descriptions, "Descriptions", 2, 4, 90);
  if (typeof row.rationale !== "string" || row.rationale.trim().length < 20) {
    throw new Error("A substantive review rationale is required.");
  }
  return { headlines, descriptions, rationale: row.rationale.trim() };
}
