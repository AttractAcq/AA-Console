import type { ComponentName } from "./registry.js";

export const demoFixtures = {
  TitleCard: { title: "Build a clearer route to growth", subtitle: "A simple operating system for service businesses", kicker: "ATTRACT ACQUISITION" },
  SectionCard: { index: 1, title: "Find the buying moment" },
  KineticHeadline: { words: ["Understand", "the", "moment", "before", "you", "make", "the", "offer"], emphasis: [2, 7] },
  BulletReveal: { heading: "A sharper starting point", items: ["Find the buying signal", "Match the offer to the need", "Review each asset before launch"], icon: "CircleCheck" },
  StepFlow: { steps: [{ label: "Discover", detail: "Identify a buying situation", icon: "Target" }, { label: "Develop", detail: "Build an offer around it", icon: "Sparkles" }, { label: "Review", detail: "Check every release asset", icon: "ShieldCheck" }] },
  Compare: { left: { title: "Broad message", points: ["Same claim for everyone", "Unclear next action"] }, right: { title: "Specific offer", points: ["Clear buying situation", "One relevant next step"] } },
  Timeline: { events: [{ at: "Week 1", label: "Research" }, { at: "Week 2", label: "Build" }, { at: "Week 3", label: "Review" }, { at: "Week 4", label: "Launch" }] },
  ProcessDiagram: { nodes: [{ id: "signal", label: "Buying signal", icon: "Target" }, { id: "offer", label: "Relevant offer", icon: "Sparkles" }, { id: "review", label: "Human review", icon: "ShieldCheck" }, { id: "release", label: "Release", icon: "ArrowRight" }], edges: [{ from: "signal", to: "offer" }, { from: "offer", to: "review" }, { from: "review", to: "release" }] },
  BigNumber: { value: 3, unit: "steps", label: "From opportunity to reviewed launch assets" },
  Chart: { kind: "bar", series: [{ name: "Leads", values: [6, 11, 15, 23] }], categories: ["Research", "Offer", "Content", "Launch"], highlight: "Launch" },
  Equation: { latex: "\\text{Growth} = \\text{Reach} \\times \\text{Conversion}", highlightTerms: ["Reach", "Conversion"] },
  CodeBlock: { language: "TypeScript", code: "const opportunity = discover();\nconst offer = buildOffer(opportunity);\nconst campaign = review(offer);", revealLines: [[0], [1], [2]] },
  Quote: { text: "Clarity comes from seeing the whole journey, not just the next post.", attribution: "AA working principle" },
  Outro: { headline: "Ready to turn insight into action?", cta: "Explore the next step", url: "attractacq.com" },
  ThumbnailCard: { hook: "A clearer route to growth", kicker: "ATTRACT ACQUISITION" },
} satisfies Record<ComponentName, unknown>;
