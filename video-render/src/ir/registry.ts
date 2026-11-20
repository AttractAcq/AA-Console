import * as TitleCard from "../components/explain/TitleCard.js";
import * as SectionCard from "../components/explain/SectionCard.js";
import * as Outro from "../components/explain/Outro.js";

export const registry = { TitleCard, SectionCard, Outro } as const;
export type ComponentName = keyof typeof registry;

export function validateComponentProps(name: ComponentName, props: unknown) {
  return registry[name].schema.parse(props);
}
