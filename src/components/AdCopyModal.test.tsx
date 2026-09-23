import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { from, update, eq } = vi.hoisted(() => {
  const eq = vi.fn();
  const update = vi.fn(() => ({ eq }));
  return { eq, update, from: vi.fn(() => ({ update })) };
});
vi.mock("../lib/supabase", () => ({ supabase: { from } }));

import { AdCopyModal } from "./AdCopyModal";

const brief = {
  title: "Open day",
  hook: "Most parents choose from a brochure.",
  premise: "Walk the corridors instead.",
  call_to_action: "SIGN_UP",
};

beforeEach(() => {
  localStorage.clear();
  eq.mockReset().mockResolvedValue({ error: null });
  update.mockClear();
});

function open(asset = { id: "a1", title: "Hero" }, onSaved = vi.fn()) {
  render(
    <AdCopyModal
      asset={asset}
      brief={brief}
      landingUrl="https://school.example/open-day"
      allowedCtas={["SIGN_UP"]}
      open
      onClose={vi.fn()}
      onSaved={onSaved}
    />,
  );
  return onSaved;
}

describe("AdCopyModal", () => {
  it("opens on a draft from the brief and the campaign's page", () => {
    open();
    expect(screen.getByLabelText(/Primary text/)).toHaveValue("Walk the corridors instead.");
    expect(screen.getByLabelText(/Headline/)).toHaveValue("Open day");
    expect(screen.getByLabelText(/Link/)).toHaveValue("https://school.example/open-day");
    expect(screen.getByLabelText(/Button/)).toHaveValue("SIGN_UP");
  });

  it("offers only the buttons the template allows", () => {
    open();
    const options = [...(screen.getByLabelText(/Button/) as HTMLSelectElement).options].map((o) => o.value);
    expect(options).toEqual(["", "SIGN_UP"]);
  });

  it("keeps copy a person already saved", () => {
    open({ id: "a1", title: "Hero", ad_headline: "Their own words" } as never);
    expect(screen.getByLabelText(/Headline/)).toHaveValue("Their own words");
  });

  it("refuses a link Meta would refuse, and writes nothing", async () => {
    open();
    const link = screen.getByLabelText(/Link/);
    await userEvent.clear(link);
    await userEvent.type(link, "school.example");
    await userEvent.click(screen.getByRole("button", { name: "Save ad copy" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/https/);
    expect(update).not.toHaveBeenCalled();
  });

  it("saves the copy onto the asset", async () => {
    const onSaved = open();
    await userEvent.click(screen.getByRole("button", { name: "Save ad copy" }));
    expect(from).toHaveBeenCalledWith("client_media_assets");
    expect(update).toHaveBeenCalledWith({
      ad_primary_text: "Walk the corridors instead.",
      ad_headline: "Open day",
      ad_description: null,
      ad_link_url: "https://school.example/open-day",
      ad_cta: "SIGN_UP",
    });
    expect(eq).toHaveBeenCalledWith("id", "a1");
    expect(onSaved).toHaveBeenCalled();
  });
});
