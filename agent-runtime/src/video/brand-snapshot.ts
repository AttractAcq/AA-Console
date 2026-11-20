import { Ajv2020 } from "ajv/dist/2020.js";
import overridesSchema from "./brand-overrides.schema.json" with { type: "json" };

const validateOverrides = new Ajv2020({ allErrors: true }).compile(overridesSchema);
const TEXT = ["colour_primary", "colour_secondary", "colour_accent",
  "colour_background", "colour_text", "font_heading", "font_body",
  "imagery_style", "never_do", "video_rulebook_notes",
  "narrator_voice_id"];

/** Check the immutable database snapshot before any paid still or media call.
 * The renderer applies the same versioned overrides with its buildTheme().
 */
export function videoBrandSnapshot(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Video project has no exact brand snapshot.");
  }
  const row = value as Record<string, unknown>;
  if (Object.keys(row).some((key) => !TEXT.includes(key)
      && key !== "video_tokens")
    || TEXT.some((key) => row[key] !== undefined
      && row[key] !== null && typeof row[key] !== "string")
    || !validateOverrides(row.video_tokens ?? {})) {
    throw new Error("Video project brand snapshot is invalid.");
  }
  return row;
}
