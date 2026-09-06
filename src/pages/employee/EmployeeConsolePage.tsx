import { useParams } from "react-router-dom";
import { ConsoleShell } from "../../components/ConsoleShell";
import { EmptyState } from "../../components/EmptyState";
import { EmployeeAccountView } from "./sections/EmployeeAccountView";
import { findConsolePage } from "../../config/consoleNav";
import { useAuth } from "../../context/auth";
import { EMPLOYEE_CATEGORY_LABEL } from "../../lib/identity";
import type { EmployeeCategory } from "../../lib/identity";
import { SmmWorkspace } from "./sections/SmmWorkspace";
import { ProductionWorkspace } from "./sections/ProductionWorkspace";
import { JobsTable } from "./sections/JobsTable";
import { ClientsTable } from "./sections/ClientsTable";
import { ChatView } from "../../components/chat/ChatView";

/** Avatars work jobs; editors work projects. Same table, different word. */
const NOUN: Partial<Record<EmployeeCategory, "Job" | "Project">> = {
  avatars: "Job",
  editors: "Project",
};

/**
 * One route, three consoles. Which nav and which body render is decided by
 * employee_category, which comes from the account's auth metadata.
 */
export function EmployeeConsolePage() {
  const { profile } = useAuth();
  const { page: pageId } = useParams<{ page: string }>();
  const category = profile?.employee_category ?? null;
  const memberId = profile?.member_id ?? null;

  if (!memberId || !category) {
    return (
      <ConsoleShell
        role="employee"
        kind="avatars"
        basePath="/employee"
        title="AA Employee Console"
        heading="Dashboard"
      >
        <EmptyState label="This account is not linked to a team member yet. Ask an admin to set it up." />
      </ConsoleShell>
    );
  }

  const page = findConsolePage(category, pageId);
  const noun = NOUN[category];

  function body() {
    if (page.id === "chat") {
      return <ChatView />;
    }

    if (page.id === "dashboard") {
      return category === "smm" ? (
        <SmmWorkspace memberId={memberId!} />
      ) : (
        <ProductionWorkspace memberId={memberId!} variant={category as "editors" | "avatars"} />
      );
    }

    if (noun && (page.id === "current-jobs" || page.id === "current-projects")) {
      return <JobsTable memberId={memberId!} scope="current" noun={noun} />;
    }

    if (noun && (page.id === "past-jobs" || page.id === "past-projects")) {
      return <JobsTable memberId={memberId!} scope="past" noun={noun} />;
    }

    if (page.id === "current-clients") {
      return <ClientsTable memberId={memberId!} scope="current" />;
    }

    if (page.id === "past-clients") {
      return <ClientsTable memberId={memberId!} scope="past" />;
    }

    if (page.id === "account") {
      return <EmployeeAccountView memberId={memberId!} />;
    }

    return <EmptyState label={`${page.label} — coming soon`} />;
  }

  return (
    <ConsoleShell
      role="employee"
      kind={category}
      basePath="/employee"
      title="AA Employee Console"
      subtitle={EMPLOYEE_CATEGORY_LABEL[category]}
      heading={page.label}
    >
      {body()}
    </ConsoleShell>
  );
}
