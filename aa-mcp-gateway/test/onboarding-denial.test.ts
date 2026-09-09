import { test } from "node:test";
import assert from "node:assert/strict";
import {
  assertAuthorizationDenial,
  type AuthorizationDenial,
} from "../scripts/onboarding-denial.js";

const cases: [AuthorizationDenial, Record<string, unknown>][] = [
  ["client_scope", { status: "rejected", message: "Client scope denied." }],
  [
    "foreign_resource",
    { status: "failed", error: { code: "client_mismatch" } },
  ],
  [
    "forbidden_tool",
    { status: "rejected", message: "Tool unavailable or unauthorized." },
  ],
];

for (const [expected, result] of cases) {
  test(`onboarding denial requires the exact ${expected} result`, () => {
    assert.doesNotThrow(() =>
      assertAuthorizationDenial({ structuredContent: result }, expected),
    );
    for (const [other, wrongResult] of cases) {
      if (other !== expected)
        assert.throws(() =>
          assertAuthorizationDenial(
            { structuredContent: wrongResult },
            expected,
          ),
        );
    }
    for (const status of ["completed", "accepted", "rejected", "failed"]) {
      for (const code of [
        "internal_error",
        "timeout",
        "upstream_timeout",
        "malformed_response",
        "task_not_found",
        "client_forbidden",
      ]) {
        for (const isError of [true, false]) {
          const response = {
            isError,
            structuredContent: { status, error: { code } },
          };
          assert.throws(
            () => assertAuthorizationDenial(response, expected),
            `${status}/${code}/${isError}`,
          );
        }
      }
    }
    for (const structuredContent of [
      undefined,
      null,
      {},
      { status: "failed" },
      { status: "rejected" },
      { status: "rejected", message: "Invalid tool input." },
      { ...result, status: "completed" },
    ]) {
      assert.throws(() =>
        assertAuthorizationDenial({ structuredContent }, expected),
      );
    }
  });
}
