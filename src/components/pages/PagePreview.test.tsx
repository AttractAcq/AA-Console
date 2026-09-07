import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { PagePreview } from "./PagePreview";

const HTML = "<!doctype html><html><body><h1>Straighter teeth by summer</h1></body></html>";

function show(over: Partial<Parameters<typeof PagePreview>[0]> = {}) {
  return render(
    <PagePreview html={HTML} publishedUrl={null} builtAt={null} title="Whitening offer" {...over} />,
  );
}

describe("the preview frame", () => {
  // The property that matters most in this file. This console holds an admin
  // session against every client's data, and the HTML was written by a model.
  // An empty sandbox is what keeps a bad generation from reaching that
  // session — it is the line that holds when the prompt and the runtime check
  // have both failed.
  it("renders the page in a fully closed sandbox", () => {
    const { container } = show();
    const frame = container.querySelector("iframe");
    expect(frame).toHaveAttribute("sandbox", "");
  });

  it("never grants scripts or same-origin, however the sandbox is read", () => {
    const { container } = show();
    const sandbox = container.querySelector("iframe")?.getAttribute("sandbox") ?? "";
    expect(sandbox).not.toContain("allow-scripts");
    expect(sandbox).not.toContain("allow-same-origin");
  });

  // srcDoc, not src: the document never gets an origin of its own to be
  // fetched from, and nothing is written into the console's own document.
  it("passes the html as srcDoc rather than a URL", () => {
    const { container } = show();
    const frame = container.querySelector("iframe");
    expect(frame).toHaveAttribute("srcdoc", HTML);
    expect(frame).not.toHaveAttribute("src");
  });
});

describe("what the panel shows", () => {
  it("says plainly when a page has not been built, and what the button does", () => {
    show({ html: null });
    expect(screen.getByText(/Not built yet/)).toBeInTheDocument();
    expect(screen.getByText(/context, offer, brand, identity and cleared proof/)).toBeInTheDocument();
  });

  it("shows the code on request", async () => {
    const user = userEvent.setup();
    show();
    await user.click(screen.getByRole("button", { name: /code/i }));
    expect(screen.getByText(/<!doctype html>/)).toBeInTheDocument();
  });

  it("offers a mobile width, since these pages are mostly read on phones", async () => {
    const user = userEvent.setup();
    const { container } = show();
    await user.click(screen.getByLabelText("mobile width"));
    expect(container.querySelector("iframe")).toHaveClass("w-[390px]");
  });

  it("links to where the page is live", () => {
    show({ publishedUrl: "https://example.com/offer" });
    const link = screen.getByRole("link", { name: /example\.com\/offer/ });
    expect(link).toHaveAttribute("href", "https://example.com/offer");
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noreferrer");
  });

  // Built but not live is a real state and a different job from not built.
  it("says a built page is not published rather than implying it is", () => {
    show({ publishedUrl: null });
    expect(screen.getByText("not published")).toBeInTheDocument();
  });
});
