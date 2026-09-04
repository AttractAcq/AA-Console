import { useParams } from "react-router-dom";
import { PageHeader } from "../../components/PageHeader";
import { getMemberSections, isTeamCategory } from "../../data/team";
import { OverviewSection } from "./sections/OverviewSection";
import { CurrentJobsSection } from "./sections/CurrentJobsSection";
import { CurrentClientsSection } from "./sections/CurrentClientsSection";
import { FinishedWorkSection } from "./sections/FinishedWorkSection";
import { LoggedWorkSection } from "./sections/LoggedWorkSection";
import { ContractSection } from "./sections/ContractSection";

export function MemberDetailPage({ sectionId }: { sectionId: string }) {
  const { category } = useParams<{ category: string }>();
  const sections = isTeamCategory(category) ? getMemberSections(category) : [];
  const section = sections.find((s) => s.id === sectionId);
  const isSmm = category === "smm";

  return (
    <div>
      <PageHeader title={section?.label ?? "Section"} />
      {sectionId === "overview" && <OverviewSection />}
      {sectionId === "current-jobs" &&
        (isSmm ? <CurrentClientsSection /> : <CurrentJobsSection />)}
      {sectionId === "finished-work" &&
        (isSmm ? <LoggedWorkSection /> : <FinishedWorkSection />)}
      {sectionId === "contract" && <ContractSection />}
    </div>
  );
}
