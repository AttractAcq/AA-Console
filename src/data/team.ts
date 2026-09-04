export type TeamCategory = "avatars" | "editors" | "smm";

export type EngagementType = "Employee" | "Contractor";

export type TeamMember = {
  id: string;
  name: string;
  initials: string;
  engagementType: EngagementType;
};

export const teamMembers: Record<TeamCategory, TeamMember[]> = {
  avatars: [{ id: "avatar-1", name: "Maya Chen", initials: "MC", engagementType: "Employee" }],
  editors: [{ id: "editor-1", name: "Leo Whitfield", initials: "LW", engagementType: "Employee" }],
  smm: [{ id: "smm-1", name: "Nina Torres", initials: "NT", engagementType: "Employee" }],
};

export const teamCategoryLabels: Record<TeamCategory, { label: string; addButtonLabel: string }> = {
  avatars: { label: "Avatars", addButtonLabel: "Add Avatar" },
  editors: { label: "Editors", addButtonLabel: "Add Editor" },
  smm: { label: "SMM", addButtonLabel: "Add SMM" },
};

export type MemberSection = { id: string; label: string };

export const memberSections: MemberSection[] = [
  { id: "overview", label: "Overview" },
  { id: "current-jobs", label: "Current Jobs" },
  { id: "finished-work", label: "Finished Work" },
  { id: "contract", label: "Contract" },
];

const memberSectionLabelOverrides: Partial<Record<TeamCategory, Record<string, string>>> = {
  smm: {
    "current-jobs": "Current Clients",
    "finished-work": "Logged Work",
  },
};

export function getMemberSections(category: TeamCategory): MemberSection[] {
  const overrides = memberSectionLabelOverrides[category] ?? {};
  return memberSections.map((section) => ({
    ...section,
    label: overrides[section.id] ?? section.label,
  }));
}

export function isTeamCategory(value: string | undefined): value is TeamCategory {
  return value === "avatars" || value === "editors" || value === "smm";
}

export function findTeamMember(
  category: string | undefined,
  memberId: string | undefined,
): TeamMember | undefined {
  if (!isTeamCategory(category) || !memberId) return undefined;
  return teamMembers[category].find((member) => member.id === memberId);
}
