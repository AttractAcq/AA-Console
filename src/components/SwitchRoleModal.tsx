import { Briefcase, Building2, Users } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { Modal } from "./Modal";

export type ConsoleRole = "admin" | "client" | "employee";

const ROLE_OPTIONS: Record<ConsoleRole, { label: string; icon: LucideIcon; loginPath: string }> = {
  admin: { label: "Admin", icon: Building2, loginPath: "/login" },
  client: { label: "Client", icon: Users, loginPath: "/client/login" },
  employee: { label: "Employee", icon: Briefcase, loginPath: "/employee/login" },
};

export function SwitchRoleModal({
  open,
  onClose,
  exclude,
}: {
  open: boolean;
  onClose: () => void;
  exclude: ConsoleRole;
}) {
  const navigate = useNavigate();
  const roles = (Object.keys(ROLE_OPTIONS) as ConsoleRole[]).filter((role) => role !== exclude);

  return (
    <Modal open={open} onClose={onClose} title="Select your role">
      <div className="space-y-2">
        {roles.map((role) => {
          const { label, icon: Icon, loginPath } = ROLE_OPTIONS[role];
          return (
            <button
              key={role}
              type="button"
              onClick={() => navigate(loginPath)}
              className="flex w-full items-center gap-3 rounded-md border border-border px-4 py-3 text-left text-sm font-medium text-foreground transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <Icon className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
              {label}
            </button>
          );
        })}
      </div>
    </Modal>
  );
}
