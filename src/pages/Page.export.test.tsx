import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, expect, it, vi } from "vitest";

const { downloadTabPdf, downloadModuleZip } = vi.hoisted(() => ({
  downloadTabPdf: vi.fn(),
  downloadModuleZip: vi.fn(),
}));
vi.mock("../lib/moduleExport", () => ({ downloadTabPdf, downloadModuleZip }));
vi.mock("./intelligence/BusinessContextPanel", () => ({ BusinessContextPanel: () => <p>Business context panel</p> }));
vi.mock("./intelligence/MarketPanel", () => ({ MarketPanel: () => <p>Market panel</p> }));
vi.mock("./ideation/GenerationPanel", () => ({ GenerationPanel: ({ showJourney = true }: { showJourney?: boolean }) => <p>Ideation panel · journey {String(showJourney)}</p> }));
vi.mock("./media/ContentAssetsPanel", () => ({ ContentAssetsPanel: () => <p>Grouped asset libraries</p> }));

import { legacyDeliveryNodes, v6ModuleNodes } from "../config/navigation";
import { Page } from "./Page";

const intelligence = legacyDeliveryNodes.find((node) => node.id === "intelligence")!;
const intelligenceOs = v6ModuleNodes.find((node) => node.id === "intelligence-os")!;

beforeEach(() => vi.clearAllMocks());

it("downloads the selected tab as a PDF and all module tabs as a ZIP", async () => {
  const user = userEvent.setup();
  render(
    <MemoryRouter initialEntries={["/clients/client-1/delivery/intelligence"]}>
      <Routes>
        <Route path="/clients/:clientId/delivery/intelligence" element={<Page node={intelligence} />} />
      </Routes>
    </MemoryRouter>,
  );

  await user.click(screen.getByRole("button", { name: "Download PDF" }));
  expect(downloadTabPdf).toHaveBeenCalledWith("client-1", "intelligence", intelligence.tabs![0]);

  await user.click(screen.getByRole("tab", { name: "Market" }));
  await user.click(screen.getByRole("button", { name: "Download PDF" }));
  expect(downloadTabPdf).toHaveBeenLastCalledWith("client-1", "intelligence", intelligence.tabs![1]);

  await user.click(screen.getByRole("button", { name: "Download all" }));
  expect(downloadModuleZip).toHaveBeenCalledWith("client-1", "intelligence", intelligence.tabs);
});

it("shows an export failure and allows retry", async () => {
  downloadTabPdf.mockRejectedValueOnce(new Error("Network unavailable"));
  const user = userEvent.setup();
  render(
    <MemoryRouter initialEntries={["/clients/client-1/delivery/intelligence"]}>
      <Routes>
        <Route path="/clients/:clientId/delivery/intelligence" element={<Page node={intelligence} />} />
      </Routes>
    </MemoryRouter>,
  );
  await user.click(screen.getByRole("button", { name: "Download PDF" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Network unavailable");
  await user.click(screen.getByRole("button", { name: "Download PDF" }));
  expect(downloadTabPdf).toHaveBeenCalledTimes(2);
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});

it("exports intelligence and strategy only from their own Intelligence OS views", async () => {
  const user = userEvent.setup();
  render(
    <MemoryRouter initialEntries={["/clients/client-1/delivery/intelligence-os"]}>
      <Routes>
        <Route path="/clients/:clientId/delivery/intelligence-os" element={<Page node={intelligenceOs} />} />
      </Routes>
    </MemoryRouter>,
  );

  const strategyStart = intelligenceOs.tabs!.findIndex((tab) => tab.id === "branding-strategy");
  await user.click(screen.getByRole("button", { name: "Download intelligence" }));
  expect(downloadModuleZip).toHaveBeenCalledWith("client-1", "intelligence", intelligenceOs.tabs!.slice(0, strategyStart));
  expect(screen.queryByRole("tab", { name: "Branding Strategy" })).not.toBeInTheDocument();
});

it("shows only strategy tabs and its export in the strategy view", async () => {
  const user = userEvent.setup();
  render(
    <MemoryRouter initialEntries={["/clients/client-1/delivery/intelligence-os?view=strategy"]}>
      <Routes>
        <Route path="/clients/:clientId/delivery/intelligence-os" element={<Page node={intelligenceOs} />} />
      </Routes>
    </MemoryRouter>,
  );
  const strategyStart = intelligenceOs.tabs!.findIndex((tab) => tab.id === "branding-strategy");
  expect(screen.queryByRole("tab", { name: "Market" })).not.toBeInTheDocument();
  expect(screen.getByRole("tab", { name: "Branding Strategy" })).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Download strategy" }));
  expect(downloadModuleZip).toHaveBeenLastCalledWith("client-1", "strategy", intelligenceOs.tabs!.slice(strategyStart));
});

it("keeps Content Production v1 tabs and gives v2 grouped assets without its stage bar", async () => {
  const content = v6ModuleNodes.find((node) => node.id === "content-production-factory")!;
  const user = userEvent.setup();
  render(<MemoryRouter initialEntries={["/clients/client-1/delivery/content-production-factory?view=v2"]}>
    <Routes><Route path="/clients/:clientId/delivery/content-production-factory" element={<Page node={content} />} /></Routes>
  </MemoryRouter>);
  expect(screen.getByText("Ideation panel · journey false")).toBeInTheDocument();
  expect(screen.getAllByRole("tab").map((tab) => tab.textContent)).toEqual([
    "Ideation", "Briefs", "Create", "Edit / Repurpose", "Assets",
  ]);
  await user.click(screen.getByRole("tab", { name: "Assets" }));
  expect(screen.getByText("Grouped asset libraries")).toBeInTheDocument();
  await user.click(screen.getByRole("tab", { name: "Ideation" }));
  expect(screen.getByText("Ideation panel · journey false")).toBeInTheDocument();
});

it("renders a heading only for an unbuilt v2 module", () => {
  const campaign = v6ModuleNodes.find((node) => node.id === "campaign-factory")!;
  render(<MemoryRouter initialEntries={["/clients/client-1/delivery/campaign-factory?view=v2"]}>
    <Routes><Route path="/clients/:clientId/delivery/campaign-factory" element={<Page node={campaign} />} /></Routes>
  </MemoryRouter>);
  expect(screen.getByRole("heading", { name: "Campaign Factory v2" })).toBeInTheDocument();
  expect(screen.queryByRole("tab")).not.toBeInTheDocument();
  expect(screen.queryByText(/Existing tools are available here/)).not.toBeInTheDocument();
});
