import type { PropsWithChildren } from "react";
import { z } from "zod";
import { SafeArea, useStage } from "./Stage.js";

export const GridSchema = z.strictObject({
  columns: z.number().int().min(1).max(12).default(12),
  gap: z.number().min(0).max(96).default(24),
});
export type GridProps = z.input<typeof GridSchema>;

export function Grid({ children, columns, gap }: PropsWithChildren<GridProps>) {
  const parsed = GridSchema.parse({ columns, gap });
  const { aspect } = useStage();
  const resolvedColumns = aspect === "9:16" ? Math.min(parsed.columns, 6) : parsed.columns;
  return <SafeArea style={{ display: "grid", gridTemplateColumns: `repeat(${resolvedColumns}, minmax(0, 1fr))`, gap: parsed.gap }}>
    {children}
  </SafeArea>;
}
