export type AgentStatus = "Active" | "Idle" | "Archived";

export type Agent = {
  id: string;
  name: string;
  initials: string;
  status: AgentStatus;
};

export const agents: Agent[] = [
  { id: "agent-1", name: "Agent 1", initials: "A1", status: "Active" },
];

export type AgentSection = { id: string; label: string };

export const agentSections: AgentSection[] = [
  { id: "overview", label: "Overview" },
  { id: "actions", label: "Actions" },
  { id: "logs", label: "Logs" },
];
