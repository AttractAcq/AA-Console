import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { expect, it } from "vitest";
import { v6ModuleNodes } from "../../config/navigation";
import { Page } from "../Page";

it("shows Google Ads Studio as planned with its real dependency and a working module link", () => {
  const node = v6ModuleNodes.find((item) => item.id === "google-ads-studio")!;
  render(
    <MemoryRouter initialEntries={["/clients/client-1/delivery/google-ads-studio"]}>
      <Routes>
        <Route path="/clients/:clientId/delivery/google-ads-studio" element={<Page node={node} />} />
      </Routes>
    </MemoryRouter>,
  );
  expect(screen.getByText("Planned capability")).toBeInTheDocument();
  expect(screen.getByText(/Google Ads account access/)).toBeInTheDocument();
  expect(screen.getByRole("link", { name: "Open Campaign Factory" }))
    .toHaveAttribute("href", "/clients/client-1/delivery/campaign-factory");
  expect(screen.queryByRole("button", { name: /deploy|publish|activate/i })).not.toBeInTheDocument();
});
