import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach, beforeEach } from "vitest";

// Node 25 defines a global `localStorage` of its own, and when the process
// has no --localstorage-file it is an object with no methods on it at all.
// That global shadows the working one jsdom installs, so every
// localStorage.setItem in app code returns undefined under test and every
// localStorage.clear in a test throws. Five AdCopyModal tests were failing
// on exactly this, and the more expensive half is invisible: FormModal's
// draft restoration and AgentActivityBar's dismissals read storage that
// quietly does nothing, so tests of them prove nothing.
//
// The guard is a capability check rather than a version check: a Node that
// fixes this, or a run that does pass a storage file, keeps its own.
function installStorage(name: "localStorage" | "sessionStorage"): void {
  const current = (globalThis as Record<string, unknown>)[name] as Storage | undefined;
  if (current && typeof current.setItem === "function" && typeof current.clear === "function") return;

  const store = new Map<string, string>();
  const shim: Storage = {
    get length() {
      return store.size;
    },
    key: (i: number) => [...store.keys()][i] ?? null,
    getItem: (k: string) => store.get(String(k)) ?? null,
    setItem: (k: string, v: string) => void store.set(String(k), String(v)),
    removeItem: (k: string) => void store.delete(String(k)),
    clear: () => store.clear(),
  };
  Object.defineProperty(globalThis, name, { value: shim, configurable: true, writable: true });
  if (typeof window !== "undefined") {
    Object.defineProperty(window, name, { value: shim, configurable: true, writable: true });
  }
}

installStorage("localStorage");
installStorage("sessionStorage");
// jsdom rebuilds window between files; re-check rather than assume.
beforeEach(() => {
  installStorage("localStorage");
  installStorage("sessionStorage");
});

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
