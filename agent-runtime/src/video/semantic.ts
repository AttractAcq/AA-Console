// Pure IR checks shared with the agent runtime. Component JSON shapes are
// checked separately by Zod in the renderer and by its exported JSON Schema
// in the runtime. Keep this module free of Remotion and provider imports.
type Scene = {
  id: string;
  component: string;
  props: unknown;
  transitionIn?: string;
};
type IR = { aspects: string[]; scenes: Scene[] };

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

function visibleTextProblems(value: unknown, path: string): string[] {
  if (typeof value === "string") {
    if (/\.(code|latex|url)$/.test(path)) return [];
    const words = value.match(/[\p{L}\p{N}]+(?:['’\-][\p{L}\p{N}]+)*/gu) ?? [];
    return words.length > 7 ? [`${path}: on-screen text block exceeds seven words`] : [];
  }
  if (Array.isArray(value)) return value.flatMap((entry, index) => visibleTextProblems(entry, `${path}.${index}`));
  const object = record(value);
  if (object) return Object.entries(object).flatMap(([key, entry]) => visibleTextProblems(entry, `${path}.${key}`));
  return [];
}

function componentRefinements(scene: Scene, path: string): string[] {
  const props = record(scene.props);
  if (!props) return [];
  const problems: string[] = [];
  if (scene.component === "BulletReveal") {
    const items = Array.isArray(props.items) ? props.items : [];
    const times = Array.isArray(props.revealAt) ? props.revealAt : undefined;
    if (times && times.length !== items.length) problems.push(`${path}.props.revealAt: one reveal time per item`);
  }
  if (scene.component === "KineticHeadline") {
    const words = Array.isArray(props.words) ? props.words : [];
    const times = Array.isArray(props.revealAt) ? props.revealAt : undefined;
    const emphasis = Array.isArray(props.emphasis) ? props.emphasis as number[] : undefined;
    if (words.length > 7) problems.push(`${path}.props.words: headline exceeds seven words`);
    if (times && times.length !== words.length) problems.push(`${path}.props.revealAt: one reveal time per word`);
    if (emphasis?.some((index) => index >= words.length)) problems.push(`${path}.props.emphasis: index outside words`);
  }
  if (scene.component === "Chart") {
    const categories = Array.isArray(props.categories) ? props.categories as string[] : [];
    const series = Array.isArray(props.series) ? props.series as { values: number[] }[] : [];
    if (series.some((entry) => !Array.isArray(entry?.values) || entry.values.length !== categories.length)) problems.push(`${path}.props.series: one value per category required`);
    if (props.kind === "pie" && series.length !== 1) problems.push(`${path}.props.series: pie chart needs one series`);
    if (props.highlight && !categories.includes(props.highlight as string)) problems.push(`${path}.props.highlight: unknown category`);
  }
  if (scene.component === "CodeBlock") {
    const lineCount = typeof props.code === "string" ? props.code.split("\n").length : 0;
    const groups = Array.isArray(props.revealLines) ? props.revealLines as number[][] : undefined;
    if (groups?.some((group) => Array.isArray(group) && group.some((index) => index >= lineCount))) problems.push(`${path}.props.revealLines: line outside code`);
  }
  if (scene.component === "ProcessDiagram") {
    const nodes = Array.isArray(props.nodes)
      ? props.nodes.filter((node): node is { id: string } => typeof record(node)?.id === "string") : [];
    const edges = Array.isArray(props.edges)
      ? props.edges.filter((edge): edge is { from: string; to: string } =>
        typeof record(edge)?.from === "string" && typeof record(edge)?.to === "string") : [];
    const ids = new Set(nodes.map((node) => node.id));
    if (ids.size !== nodes.length) problems.push(`${path}.props.nodes: duplicate node ID`);
    if (edges.some((edge) => !ids.has(edge.from) || !ids.has(edge.to) || edge.from === edge.to)) {
      problems.push(`${path}.props.edges: invalid edge`);
    } else {
      const incoming = new Map(nodes.map((node) => [node.id, 0]));
      for (const edge of edges) incoming.set(edge.to, (incoming.get(edge.to) ?? 0) + 1);
      const queue = nodes.filter((node) => incoming.get(node.id) === 0).map((node) => node.id);
      let visited = 0;
      while (queue.length) {
        const id = queue.shift()!;
        visited++;
        for (const edge of edges.filter((item) => item.from === id)) {
          const count = (incoming.get(edge.to) ?? 0) - 1;
          incoming.set(edge.to, count);
          if (count === 0) queue.push(edge.to);
        }
      }
      if (visited !== nodes.length) problems.push(`${path}.props.edges: ProcessDiagram has a cycle`);
    }
  }
  return problems;
}

export function semanticProblems(ir: IR): string[] {
  const problems: string[] = [];
  if (new Set(ir.aspects).size !== ir.aspects.length) problems.push("aspects: duplicate aspect");
  ir.scenes.forEach((scene, index) => {
    const path = `scenes.${index}`;
    const transition = scene.transitionIn ?? "cut";
    const expectedId = `s${String(index + 1).padStart(2, "0")}`;
    if (scene.id !== expectedId) problems.push(`${path}.id: expected ${expectedId}`);
    problems.push(...visibleTextProblems(scene.props, `${path}.props`));
    problems.push(...componentRefinements(scene, path));
    if (scene.component === "ThumbnailCard") problems.push(`${path}.component: ThumbnailCard is a still, not a video scene`);
    if (index === 0 && scene.component !== "TitleCard" && scene.component !== "SectionCard") problems.push(`${path}.component: video must open with TitleCard or SectionCard`);
    if (index === 0 && transition !== "cut") problems.push(`${path}.transitionIn: opening scene must use cut`);
    if (index > 0 && scene.component === ir.scenes[index - 1]?.component) problems.push(`${path}.component: consecutive scenes must use different components`);
    if (index > 0 && transition === "wipeBrand"
        && scene.component !== "TitleCard" && ir.scenes[index - 1]?.component !== "TitleCard") {
      problems.push(`${path}.transitionIn: brand wipe requires a TitleCard boundary`);
    }
    if (/#[0-9a-f]{3,8}\b/i.test(JSON.stringify(scene.props))) problems.push(`${path}.props: literal hex colours are not permitted`);
  });
  if (ir.scenes.at(-1)?.component !== "Outro") problems.push("scenes: video must end with Outro");
  return problems;
}
