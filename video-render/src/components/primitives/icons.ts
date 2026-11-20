import {
  ArrowRight, ChartNoAxesCombined, CircleCheck, FileText, Lightbulb,
  Megaphone, ShieldCheck, Sparkles, Target, Workflow,
} from "lucide-react";
import { z } from "zod";

export const IconNameSchema = z.enum([
  "ArrowRight", "ChartNoAxesCombined", "CircleCheck", "FileText", "Lightbulb",
  "Megaphone", "ShieldCheck", "Sparkles", "Target", "Workflow",
]);
export type IconName = z.infer<typeof IconNameSchema>;
export const ICONS = {
  ArrowRight, ChartNoAxesCombined, CircleCheck, FileText, Lightbulb,
  Megaphone, ShieldCheck, Sparkles, Target, Workflow,
} satisfies Record<IconName, typeof ArrowRight>;
