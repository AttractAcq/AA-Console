// How an economics figure is presented, and when it must refuse to show a
// number at all.
//
// Pure and separate from the panel so these rules can be tested and mutated
// without rendering anything. They are display rules, not maths: the database
// returns the mathematically correct value and this decides what a person
// should be shown.
//
// The distinction that matters: a spend of zero is a fact and shows as 0. A
// ratio whose denominator is zero is unknown and shows as "—". And a ratio of
// exactly zero because the cohort has produced no revenue *yet* is reported as
// unavailable with a reason, because at this stage of a cohort's life a bare
// 0.00 reads as "this failed" when the truth is "nothing has landed yet".

export type Economics = {
  spend: number;
  leads: number;
  qualified_leads: number;
  appointments: number;
  customers: number;
  revenue: number;
  cash_collected: number;
  cpl: number | null;
  cpql: number | null;
  cpa: number | null;
  cac: number | null;
  roas: number | null;
  cash_roas: number | null;
  revenue_per_lead: number | null;
  avg_customer_value: number | null;
  currency: string | null;
  mixed_currency: boolean;
};

/** A figure the UI can render: a value, or a reason there isn't one. */
export type Shown = { value: string } | { unavailable: string };

export function isUnavailable(s: Shown): s is { unavailable: string } {
  return "unavailable" in s;
}

const CURRENCY_PREFIX: Record<string, string> = { ZAR: "R", USD: "$", GBP: "£", EUR: "€" };

export function money(amount: number, currency: string | null): string {
  const prefix = currency ? (CURRENCY_PREFIX[currency] ?? `${currency} `) : "";
  return `${prefix}${amount.toLocaleString(undefined, {
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  })}`;
}

/**
 * A cost-per-something. Null means the denominator was zero — nobody reached
 * that stage — so there is no cost per anything to report.
 */
export function showCost(value: number | null, currency: string | null, stage: string): Shown {
  if (value === null) return { unavailable: `No ${stage} in this cohort yet` };
  return { value: money(value, currency) };
}

/**
 * A return multiple.
 *
 * Two different reasons to refuse a number, and they are not the same fact:
 * no spend at all means the question is meaningless, while spend with no
 * revenue yet means the cohort has not matured. Saying which is the difference
 * between a reader believing the campaign failed and knowing it is early.
 */
export function showRatio(value: number | null, spend: number, revenue: number): Shown {
  if (spend === 0) return { unavailable: "No spend recorded in this period" };
  if (revenue === 0) return { unavailable: "No revenue from this cohort yet" };
  if (value === null) return { unavailable: "Not calculable" };
  return { value: `${value.toFixed(2)}×` };
}

/** Average customer value. Needs both a customer and revenue to exist. */
export function showAcv(value: number | null, currency: string | null, customers: number): Shown {
  if (customers === 0) return { unavailable: "No customers in this cohort yet" };
  if (value === null || value === 0) return { unavailable: "No revenue from this cohort yet" };
  return { value: money(value, currency) };
}

/**
 * Whether this cohort is too young to judge.
 *
 * A cohort whose window has not closed is still acquiring leads and still
 * converting them, so its revenue metrics are a floor that rises. Saying so
 * once, quietly, is the difference between a floor and a verdict.
 */
export function isMaturing(until: string, today: Date = new Date()): boolean {
  // until is exclusive, so the cohort is complete once that day has passed.
  return new Date(`${until}T00:00:00Z`).getTime() > today.getTime();
}

export type Range = { id: string; label: string; since: string; until: string };

const iso = (d: Date): string => d.toISOString().slice(0, 10);

/**
 * The windows on offer. `until` is always exclusive, matching the SQL, so
 * "last 7 days" cannot quietly include or exclude today depending on the hour.
 */
export function ranges(today: Date = new Date()): Range[] {
  const day = (n: number) => {
    const d = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
    d.setUTCDate(d.getUTCDate() + n);
    return d;
  };
  const tomorrow = iso(day(1));
  const monthStart = iso(new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1)));
  const prevStart = iso(new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - 1, 1)));

  return [
    { id: "7d", label: "Last 7 days", since: iso(day(-6)), until: tomorrow },
    { id: "30d", label: "Last 30 days", since: iso(day(-29)), until: tomorrow },
    { id: "month", label: "This month", since: monthStart, until: tomorrow },
    { id: "prev", label: "Last month", since: prevStart, until: monthStart },
  ];
}
