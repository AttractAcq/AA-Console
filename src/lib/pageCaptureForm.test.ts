import { describe, expect, it } from "vitest";
import { appendPageCaptureForm } from "./pageCaptureForm";

const token = "a".repeat(64);
const source = "<!doctype html><html><body><h1>Offer</h1></body></html>";

describe("reviewed page capture form", () => {
  it("puts a no-script, consented form inside the exact page bytes", () => {
    const html = appendPageCaptureForm(source, "https://runtime.example.test", token, "I agree to be contacted.");
    expect(html).toContain(`action="https://runtime.example.test/public/lead/form/${token}"`);
    expect(html).toContain('method="post"');
    expect(html).toContain('name="consent" value="yes" required');
    expect(html.indexOf("<!-- aa-page-capture-form -->")).toBeLessThan(html.indexOf("</body>"));
    expect(html).not.toContain("<script");
  });

  it("escapes the exact consent words and refuses duplicate or insecure forms", () => {
    const html = appendPageCaptureForm(source, "https://runtime.example.test", token, 'I agree to <contact> & replies.');
    expect(html).toContain("I agree to &lt;contact&gt; &amp; replies.");
    expect(() => appendPageCaptureForm(html, "https://runtime.example.test", token, "I agree to be contacted.")).toThrow("already");
    expect(() => appendPageCaptureForm(source, "http://runtime.example.test", token, "I agree to be contacted.")).toThrow("secure");
  });
});
