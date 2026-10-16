import { useEffect, useState } from "react";
import { Bot, X } from "lucide-react";
import { useAuth } from "../../context/auth";
import type { MasterScope } from "../../lib/masterAI";
import { MasterAIChat } from "./MasterAIChat";

export function MasterAIChatDialog({ scope }: { scope: MasterScope }) {
  const { profile } = useAuth();
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === "Escape") setOpen(false); };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open]);
  if (profile?.role !== "admin") return null;
  return <>
    <button type="button" onClick={() => setOpen(true)}
      className="inline-flex items-center gap-2 rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
      <Bot className="h-4 w-4" aria-hidden="true" /> Open Master AI
    </button>
    {open && <div className="fixed inset-0 z-50 flex items-center justify-center bg-foreground/50 p-4"
      role="dialog" aria-modal="true" aria-label="Master AI chat">
      <div className="flex max-h-[90vh] w-full max-w-4xl flex-col overflow-y-auto rounded-xl bg-card shadow-xl">
        <div className="flex justify-end p-2">
          <button type="button" onClick={() => setOpen(false)} aria-label="Close Master AI"
            className="rounded-md p-2 text-foreground hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>
        <MasterAIChat scope={scope} />
      </div>
    </div>}
  </>;
}
