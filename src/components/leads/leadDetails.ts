import type { FieldDef, FormValues } from "../forms/fields";
import type { Lead } from "./types";

export type OwnerOption = { id: string; name: string };

export function detailFields(owners: OwnerOption[]): FieldDef[] {
  return [
    { name: "name", label: "Name", kind: "text", required: true },
    { name: "email", label: "Email", kind: "text", inputType: "email" },
    { name: "phone", label: "Phone", kind: "text", inputType: "tel" },
    { name: "source_channel", label: "Source channel", kind: "text" },
    { name: "owner_member_id", label: "Owner", kind: "select", options: owners.map((owner) => ({ value: owner.id, label: owner.name })) },
    { name: "next_action", label: "Next action", kind: "text" },
    { name: "next_action_due", label: "Due date", kind: "date" },
    { name: "opportunity_value", label: "Worth", kind: "number" },
    { name: "sale_value", label: "Sale value", kind: "number" },
    { name: "sale_currency", label: "Sale currency (ISO)", kind: "text", placeholder: "ZAR", hint: "Required when recording a positive sale value. Historical values may be unverified." },
    { name: "cash_collected", label: "Cash collected", kind: "number" },
    { name: "cash_currency", label: "Cash currency (ISO)", kind: "text", placeholder: "ZAR", hint: "Required when recording positive collected cash. Use the currency actually collected." },
    { name: "appointment_at", label: "Appointment date and time", kind: "datetime-local" },
    { name: "appointment_outcome", label: "Appointment outcome", kind: "select", options: [
      { value: "scheduled", label: "Scheduled" }, { value: "showed", label: "Showed" },
      { value: "no_show", label: "No-show" }, { value: "rescheduled", label: "Rescheduled" },
      { value: "cancelled", label: "Cancelled" },
    ] },
  ];
}

export function leadFormValues(lead: Lead): FormValues {
  const fields = detailFields([]);
  return Object.fromEntries(fields.map(({ name }) => {
    const raw = lead[name as keyof Lead];
    if (name === "appointment_at" && raw) {
      const date = new Date(String(raw));
      return [name, new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16)];
    }
    return [name, raw == null ? "" : String(raw)];
  }));
}

export function leadFieldsPayload(values: FormValues): Record<string, string | number | null> {
  const payload: Record<string, string | number | null> = {};
  for (const { name } of detailFields([])) {
    const text = String(values[name] ?? "").trim();
    if (["opportunity_value", "sale_value", "cash_collected"].includes(name)) {
      const amount = text === "" ? null : Number(text);
      if (amount !== null && (!Number.isFinite(amount) || amount < 0)) throw new Error(`${name.replaceAll("_", " ")} must be zero or more.`);
      payload[name] = amount;
    } else if (name === "sale_currency" || name === "cash_currency") {
      payload[name] = text.toUpperCase() || null;
    } else if (name === "appointment_at") {
      const date = text ? new Date(text) : null;
      if (date && Number.isNaN(date.getTime())) throw new Error("Choose a valid appointment date and time.");
      payload[name] = date?.toISOString() ?? null;
    } else {
      payload[name] = text || null;
    }
  }
  if (!payload.name) throw new Error("Name is required.");
  return payload;
}

/** Only send fields the operator changed; a stale form must not rewrite cash. */
export function changedLeadFieldsPayload(values: FormValues, baseline: FormValues): Record<string, string | number | null> {
  const current = leadFieldsPayload(values);
  const original = leadFieldsPayload(baseline);
  const changed = Object.fromEntries(Object.entries(current).filter(([key, value]) => value !== original[key]));
  for (const [amountKey, currencyKey] of [["sale_value", "sale_currency"], ["cash_collected", "cash_currency"]] as const) {
    if (!(amountKey in changed) && !(currencyKey in changed)) continue;
    const amount = current[amountKey] as number | null;
    const currency = current[currencyKey];
    if (currency !== null && (typeof currency !== "string" || !/^[A-Z]{3}$/.test(currency))) {
      throw new Error(`${currencyKey.replaceAll("_", " ")} must be a three-letter ISO currency code.`);
    }
    if (amount !== null && amount > 0 && currency === null) {
      throw new Error(`${currencyKey.replaceAll("_", " ")} is required for a positive amount.`);
    }
  }
  return changed;
}
