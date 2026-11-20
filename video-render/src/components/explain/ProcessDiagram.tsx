import { z } from "zod";
import { SafeArea, centeredTextRegion, useStage } from "../primitives/Stage.js";

export const name = "ProcessDiagram";
export const schema = z.strictObject({
  nodes: z.array(z.strictObject({ id: z.string().regex(/^[a-z][a-z0-9_]*$/), label: z.string().trim().min(1).max(24) })).min(2).max(7),
  edges: z.array(z.strictObject({ from: z.string(), to: z.string(), label: z.string().trim().max(20).optional() })).min(1).max(9),
}).superRefine((value, ctx) => {
  const ids = new Set(value.nodes.map((node) => node.id));
  if (ids.size !== value.nodes.length) ctx.addIssue({ code: "custom", message: "Duplicate node ID" });
  for (const edge of value.edges) if (!ids.has(edge.from) || !ids.has(edge.to) || edge.from === edge.to) ctx.addIssue({ code: "custom", message: "Invalid edge" });
  if (ids.size === value.nodes.length && value.edges.every((edge) => ids.has(edge.from) && ids.has(edge.to) && edge.from !== edge.to)) {
    try { layoutLayers(value); } catch { ctx.addIssue({ code: "custom", message: "ProcessDiagram has a cycle" }); }
  }
});
export type Props = z.infer<typeof schema>;
export const catalogueText = "Shows a small directed process using named nodes and edges. The layout is deterministic and has no author-supplied coordinates. Avoid cyclic or densely connected graphs.";
export const textRegion = (aspect: Parameters<typeof centeredTextRegion>[0]) => ({ ...centeredTextRegion(aspect), y: 0.22, height: 0.55 });

export function layoutLayers({ nodes, edges }: Props): string[][] {
  const incoming = new Map(nodes.map((node) => [node.id, 0]));
  for (const edge of edges) incoming.set(edge.to, (incoming.get(edge.to) ?? 0) + 1);
  const layers: string[][] = [];
  const seen = new Set<string>();
  while (seen.size < nodes.length) {
    const next = nodes.filter((node) => !seen.has(node.id) && incoming.get(node.id) === 0).map((node) => node.id);
    if (next.length === 0) throw new Error("ProcessDiagram has a cycle");
    layers.push(next);
    for (const id of next) {
      seen.add(id);
      for (const edge of edges.filter((candidate) => candidate.from === id)) incoming.set(edge.to, (incoming.get(edge.to) ?? 0) - 1);
    }
  }
  return layers;
}

export function Component(props: Props) {
  const { theme, aspect } = useStage();
  const layers = layoutLayers(props);
  const vertical = aspect === "9:16";
  const labels = new Map(props.nodes.map((node) => [node.id, node.label]));
  return <SafeArea style={{ display: "flex", flexDirection: vertical ? "column" : "row", justifyContent: "center", alignItems: "center", gap: vertical ? 12 : 18 }}>
    {layers.map((layer, index) => <div key={index} style={{ flex: 1, display: "flex", flexDirection: vertical ? "column" : "row", justifyContent: "center", alignItems: "center", gap: 18, width: vertical ? "100%" : undefined }}>
      {layer.map((id) => <div key={id} style={{ flex: 1, minWidth: 0, padding: vertical ? 24 : 30, borderRadius: theme.tokens.radii.card, background: theme.tokens.colours.surface, border: `3px solid ${theme.tokens.colours.secondary}`, textAlign: "center", fontSize: vertical ? 31 : 34, fontWeight: 750 }}>{labels.get(id)}</div>)}
      {index < layers.length - 1 && <div aria-hidden style={{ color: theme.tokens.colours.secondary, fontSize: 46 }}>{vertical ? "↓" : "→"}</div>}
    </div>)}
  </SafeArea>;
}
