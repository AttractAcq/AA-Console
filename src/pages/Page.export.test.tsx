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

it("exports both retained intelligence and strategy groups from Intelligence OS", async () => {
  const user = userEvent.setup();
  render(
    <MemoryRouter initialEntries={["/clients/client-1/delivery/intelligence-os"]}>
      <Routes>
        <Route path="/clients/:clientId/delivery/intelligence-os" element={<Page node={intelligenceOs} />} />
      </Routes>
    </MemoryRouter>,
  );

  await user.click(screen.getByRole("button", { name: "Download intelligence" }));
  expect(downloadModuleZip).toHaveBeenCalledWith("client-1", "intelligence", intelligenceOs.tabs!.slice(0, 7));
  await user.click(screen.getByRole("button", { name: "Download strategy" }));
  expect(downloadModuleZip).toHaveBeenLastCalledWith("client-1", "strategy", intelligenceOs.tabs!.slice(7));
});
