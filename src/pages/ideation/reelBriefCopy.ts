import { composeAvatarBody, composeBody, composeEditorBody } from "../../../agent-runtime/src/agents/brief/fields";
import { parseStoredShotPlan, reelCopyProblem, shotsFromSubmitted, type ShotPlanEntry } from "../../../agent-runtime/src/agents/brief/shots";
import type { FieldDef, FormValues } from "../../components/forms/fields";

type ReelBrief = {
  body: string | null;
  avatar_brief: string | null;
  editor_brief: string | null;
  frame_plan?: string[] | null;
  frame_count: number | null;
  shot_requirements: string | null;
  call_to_action: string | null;
  hook: string | null;
  argument: string | null;
  script: string | null;
  visual_direction: string | null;
};
const editable = { hook: "Hook", argument: "Argument", script: "Script", visual_direction: "Visual direction", call_to_action: "Call to action", shot_requirements: "Shot requirements" } as const;
type CopyKey = keyof typeof editable;
const keys = Object.keys(editable) as CopyKey[];

function required(key: CopyKey) {
  return key !== "shot_requirements" && key !== "call_to_action";
}

function documents(input: Record<string, unknown>) {
  return { body: composeBody("video", input, "reel"), avatar_brief: composeAvatarBody(input), editor_brief: composeEditorBody(input) };
}

export function prepareReelCopy(brief: ReelBrief) {
  const { shots, problem } = parseStoredShotPlan(brief.frame_plan);
  if (problem || !shots.length || shots.length !== brief.frame_count) throw new Error(problem ?? "The saved shot count differs from the plan.");
  // Production notes are present only in the compiled documents, immediately before Shots.
  const notes = brief.body?.match(/(?:^|\n\n)## Production notes\n\n([\s\S]*?)\n\n## Shots\n\n/)?.[1];
  const input = { ...brief, production_notes: notes, frames: shots };
  const originals = documents(input);
  if (originals.body !== brief.body || originals.avatar_brief !== brief.avatar_brief || originals.editor_brief !== brief.editor_brief) {
    throw new Error("The saved reel documents differ from their source fields. Review the differences before editing.");
  }

  const fields: FieldDef[] = keys.map(name => ({ name, label: editable[name], kind: "textarea", required: required(name), rows: 5 }));
  const initialValues: FormValues = Object.fromEntries(keys.map(key => [key, brief[key] ?? ""]));
  shots.forEach((shot, index) => {
    for (const [key, label] of [["opening_state", "Opening frame"], ["beat", "Camera and action"]] as const) {
      const name = key + index;
      fields.push({ name, label: `Shot ${index + 1} · ${label} (${shot.duration_sec}s)`, kind: "textarea", required: true, rows: 3 });
      initialValues[name] = shot[key] ?? "";
    }
  });

  function revision(values: FormValues, neverDo: string, palette: string[] | null) {
    const copy = Object.fromEntries(keys.map(key => [key, String(values[key] ?? "").trim()])) as Record<CopyKey, string>;
    if (keys.some(key => required(key) && !copy[key])) throw new Error("Complete each reel copy field before saving.");
    const frames = shots.map((shot, index): ShotPlanEntry => ({
      ...shot, beat: String(values["beat" + index] ?? "").trim(), opening_state: String(values["opening_state" + index] ?? "").trim(),
    }));
    const revised = { ...input, ...copy, frames };
    const invalid = shotsFromSubmitted(revised).problem ?? reelCopyProblem(revised, neverDo, palette);
    if (invalid) throw new Error(invalid);
    // Change only the two editable shot properties, preserving any other stored metadata.
    const frame_plan = frames.map((shot, index) => {
      const original = brief.frame_plan![index];
      if (shot.beat === shots[index].beat && shot.opening_state === shots[index].opening_state) return original;
      return JSON.stringify({ ...JSON.parse(original), beat: shot.beat, opening_state: shot.opening_state });
    });
    return { ...copy, call_to_action: copy.call_to_action || null, shot_requirements: copy.shot_requirements || null, frame_plan, ...documents(revised) };
  }
  return { fields, initialValues, revision };
}
