import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { summarizeVideoReports } from "./video-summary.js";

const ids = Array.from({ length: 20 }, (_, index) =>
  `${String(index + 1).padStart(2, "0")}-case`);
const fixture = "f".repeat(64);
const catalogue = "c".repeat(64);
const sha = (value: unknown) => createHash("sha256")
  .update(JSON.stringify(value)).digest("hex");

function report(start: number, count: number) {
  const selectedCaseIds = ids.slice(start - 1, start - 1 + count);
  return {
    kind: "video_script_review_evaluation_v1", model: "review-model",
    fixtureSha256: fixture, catalogueSha256: catalogue,
    startCase: start, selectedCases: count, selectedCaseIds,
    completedCases: count, runStatus: "complete",
    activeCaseId: null as string | null,
    costCoverage: "model_usage_estimate_not_provider_invoice",
    estimatedCostUsd: count * 0.2,
    results: selectedCaseIds.map((id) => {
      const reviewedIr = { scenes: [{ id: `${id}-scene` }] };
      return { id, writerValid: true, reviewerAccepted: true,
        estimatedCostUsd: 0.2, error: null, reviewedIr,
        irSha256: sha(reviewedIr),
        sceneSources: [{ sceneId: `${id}-scene`, sourceIds: ["operator_prompt"] }] };
    }),
  };
}

const input = (value: unknown, hash: string) => ({ value, sha256: hash.repeat(64) });

describe("video evaluation report summary", () => {
  it("joins two disjoint ten-case batches without claiming provider invoice or final video acceptance", () => {
    const summary = summarizeVideoReports([
      input(report(1, 10), "a"), input(report(11, 10), "b"),
    ], ids, fixture, catalogue);
    expect(summary).toMatchObject({ selectedCases: 20, completedCases: 20,
      missingCaseIds: [], estimatedCostUsd: 4,
      writerValidateRate: 1, reviewerAcceptRate: 1,
      scriptReviewGatePassed: true, providerInvoiceReconciled: false,
      videoAcceptance: "not_assessed", blockers: [] });
    expect(summary.reportSha256).toEqual(["a".repeat(64), "b".repeat(64)]);
  });

  it("holds a duplicate batch even when all twenty unique cases are present", () => {
    const summary = summarizeVideoReports([
      input(report(1, 10), "a"), input(report(11, 10), "b"),
      input(report(11, 10), "c"),
    ], ids, fixture, catalogue);
    expect(summary.scriptReviewGatePassed).toBe(false);
    expect(summary.blockers).toContain("report 3: duplicate selected case 11-case");
  });

  it("shows missing coverage and an uncertain active case after an interrupted run", () => {
    const second = report(11, 10);
    second.results.pop();
    second.completedCases = 9;
    second.runStatus = "running";
    second.activeCaseId = ids[19]!;
    second.estimatedCostUsd = 1.8;
    const summary = summarizeVideoReports([
      input(report(1, 10), "a"), input(second, "b"),
    ], ids, fixture, catalogue);
    expect(summary.completedCases).toBe(19);
    expect(summary.uncertainBillingCaseIds).toEqual([ids[19]]);
    expect(summary.blockers).toContain("report 2: batch is incomplete or has an active case");
    expect(summary.scriptReviewGatePassed).toBe(false);
  });

  it("rejects changed fixture, inconsistent cost and failed review", () => {
    const first = report(1, 10);
    first.fixtureSha256 = "0".repeat(64);
    first.estimatedCostUsd = 0;
    first.results[0]!.reviewerAccepted = false;
    const summary = summarizeVideoReports([
      input(first, "a"), input(report(11, 10), "b"),
    ], ids, fixture, catalogue);
    expect(summary.failedCaseIds).toEqual([ids[0]]);
    expect(summary.blockers).toContain("report 1: fixture or catalogue hash differs from current source");
    expect(summary.blockers).toContain("report 1: reported estimated cost disagrees with results");
    expect(summary.scriptReviewGatePassed).toBe(false);
  });

  it("holds writer failure and mixed models even if reviewers say accepted", () => {
    const first = report(1, 10);
    first.results[0]!.writerValid = false;
    const second = report(11, 10);
    second.model = "different-model";
    const summary = summarizeVideoReports([
      input(first, "a"), input(second, "b"),
    ], ids, fixture, catalogue);
    expect(summary.failedCaseIds).toEqual([ids[0]]);
    expect(summary.blockers).toContain("Reports use different or missing models");
    expect(summary.scriptReviewGatePassed).toBe(false);
  });

  it("holds a claimed acceptance when the reviewed IR digest or citation is missing", () => {
    const first = report(1, 10);
    first.results[0]!.irSha256 = "0".repeat(64);
    first.results[1]!.sceneSources = [];
    const summary = summarizeVideoReports([
      input(first, "a"), input(report(11, 10), "b"),
    ], ids, fixture, catalogue);
    expect(summary.failedCaseIds).toEqual([ids[0], ids[1]]);
    expect(summary.blockers).toContain(`report 1: accepted case ${ids[0]} lacks intact IR or citations`);
    expect(summary.blockers).toContain(`report 1: accepted case ${ids[1]} lacks intact IR or citations`);
    expect(summary.scriptReviewGatePassed).toBe(false);
  });
});
