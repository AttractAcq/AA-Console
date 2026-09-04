export type ConsoleRole = "admin" | "client" | "employee";
export type EmployeeCategory = "avatars" | "editors" | "smm";

/** Where each role lands after signing in. */
export const HOME_FOR_ROLE: Record<ConsoleRole, string> = {
  admin: "/",
  client: "/client",
  employee: "/employee",
};

/** Which login page each role signs in through. */
export const LOGIN_FOR_ROLE: Record<ConsoleRole, string> = {
  admin: "/login",
  client: "/client/login",
  employee: "/employee/login",
};

const INTERNAL_DOMAIN = "attractacq.com";

/**
 * Client and employee accounts sign in with a username, not an email.
 * Supabase auth is email-based, so a bare username is expanded against
 * the internal domain. An address typed in full is left alone.
 */
export function toEmail(identifier: string): string {
  const trimmed = identifier.trim().toLowerCase();
  return trimmed.includes("@") ? trimmed : `${trimmed}@${INTERNAL_DOMAIN}`;
}

export const EMPLOYEE_CATEGORY_LABEL: Record<EmployeeCategory, string> = {
  smm: "Social Media Manager",
  editors: "Editor",
  avatars: "Avatar",
};
