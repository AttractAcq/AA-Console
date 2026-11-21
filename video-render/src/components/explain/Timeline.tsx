import { z } from "zod";
import { SafeArea, centeredTextRegion, useStage } from "../primitives/Stage.js";

export const name = "Timeline";
export const schema = z.strictObject({ events: z.array(z.strictObject({ label: z.string().trim().min(1).max(28), at: z.string().trim().min(1).max(18) })).min(2).max(7) });
export type Props = z.infer<typeof schema>;
export const catalogueText = "Shows two to seven milestones along one ordered path. The at label can be a date or phase name; the author must confirm chronology before use.";
export const textRegion = (aspect: Parameters<typeof centeredTextRegion>[0]) => ({ ...centeredTextRegion(aspect), y: 0.22, height: 0.55 });
export function Component({ events }: Props) {
  const { theme, aspect } = useStage();
  const vertical = aspect === "9:16";
  return <SafeArea style={{ display: "flex", flexDirection: vertical ? "column" : "row", justifyContent: "center", alignItems: "stretch", gap: vertical ? 18 : 0 }}>
    {events.map((event, index) => <div key={index} style={{ flex: 1, display: "flex", flexDirection: vertical ? "row" : "column", gap: 18, alignItems: vertical ? "center" : "flex-start", borderLeft: vertical ? `5px solid ${theme.tokens.colours.secondary}` : undefined, borderTop: vertical ? undefined : `5px solid ${theme.tokens.colours.secondary}`, padding: vertical ? "16px 24px" : "24px 16px", minWidth: 0 }}>
      <div style={{ flex: "none", width: 24, height: 24, borderRadius: 999, background: theme.tokens.colours.primary }} />
      <div><div style={{ color: theme.tokens.colours.secondary, fontSize: vertical ? 28 : 25, fontWeight: 800 }}>{event.at}</div><div style={{ marginTop: 8, fontSize: vertical ? 38 : 32, lineHeight: 1.2, fontWeight: 700 }}>{event.label}</div></div>
    </div>)}
  </SafeArea>;
}
