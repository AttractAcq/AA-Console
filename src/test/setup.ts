import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

// Vitest does not unmount between tests on its own, and these suites
// render the same modal repeatedly — a leaked tree makes getByRole find
// two matches and fail for a reason that has nothing to do with the code.
afterEach(cleanup);
