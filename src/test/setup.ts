import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

// Vitest does not unmount between tests on its own, and these suites
// render the same modal repeatedly — a leaked tree makes getByRole find
// two matches and fail for a reason that has nothing to do with the code.
afterEach(cleanup);

// Storage leaks between tests, and it is not obvious that it does.
//
// FormModal deliberately restores a saved draft over initialValues, so a
// cancelled edit is not lost. That means one test typing an invalid value
// into a modal leaves a draft that the *next* test silently restores — which
// is exactly how a BrandPanel test passed here and failed in CI, where the
// files happened to run in a different order. AgentActivityBar's dismissals
// live in sessionStorage for the same reason. Clearing both after every test
// removes the whole class rather than the one instance.
afterEach(() => {
  try {
    localStorage.clear();
    sessionStorage.clear();
  } catch {
    // Blocked site data throws on access; nothing to clean up in that case.
  }
});
