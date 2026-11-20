import { z } from "zod";
import { AspectSchema } from "../components/primitives/Stage.js";
import { TransitionNameSchema } from "../components/primitives/TransitionPresets.js";
import { registry, type ComponentName } from "./registry.js";

export { registry };

export const ComponentNameSchema = z.enum(Object.keys(registry) as [ComponentName, ...ComponentName[]]);

export const SceneIRSchema = z.strictObject({
  id: z.string().regex(/^s\d{2}$/),
  component: ComponentNameSchema,
  props: z.unknown(),
  narration: z.string().trim().min(1).max(600),
  transitionIn: TransitionNameSchema.default("cut"),
  minDurationSec: z.number().finite().min(2).max(25).optional(),
  chapter: z.boolean().default(false),
  locked: z.boolean().default(false),
});

export const VideoIRSchema = z.strictObject({
  version: z.literal(1),
  title: z.string().trim().min(1).max(100),
  audience: z.string().trim().min(1).max(200),
  tone: z.enum(["calm", "confident", "energetic"]),
  aspects: z.array(AspectSchema).min(1).max(3),
  music: z.strictObject({ enabled: z.boolean(), mood: z.string().trim().max(80) }),
  scenes: z.array(SceneIRSchema).min(3).max(40),
});

export type SceneIR = z.infer<typeof SceneIRSchema>;
export type VideoIR = z.infer<typeof VideoIRSchema>;
export type IRValidation = { ok: true; ir: VideoIR } | { ok: false; problems: string[] };

function jsonPath(path: PropertyKey[]): string {
  return path.length ? path.map(String).join(".") : "root";
}

function visibleTextProblems(value: unknown, path: string): string[] {
  if (typeof value === "string") {
    // Code and formula syntax is reviewed as a separate visual element.
    if (/\.(code|latex|url)$/.test(path)) return [];
    const words = value.match(/[\p{L}\p{N}]+(?:['’\-][\p{L}\p{N}]+)*/gu) ?? [];
    return words.length > 7 ? [`${path}: on-screen text block exceeds seven words`] : [];
  }
  if (Array.isArray(value)) return value.flatMap((entry, index) => visibleTextProblems(entry, `${path}.${index}`));
  if (value && typeof value === "object") return Object.entries(value).flatMap(([key, entry]) => visibleTextProblems(entry, `${path}.${key}`));
  return [];
}

export function validateIR(raw: unknown): IRValidation {
  const envelope = VideoIRSchema.safeParse(raw);
  if (!envelope.success) return {
    ok: false,
    problems: envelope.error.issues.map((issue) => `${jsonPath(issue.path)}: ${issue.message}`),
  };

  const ir = envelope.data;
  const problems: string[] = [];
  if (new Set(ir.aspects).size !== ir.aspects.length) problems.push("aspects: duplicate aspect");
  ir.scenes.forEach((scene, index) => {
    const path = `scenes.${index}`;
    const expectedId = `s${String(index + 1).padStart(2, "0")}`;
    if (scene.id !== expectedId) problems.push(`${path}.id: expected ${expectedId}`);
    const parsedProps = registry[scene.component].schema.safeParse(scene.props);
    if (!parsedProps.success) problems.push(...parsedProps.error.issues.map((issue) => `${path}.props.${jsonPath(issue.path)}: ${issue.message}`));
    else {
      problems.push(...visibleTextProblems(parsedProps.data, `${path}.props`));
      if (scene.component === "KineticHeadline" && "words" in parsedProps.data
          && Array.isArray(parsedProps.data.words) && parsedProps.data.words.length > 7) {
        problems.push(`${path}.props.words: headline exceeds seven words`);
      }
    }
    if (scene.component === "ThumbnailCard") problems.push(`${path}.component: ThumbnailCard is a still, not a video scene`);
    if (index === 0 && scene.component !== "TitleCard" && scene.component !== "SectionCard") problems.push(`${path}.component: video must open with TitleCard or SectionCard`);
    if (index === 0 && scene.transitionIn !== "cut") problems.push(`${path}.transitionIn: opening scene must use cut`);
    if (index > 0 && scene.component === ir.scenes[index - 1]?.component) problems.push(`${path}.component: consecutive scenes must use different components`);
    if (index > 0 && scene.transitionIn === "wipeBrand"
        && scene.component !== "TitleCard" && ir.scenes[index - 1]?.component !== "TitleCard") {
      problems.push(`${path}.transitionIn: brand wipe requires a TitleCard boundary`);
    }
    // Colour is a theme role, never a model-supplied literal in the IR.
    if (/#[0-9a-f]{3,8}\b/i.test(JSON.stringify(scene.props))) problems.push(`${path}.props: literal hex colours are not permitted`);
  });
  if (ir.scenes.at(-1)?.component !== "Outro") problems.push("scenes: video must end with Outro");
  return problems.length ? { ok: false, problems } : { ok: true, ir };
}

export function parseIR(raw: unknown): VideoIR {
  const result = validateIR(raw);
  if (!result.ok) throw new Error(`Invalid video IR:\n${result.problems.join("\n")}`);
  return result.ir;
}
