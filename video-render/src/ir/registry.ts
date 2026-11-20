import * as TitleCard from "../components/explain/TitleCard.js";
import * as SectionCard from "../components/explain/SectionCard.js";
import * as Outro from "../components/explain/Outro.js";
import * as KineticHeadline from "../components/explain/KineticHeadline.js";
import * as BulletReveal from "../components/explain/BulletReveal.js";
import * as StepFlow from "../components/explain/StepFlow.js";
import * as Compare from "../components/explain/Compare.js";
import * as Timeline from "../components/explain/Timeline.js";
import * as ProcessDiagram from "../components/explain/ProcessDiagram.js";
import * as BigNumber from "../components/explain/BigNumber.js";
import * as Quote from "../components/explain/Quote.js";
import * as ThumbnailCard from "../components/explain/ThumbnailCard.js";
import * as Chart from "../components/explain/Chart.js";
import * as Equation from "../components/explain/Equation.js";
import * as CodeBlock from "../components/explain/CodeBlock.js";

export const registry = {
  TitleCard, SectionCard, KineticHeadline, BulletReveal, StepFlow, Compare,
  Timeline, ProcessDiagram, BigNumber, Chart, Equation, CodeBlock,
  Quote, Outro, ThumbnailCard,
} as const;
export type ComponentName = keyof typeof registry;

export function validateComponentProps(name: ComponentName, props: unknown) {
  return registry[name].schema.parse(props);
}
