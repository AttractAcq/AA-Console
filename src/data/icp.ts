export type IcpItemType = "core" | "question";

export type IcpItem = {
  id: string;
  label: string;
  type: IcpItemType;
  description: string;
};

export const icpItems: IcpItem[] = [
  {
    id: "avatar-role-map",
    label: "Avatar role map",
    type: "core",
    description: "Buyer roles and segments",
  },
  {
    id: "visual-identity",
    label: "Visual identity",
    type: "core",
    description: "Visible commercial and lifestyle cues",
  },
  {
    id: "social-circle",
    label: "Social circle",
    type: "core",
    description: "Peers, validators, communities and influence groups",
  },
  {
    id: "status-markers",
    label: "Status markers",
    type: "core",
    description: "Signals of progress, credibility, taste and aspiration",
  },
  {
    id: "daily-environment",
    label: "Daily environment",
    type: "core",
    description: "Routines, constraints, places, pressures and tools",
  },
  {
    id: "trusted-advisors",
    label: "Trusted advisors",
    type: "core",
    description: "People and proof sources trusted before decisions",
  },
  {
    id: "objections",
    label: "Objections",
    type: "core",
    description: "Doubts, delay reasons, barriers and category fatigue",
  },
  {
    id: "purchase-trigger",
    label: "Purchase trigger",
    type: "core",
    description: "Events that move the buyer into active consideration",
  },
  {
    id: "language-patterns",
    label: "Language patterns",
    type: "core",
    description: "How buyers describe problems, goals, risks and alternatives",
  },
  {
    id: "desired-outcomes",
    label: "Desired outcomes",
    type: "core",
    description: "Concrete and emotional definitions of success",
  },
  {
    id: "risk-and-fears",
    label: "Risk and fears",
    type: "core",
    description: "Regret, exposure, switching anxiety and downside scenarios",
  },
  {
    id: "attention-channels",
    label: "Attention channels",
    type: "core",
    description: "Where buyers search, learn, compare and validate claims",
  },
  {
    id: "decision-criteria",
    label: "Decision criteria",
    type: "core",
    description: "Comparison logic, must-haves, disqualifiers and trade-offs",
  },
  {
    id: "question-universe",
    label: "Question universe",
    type: "question",
    description: "Questions buyers ask across awareness, objections and decisions",
  },
  {
    id: "buyer-role-system",
    label: "Buyer role system",
    type: "core",
    description: "Legacy or unscheduled Avatar Intelligence module",
  },
];
