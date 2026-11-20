import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { describe, expect, it } from "vitest";
import { V2_FIXTURE } from "./v2-fixture.generated.js";
import { ThumbnailFromIR } from "./ThumbnailFromIR.js";

describe("reviewed video thumbnail", () => {
  it("renders the complete reviewed title with the frozen client palette", () => {
    const title = "How focused service offers turn verified proof into more conversations with the right buyers";
    const markup = renderToStaticMarkup(createElement(ThumbnailFromIR, {
      ir: { ...V2_FIXTURE.ir, title },
      brandSnapshot: { colour_background: "#112233",
        colour_accent: "#445566", colour_text: "#ffffff" },
    }));
    expect(markup).toContain(title);
    expect(markup).toContain("#112233");
    expect(markup).toContain("#445566");
  });

  it("rejects an unreviewed or invalid IR", () => {
    expect(() => renderToStaticMarkup(createElement(ThumbnailFromIR, {
      ir: { ...V2_FIXTURE.ir, title: "" }, brandSnapshot: {},
    })))
      .toThrow(/Invalid video IR/);
  });
});
