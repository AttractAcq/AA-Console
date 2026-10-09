import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import { ProofAuditForm } from "./ProofAuditForm";
import { auditBrief } from "./auditBrief";

async function fillFirstStep(business = "Northside Dental") {
  await userEvent.type(screen.getByLabelText(/business name/i), business);
  await userEvent.click(screen.getByRole("button", { name: /next/i }));
}

describe("starting a proof audit", () => {
  it("will not advance without the name of the business", async () => {
    // The second step asks about a business we have not been told the name
    // of, which reads as a form that lost the first answer.
    render(<ProofAuditForm />);
    await userEvent.click(screen.getByRole("button", { name: /next/i }));

    expect(screen.getByRole("alert")).toHaveTextContent(/name of the business/i);
    expect(screen.getByLabelText(/business name/i)).toBeInTheDocument();
  });

  it("asks the harder questions only once the easy one is answered", async () => {
    render(<ProofAuditForm />);
    expect(screen.queryByLabelText(/what is not working/i)).not.toBeInTheDocument();

    await fillFirstStep();

    expect(screen.getByLabelText(/what is not working/i)).toBeInTheDocument();
    expect(screen.getByText(/step 2 of 2/i)).toBeInTheDocument();
  });

  it("keeps what was typed when stepping back", async () => {
    // A back button that empties the form is a reason not to press it.
    render(<ProofAuditForm />);
    await fillFirstStep("Harbour Dental");
    await userEvent.click(screen.getByRole("button", { name: /back/i }));

    expect(screen.getByLabelText(/business name/i)).toHaveValue("Harbour Dental");
  });

  it("hands off to the visitor's own mail client rather than claiming to submit", async () => {
    render(<ProofAuditForm />);
    await fillFirstStep();
    await userEvent.type(screen.getByLabelText(/what is not working/i), "Leads go cold");
    await userEvent.click(screen.getByRole("button", { name: /review request/i }));

    const send = screen.getByRole("link", { name: /send to aa/i });
    expect(send).toHaveAttribute("href", expect.stringContaining("mailto:hello@attractacq.com"));
    expect(send.getAttribute("href")).toContain(encodeURIComponent("Northside Dental"));
  });

  it("says plainly that nothing has been sent yet", async () => {
    render(<ProofAuditForm />);
    expect(screen.getByText(/nothing is submitted from this page/i)).toBeInTheDocument();
  });
});

describe("the brief AA receives", () => {
  it("carries every answer under a label, so an empty one is visible", () => {
    const { subject, body } = auditBrief({
      business: "Northside Dental",
      service: "Implants",
      website: "",
      goal: "Enquiries go cold",
    });

    expect(subject).toBe("Proof audit request — Northside Dental");
    expect(body).toContain("Main service: Implants");
    // An unanswered field says so rather than vanishing.
    expect(body).toContain("Website: —");
    expect(body).toContain("Enquiries go cold");
  });
});
