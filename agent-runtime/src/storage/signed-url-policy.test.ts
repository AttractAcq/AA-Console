import { describe, expect, it } from "vitest";
import { safeProviderErrorMessage } from "./signed-url-policy.js";

describe("signed Storage URL error handling", () => {
  it("withholds full raw or URL-encoded bearer URLs", () => {
    const raw = "https://storage.example/storage/v1/object/sign/client-media/a.png?token=secret";
    const encoded = encodeURIComponent(raw);
    for (const message of [`Provider refused ${raw}`, `Provider refused ${encoded}`]) {
      const safe = safeProviderErrorMessage(message);
      expect(safe).toContain("details withheld");
      expect(safe).not.toContain("secret");
    }
  });

  it("keeps a useful error when it has no bearer URL", () => {
    expect(safeProviderErrorMessage("Provider returned 429.")).toBe("Provider returned 429.");
  });
});
