import { Composition } from "remotion";
import { z } from "zod";
import { AA_THEME, AspectSchema, DIMENSIONS, Stage } from "./components/primitives/Stage.js";
import * as TitleCard from "./components/explain/TitleCard.js";
import * as SectionCard from "./components/explain/SectionCard.js";
import * as Outro from "./components/explain/Outro.js";

const demos = [
  { id: "TitleCard", component: TitleCard.Component, schema: TitleCard.schema, props: { title: "Build a clearer route to growth", subtitle: "A simple operating system for service businesses", kicker: "ATTRACT ACQUISITION" } },
  { id: "SectionCard", component: SectionCard.Component, schema: SectionCard.schema, props: { index: 1, title: "Find the buying moment" } },
  { id: "Outro", component: Outro.Component, schema: Outro.schema, props: { headline: "Ready to turn insight into action?", cta: "Explore the next step", url: "attractacq.com" } },
] as const;

function Demo({ aspect, kind, props }: { aspect: z.infer<typeof AspectSchema>; kind: string; props: unknown }) {
  const demo = demos.find((item) => item.id === kind);
  if (!demo) throw new Error(`Unknown video component: ${kind}`);
  const validated = demo.schema.parse(props);
  const Component = demo.component as React.ComponentType<any>;
  return <Stage aspect={aspect} theme={AA_THEME}><Component {...validated} /></Stage>;
}

const DemoSchema = z.strictObject({ aspect: AspectSchema, kind: z.enum(["TitleCard", "SectionCard", "Outro"]), props: z.unknown() });

export function RemotionRoot() {
  return <>{demos.flatMap((demo) => AspectSchema.options.map((aspect) => {
    const { width, height } = DIMENSIONS[aspect];
    return <Composition
      key={`${demo.id}-${aspect}`}
      id={`${demo.id}-${aspect.replace(":", "x")}`}
      component={Demo}
      durationInFrames={150}
      fps={30}
      width={width}
      height={height}
      defaultProps={{ aspect, kind: demo.id, props: demo.props }}
      calculateMetadata={({ props }) => { const input = DemoSchema.parse(props); demos.find((item) => item.id === input.kind)!.schema.parse(input.props); return {}; }}
    />;
  }))}</>;
}
