import { useEffect, useRef, useState } from "react";
import { MoreHorizontal } from "lucide-react";
import { cn } from "../lib/cn";

/**
 * Every action on one row, behind one column.
 *
 * The content factory tables had grown a different set of loose buttons per
 * tab — Approve, Approve & brief, Delete, a details toggle living inside the
 * title cell — so the same decision looked different on every screen and the
 * table got wider each time a stage gained an action.
 *
 * The order inside the menu is deliberate and the same everywhere: whatever
 * moves this row to the next stage first, then the ways of looking at it,
 * then archive, then delete last and marked. A destructive item that sits
 * where a safe one sat on the previous screen is how somebody deletes a
 * brief they meant to open.
 */
export interface ActionItem {
  label: string;
  onSelect: () => void;
  /** Deletion. Rendered apart from the rest and in the destructive tone. */
  destructive?: boolean;
  disabled?: boolean;
  /** Shown in place of the label while this item's work is running. */
  busyLabel?: string;
}

export function ActionMenu({
  items,
  busy = false,
  label = "Actions",
  name,
}: {
  items: ActionItem[];
  /** Something on this row is running. The menu still opens; items disable. */
  busy?: boolean;
  label?: string;
  /**
   * What this row is, for the trigger's accessible name.
   *
   * Without it every row's button is called "Actions" and a screen reader
   * reads a column of identical controls. The loose buttons this replaced
   * each carried the row's title for exactly that reason.
   */
  name?: string;
}) {
  const triggerName = name ? `${label} for ${name}` : label;
  const [open, setOpen] = useState(false);
  const wrapper = useRef<HTMLDivElement>(null);

  // Click-away and Escape, because a menu that only closes by choosing
  // something makes people choose something.
  useEffect(() => {
    if (!open) return;
    function onDocument(event: MouseEvent) {
      if (!wrapper.current?.contains(event.target as Node)) setOpen(false);
    }
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onDocument);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocument);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const usable = items.filter((item) => item.label.trim().length > 0);
  if (usable.length === 0) return <span className="text-xs text-muted-foreground">—</span>;

  const safe = usable.filter((item) => !item.destructive);
  const destructive = usable.filter((item) => item.destructive);

  return (
    <div ref={wrapper} className="relative inline-block text-left">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={triggerName}
        onClick={() => setOpen((value) => !value)}
        className="inline-flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-xs font-medium text-foreground hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {/* The menu closes when something is chosen, so the trigger is the
            only place left to say that the row is working. Without it an
            approval that takes a second looks like a click that missed. */}
        {busy ? "Working…" : label}
        <MoreHorizontal className="h-3.5 w-3.5" aria-hidden="true" />
      </button>

      {open && (
        <div
          role="menu"
          aria-label={triggerName}
          // right-0 so the menu never pushes the table wider than it is; the
          // actions column is the last one, so it opens inward.
          className="absolute right-0 z-20 mt-1 min-w-44 overflow-hidden rounded-md border border-border bg-card py-1 shadow-lg"
        >
          {safe.map((item) => (
            <MenuItem key={item.label} item={item} busy={busy} onDone={() => setOpen(false)} />
          ))}
          {safe.length > 0 && destructive.length > 0 && (
            <div className="my-1 border-t border-border" aria-hidden="true" />
          )}
          {destructive.map((item) => (
            <MenuItem key={item.label} item={item} busy={busy} onDone={() => setOpen(false)} />
          ))}
        </div>
      )}
    </div>
  );
}

function MenuItem({
  item,
  busy,
  onDone,
}: {
  item: ActionItem;
  busy: boolean;
  onDone: () => void;
}) {
  const disabled = item.disabled || busy;
  return (
    <button
      type="button"
      role="menuitem"
      disabled={disabled}
      onClick={() => {
        onDone();
        item.onSelect();
      }}
      className={cn(
        "block w-full px-3 py-1.5 text-left text-xs hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50",
        item.destructive ? "text-destructive" : "text-foreground",
      )}
    >
      {busy && item.busyLabel ? item.busyLabel : item.label}
    </button>
  );
}
