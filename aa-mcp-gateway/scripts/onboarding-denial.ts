import assert from "node:assert/strict";

export type AuthorizationDenial =
  "client_scope" | "foreign_resource" | "forbidden_tool";

/** Only the authorization result for this fixture can satisfy the gate. */
export function assertAuthorizationDenial(
  response: { structuredContent?: unknown },
  expected: AuthorizationDenial,
): void {
  const result = response.structuredContent as
    | { status?: unknown; message?: unknown; error?: { code?: unknown } }
    | undefined;
  const matches =
    expected === "foreign_resource"
      ? result?.status === "failed" && result.error?.code === "client_mismatch"
      : result?.status === "rejected" &&
        result.message ===
          (expected === "client_scope"
            ? "Client scope denied."
            : "Tool unavailable or unauthorized.");
  // Do not include response bodies in assertion output (operator evidence is sanitized).
  assert.ok(matches, `Expected ${expected} authorization denial`);
}
