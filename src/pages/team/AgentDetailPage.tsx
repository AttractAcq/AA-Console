import { PageHeader } from "../../components/PageHeader";
import { agentSections } from "../../data/agents";
import { AgentOverviewSection } from "./sections/AgentOverviewSection";
import { AgentActionsSection } from "./sections/AgentActionsSection";
import { AgentLogsSection } from "./sections/AgentLogsSection";

export function AgentDetailPage({ sectionId }: { sectionId: string }) {
  const section = agentSections.find((s) => s.id === sectionId);

  return (
    <div>
      <PageHeader title={section?.label ?? "Section"} />
      {sectionId === "overview" && <AgentOverviewSection />}
      {sectionId === "actions" && <AgentActionsSection />}
      {sectionId === "logs" && <AgentLogsSection />}
    </div>
  );
}
