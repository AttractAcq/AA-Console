import { scaleBand, scaleLinear, scaleOrdinal } from "d3-scale";
import { arc, line, pie, type PieArcDatum } from "d3-shape";
import { useCurrentFrame, useVideoConfig } from "remotion";
import { z } from "zod";
import { SafeArea, centeredTextRegion, useStage } from "../primitives/Stage.js";

export const name = "Chart";
export const schema = z.strictObject({
  kind: z.enum(["bar", "line", "pie"]),
  series: z.array(z.strictObject({ name: z.string().trim().min(1).max(28), values: z.array(z.number().finite().nonnegative()) })).min(1).max(3),
  categories: z.array(z.string().trim().min(1).max(32)).min(2).max(8),
  highlight: z.string().trim().optional(),
}).superRefine((value, ctx) => {
  if (value.series.some((series) => series.values.length !== value.categories.length)) ctx.addIssue({ code: "custom", message: "Every series needs one value per category" });
  if (value.kind === "pie" && value.series.length !== 1) ctx.addIssue({ code: "custom", message: "Pie charts need one series" });
  if (value.highlight && !value.categories.includes(value.highlight)) ctx.addIssue({ code: "custom", message: "Highlight must name a category" });
});
export type Props = z.infer<typeof schema>;
export const catalogueText = "Shows a small sourced data comparison as a bar, line, or pie chart. Use two to eight categories and no more than three series; label units in narration or adjacent copy.";
export const textRegion = (aspect: Parameters<typeof centeredTextRegion>[0]) => ({ ...centeredTextRegion(aspect), y: 0.19, height: 0.58 });
const short = (label: string) => label.length > 12 ? `${label.slice(0, 11)}…` : label;

export function Component({ kind, series, categories, highlight }: Props) {
  const { theme, aspect } = useStage();
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const progress = Math.min(1, frame / fps);
  const palette = [theme.tokens.colours.primary, theme.tokens.colours.secondary, theme.tokens.colours.accent];
  const portrait = aspect === "9:16";
  const max = Math.max(1, ...series.flatMap((item) => item.values));
  const x = scaleBand<string>().domain(categories).range([90, 900]).padding(0.17);
  const y = scaleLinear().domain([0, max]).nice().range([540, 65]);
  const sub = scaleBand<string>().domain(series.map((item) => item.name)).range([0, x.bandwidth()]).padding(0.08);
  const ordinal = scaleOrdinal<string, string>().domain(categories).range(palette.concat(palette));
  const pieData = pie<number>().sort(null).value((value) => value)(series[0]!.values);
  const slice = arc<PieArcDatum<number>>().innerRadius(0).outerRadius(230);
  const ticks = y.ticks(4).filter((tick) => tick >= 0);
  return <SafeArea style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 20 }}>
    <div style={{ alignSelf: "stretch", display: "flex", gap: 28, justifyContent: "center", fontSize: portrait ? 25 : 30, fontWeight: 700 }}>
      {series.map((item, index) => <div key={item.name} style={{ color: palette[index] }}>{item.name}</div>)}
    </div>
    <svg viewBox="0 0 1000 650" role="img" aria-label={`${kind} chart with ${categories.length} categories`} style={{ width: "100%", maxHeight: portrait ? 730 : 610, overflow: "visible" }}>
      {kind === "bar" && <>
        {ticks.map((tick) => <g key={tick}><line x1={90} y1={y(tick)} x2={910} y2={y(tick)} stroke={theme.tokens.colours.muted} strokeOpacity={0.16} strokeWidth={2} /><text x={74} y={y(tick) + 10} textAnchor="end" fill={theme.tokens.colours.muted} fontSize={24}>{tick}</text></g>)}
        <line x1={90} y1={540} x2={910} y2={540} stroke={theme.tokens.colours.muted} strokeWidth={3} />
        {categories.map((category) => <g key={category}>
          {series.map((item, index) => <rect key={item.name} x={x(category)! + sub(item.name)!} y={y(item.values[categories.indexOf(category)]! * progress)} width={sub.bandwidth()} height={540 - y(item.values[categories.indexOf(category)]! * progress)} fill={palette[index]} opacity={highlight && highlight !== category ? 0.35 : 1} rx={8} />)}
          <text x={x(category)! + x.bandwidth() / 2} y={585} textAnchor="middle" fill={theme.tokens.colours.text} fontSize={portrait ? 25 : 28}>{short(category)}</text>
        </g>)}
      </>}
      {kind === "line" && <>
        {ticks.map((tick) => <g key={tick}><line x1={90} y1={y(tick)} x2={910} y2={y(tick)} stroke={theme.tokens.colours.muted} strokeOpacity={0.16} strokeWidth={2} /><text x={74} y={y(tick) + 10} textAnchor="end" fill={theme.tokens.colours.muted} fontSize={24}>{tick}</text></g>)}
        <line x1={90} y1={540} x2={910} y2={540} stroke={theme.tokens.colours.muted} strokeWidth={3} />
        {series.map((item, index) => {
          const path = line<number>().x((_, i) => x(categories[i]!)! + x.bandwidth() / 2).y((value) => y(value * progress))(item.values);
          return <g key={item.name}><path d={path ?? ""} fill="none" stroke={palette[index]} strokeWidth={9} strokeLinecap="round" strokeLinejoin="round" />{item.values.map((value, i) => <circle key={i} cx={x(categories[i]!)! + x.bandwidth() / 2} cy={y(value * progress)} r={10} fill={palette[index]} />)}</g>;
        })}
        {categories.map((category) => <text key={category} x={x(category)! + x.bandwidth() / 2} y={585} textAnchor="middle" fill={theme.tokens.colours.text} fontSize={portrait ? 25 : 28}>{short(category)}</text>)}
      </>}
      {kind === "pie" && <g transform="translate(500 310) scale(1)">
        {pieData.map((part, index) => <path key={index} d={slice({ ...part, endAngle: part.startAngle + (part.endAngle - part.startAngle) * progress }) ?? ""} fill={ordinal(categories[index]!)} opacity={highlight && highlight !== categories[index] ? 0.35 : 1} stroke={theme.tokens.colours.background} strokeWidth={6} />)}
      </g>}
    </svg>
    {kind === "pie" && <div style={{ display: "flex", flexWrap: "wrap", justifyContent: "center", gap: 18, fontSize: portrait ? 24 : 28 }}>{categories.map((category, index) => <span key={category} style={{ color: ordinal(category) }}>● {short(category)}: {series[0]!.values[index]}</span>)}</div>}
  </SafeArea>;
}
