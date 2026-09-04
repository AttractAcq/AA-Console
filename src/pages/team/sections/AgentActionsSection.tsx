import { useState } from "react";
import { Play, Pause, Settings } from "lucide-react";
import { ActionCard } from "../../../components/ActionCard";
import { Modal } from "../../../components/Modal";

const actions = [
  { id: "run", label: "Run Agent", icon: Play },
  { id: "pause", label: "Pause Agent", icon: Pause },
  { id: "configure", label: "Edit Configuration", icon: Settings },
];

export function AgentActionsSection() {
  const [openActionId, setOpenActionId] = useState<string | null>(null);
  const openAction = actions.find((action) => action.id === openActionId);

  return (
    <div>
      <div className="grid gap-4 md:grid-cols-3">
        {actions.map((action) => (
          <ActionCard
            key={action.id}
            title={action.label}
            icon={action.icon}
            onClick={() => setOpenActionId(action.id)}
          />
        ))}
      </div>

      <Modal
        open={openAction !== undefined}
        onClose={() => setOpenActionId(null)}
        title={openAction?.label ?? ""}
      />
    </div>
  );
}
