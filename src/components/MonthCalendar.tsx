import { cn } from "../lib/cn";

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export type ScheduledAsset = {
  day: number;
  refNumber: string;
};

export function MonthCalendar({ assets = [] }: { assets?: ScheduledAsset[] }) {
  const today = new Date();
  const year = today.getFullYear();
  const month = today.getMonth();
  const monthLabel = today.toLocaleDateString("en-US", { month: "long", year: "numeric" });

  const firstWeekday = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();

  const cells: Array<number | null> = [
    ...Array.from({ length: firstWeekday }, () => null),
    ...Array.from({ length: daysInMonth }, (_, i) => i + 1),
  ];
  while (cells.length % 7 !== 0) cells.push(null);

  const refsByDay = new Map<number, string[]>();
  for (const asset of assets) {
    const existing = refsByDay.get(asset.day) ?? [];
    existing.push(asset.refNumber);
    refsByDay.set(asset.day, existing);
  }

  return (
    <div className="rounded-lg border border-border bg-card p-5">
      <h2 className="mb-4 text-sm font-semibold text-card-foreground">{monthLabel}</h2>
      <div className="grid grid-cols-7 gap-1">
        {WEEKDAYS.map((day) => (
          <div key={day} className="pb-1 text-center text-xs font-medium text-muted-foreground">
            {day}
          </div>
        ))}
        {cells.map((day, index) => {
          const refs = day !== null ? refsByDay.get(day) : undefined;
          const isToday = day === today.getDate();
          return (
            <div
              key={index}
              className={cn(
                "flex min-h-[76px] flex-col gap-1 rounded-md p-1.5",
                day !== null && "border border-border",
              )}
            >
              {day !== null && (
                <>
                  <span
                    className={cn(
                      "flex h-6 w-6 items-center justify-center rounded-full text-xs",
                      isToday
                        ? "bg-primary font-medium text-primary-foreground"
                        : "text-foreground",
                    )}
                  >
                    {day}
                  </span>
                  <div className="flex flex-col gap-1 overflow-hidden">
                    {refs?.map((refNumber) => (
                      <span
                        key={refNumber}
                        className="truncate rounded bg-secondary px-1.5 py-0.5 text-[11px] font-medium text-secondary-foreground"
                      >
                        {refNumber}
                      </span>
                    ))}
                  </div>
                </>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
