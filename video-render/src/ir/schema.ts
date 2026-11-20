import { z } from "zod";
import { AspectSchema } from "../components/primitives/Stage.js";
import { TransitionNameSchema } from "../components/primitives/TransitionPresets.js";
import { registry, type ComponentName } from "./registry.js";
import { semanticProblems } from "./semantic.js";

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

export function validateIR(raw: unknown): IRValidation {
  const envelope = VideoIRSchema.safeParse(raw);
  if (!envelope.success) return {
    ok: false,
    problems: envelope.error.issues.map((issue) => `${jsonPath(issue.path)}: ${issue.message}`),
  };

  const ir = envelope.data;
  const problems: string[] = [];
  ir.scenes.forEach((scene, index) => {
    const path = `scenes.${index}`;
    const parsedProps = registry[scene.component].schema.safeParse(scene.props);
    if (!parsedProps.success) problems.push(...parsedProps.error.issues.map((issue) => `${path}.props.${jsonPath(issue.path)}: ${issue.message}`));
  });
  problems.push(...semanticProblems(ir));
  return problems.length ? { ok: false, problems } : { ok: true, ir };
}

export function parseIR(raw: unknown): VideoIR {
  const result = validateIR(raw);
  if (!result.ok) throw new Error(`Invalid video IR:\n${result.problems.join("\n")}`);
  return result.ir;
}
