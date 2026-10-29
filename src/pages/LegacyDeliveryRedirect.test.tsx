import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { expect, it } from "vitest";

import { legacyDeliveryRedirects } from "../config/navigation";
import { LegacyCampaignRedirect, LegacyDeliveryRedirect } from "./LegacyDeliveryRedirect";

function Landed() {
  const { pathname, search } = useLocation();
  return <span data-testid="landed">{pathname + search}</span>;
}

function go(entry: string) {
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <Routes>
        {Object.keys(legacyDeliveryRedirects).map((from) => (
          <Route key={from} path={`/clients/:clientId/delivery/${from}`}
            element={<LegacyDeliveryRedirect from={from} />} />
        ))}
        <Route path="/clients/:clientId/delivery/campaign-execution/:campaignId"
          element={<LegacyCampaignRedirect />} />
        <Route path="*" element={<Landed />} />
      </Routes>
    </MemoryRouter>,
  );
}

it.each([
  ["intelligence", "/clients/c1/delivery/intelligence-os"],
  ["strategy", "/clients/c1/delivery/intelligence-os?view=strategy"],
  ["proof-bank", "/clients/c1/delivery/proof-production-factory"],
  ["ideation", "/clients/c1/delivery/content-production-factory"],
  ["create", "/clients/c1/delivery/content-production-factory?tab=create"],
  ["edit-repurpose", "/clients/c1/delivery/content-production-factory?tab=edit"],
  ["approvals", "/clients/c1/delivery/approval-inbox"],
  ["media", "/clients/c1/delivery/content-production-factory?tab=assets"],
  ["distribution", "/clients/c1/delivery/content-distribution"],
  ["reporting", "/clients/c1/delivery/attribution-os"],
  ["campaign-execution", "/clients/c1/delivery/campaign-factory"],
  ["conversion", "/clients/c1/delivery/website-studio"],
  ["sales", "/clients/c1/delivery/sales-os?tab=agents"],
  ["prospects-leads", "/clients/c1/delivery/sales-os?tab=leads"],
  ["economics", "/clients/c1/delivery/attribution-os?tab=economics"],
])("sends the archived %s page to its v6 replacement", (from, expected) => {
  go(`/clients/c1/delivery/${from}`);
  expect(screen.getByTestId("landed").textContent).toBe(expected);
});

it("keeps the query the old link carried, in preference to the default", () => {
  // `media` defaults to the top of Assets, but this link named a library, and
  // Assets kept v1's tab ids so the name still resolves.
  go("/clients/c1/delivery/media?tab=reel-shots");
  expect(screen.getByTestId("landed").textContent)
    .toBe("/clients/c1/delivery/content-production-factory?tab=reel-shots");
});

it("carries a brief through to the tab that can show it", () => {
  go("/clients/c1/delivery/ideation?tab=briefs&brief=b-7");
  expect(screen.getByTestId("landed").textContent)
    .toBe("/clients/c1/delivery/content-production-factory?tab=briefs&brief=b-7");
});

it("sends one campaign's own legacy page to that campaign, not the list", () => {
  go("/clients/c1/delivery/campaign-execution/camp-9");
  expect(screen.getByTestId("landed").textContent)
    .toBe("/clients/c1/delivery/campaign-factory/camp-9");
});
