// Offline reconciliation of paid storyboard/review batch reports. No provider call.
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { reserveJsonReport } from "./video-report.js";

type Row = Record<string, unknown>;
type Input = { sha256: string; value: unknown };

const digest = (text: string) => createHash("sha256").update(text).digest("hex");
const object = (value: unknown): Row | null =>
  value && typeof value === "object" && !Array.isArray(value)
    ? value as Row : null;
const strings = (value: unknown): string[] | null =>
  Array.isArray(value) && value.every((item) => typeof item === "string")
    ? value as string[] : null;
const money = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0;

function acceptedEvidenceIsIntact(result: Row): boolean {
  const ir = object(result.reviewedIr);
  if (!ir || !Array.isArray(ir.scenes) || ir.scenes.length === 0
    || typeof result.irSha256 !== "string"
    || !/^[a-f0-9]{64}$/.test(result.irSha256)
    || digest(JSON.stringify(ir)) !== result.irSha256
    || !Array.isArray(result.sceneSources)
    || result.sceneSources.length !== ir.scenes.length) return false;
  const sceneIds = ir.scenes.map((scene) => object(scene)?.id);
  const cited = result.sceneSources.map((entry) => object(entry));
  return sceneIds.every((id) => typeof id === "string")
    && new Set(sceneIds).size === sceneIds.length
    && cited.every((entry) => entry
      && typeof entry.sceneId === "string"
      && sceneIds.includes(entry.sceneId)
      && strings(entry.sourceIds)?.length)
    && new Set(cited.map((entry) => entry?.sceneId)).size === cited.length;
}

export function summarizeVideoReports(inputs: Input[], expectedIds: string[],
  fixtureSha256: string, catalogueSha256: string) {
  if (inputs.length === 0 || expectedIds.length !== 20
    || new Set(expectedIds).size !== expectedIds.length) {
    throw new Error("Provide reports and the exact 20-case evaluation manifest.");
  }
  const blockers: string[] = [];
  const seen = new Set<string>();
  const failedCaseIds: string[] = [];
  const uncertainBillingCaseIds: string[] = [];
  const models = new Set<string>();
  let completedCases = 0;
  let writerValidCases = 0;
  let reviewerAcceptedCases = 0;
  let estimatedCostUsd = 0;

  for (const [index, input] of inputs.entries()) {
    const label = `report ${index + 1}`;
    const report = object(input.value);
    if (!report || report.kind !== "video_script_review_evaluation_v1") {
      blockers.push(`${label}: invalid report kind`);
      continue;
    }
    if (report.fixtureSha256 !== fixtureSha256
      || report.catalogueSha256 !== catalogueSha256) {
      blockers.push(`${label}: fixture or catalogue hash differs from current source`);
    }
    if (typeof report.model !== "string" || !report.model.trim()) {
      blockers.push(`${label}: model is missing`);
    } else models.add(report.model);
    const ids = strings(report.selectedCaseIds);
    const start = report.startCase;
    if (!ids || !Number.isInteger(start) || (start as number) < 1
      || (start as number) + ids.length - 1 > expectedIds.length
      || ids.length === 0 || report.selectedCases !== ids.length) {
      blockers.push(`${label}: invalid selected range`);
      continue;
    }
    for (const [offset, id] of ids.entries()) {
      if (id !== expectedIds[(start as number) - 1 + offset])
        blockers.push(`${label}: selected case ${id} is out of manifest order`);
      if (seen.has(id)) blockers.push(`${label}: duplicate selected case ${id}`);
      seen.add(id);
    }
    const results = Array.isArray(report.results) ? report.results : null;
    if (!results || report.completedCases !== results.length
      || results.length > ids.length) {
      blockers.push(`${label}: completed result count is invalid`);
      continue;
    }
    let reportCost = 0;
    for (const [offset, raw] of results.entries()) {
      const result = object(raw);
      if (!result || result.id !== ids[offset] || !money(result.estimatedCostUsd)
        || typeof result.writerValid !== "boolean"
        || (result.reviewerAccepted !== null
          && typeof result.reviewerAccepted !== "boolean")
        || (result.error !== null && typeof result.error !== "string")) {
        blockers.push(`${label}: result ${offset + 1} is invalid or out of order`);
        continue;
      }
      completedCases++;
      reportCost += result.estimatedCostUsd;
      estimatedCostUsd += result.estimatedCostUsd;
      const id = ids[offset]!;
      if (result.writerValid) writerValidCases++;
      else failedCaseIds.push(id);
      if (result.reviewerAccepted === true) reviewerAcceptedCases++;
      else failedCaseIds.push(id);
      if (result.reviewerAccepted === true && !acceptedEvidenceIsIntact(result)) {
        blockers.push(`${label}: accepted case ${id} lacks intact IR or citations`);
        if (!failedCaseIds.includes(id)) failedCaseIds.push(id);
      }
      if (result.error !== null && !failedCaseIds.includes(id))
        failedCaseIds.push(id);
      if (result.error === "provider_or_runtime_error")
        uncertainBillingCaseIds.push(id);
    }
    if (!money(report.estimatedCostUsd)
      || Math.abs(report.estimatedCostUsd - reportCost) > 0.000001) {
      blockers.push(`${label}: reported estimated cost disagrees with results`);
    }
    if (report.runStatus !== "complete" || results.length !== ids.length
      || report.activeCaseId !== null) {
      blockers.push(`${label}: batch is incomplete or has an active case`);
      if (typeof report.activeCaseId === "string")
        uncertainBillingCaseIds.push(report.activeCaseId);
    }
    if (report.costCoverage !== "model_usage_estimate_not_provider_invoice") {
      blockers.push(`${label}: provider billing is unresolved`);
    }
  }
  if (models.size !== 1) blockers.push("Reports use different or missing models");
  const missingCaseIds = expectedIds.filter((id) => !seen.has(id));
  if (missingCaseIds.length) blockers.push("The manifest has uncovered cases");
  if (failedCaseIds.length) blockers.push("Writer/reviewer quality failed for one or more cases");
  const scriptReviewGatePassed = blockers.length === 0
    && completedCases === expectedIds.length;
  return {
    kind: "video_script_review_summary_v1",
    fixtureSha256, catalogueSha256,
    model: models.size === 1 ? [...models][0] : null,
    reportSha256: inputs.map((input) => input.sha256),
    selectedCases: seen.size, completedCases,
    missingCaseIds, failedCaseIds: [...new Set(failedCaseIds)],
    uncertainBillingCaseIds: [...new Set(uncertainBillingCaseIds)],
    writerValidateRate: completedCases ? writerValidCases / completedCases : null,
    reviewerAcceptRate: completedCases ? reviewerAcceptedCases / completedCases : null,
    estimatedCostUsd: Math.round(estimatedCostUsd * 1e6) / 1e6,
    costCoverage: "model_usage_estimate_not_provider_invoice",
    providerInvoiceReconciled: false,
    scriptReviewGatePassed,
    videoAcceptance: "not_assessed",
    blockers,
  };
}

async function main() {
  const index = process.argv.indexOf("--out");
  const out = index > 0 ? process.argv[index + 1] : undefined;
  const paths = process.argv.slice(2).filter((arg, position, all) =>
    arg !== "--out" && !(position > 0 && all[position - 1] === "--out"));
  if (!out || !paths.length || paths.some((path) => path.startsWith("--"))) {
    throw new Error("Use --out <new JSON path> followed by one or more batch report paths.");
  }
  const fixture = await readFile(new URL("../../eval/video/ideas.json", import.meta.url), "utf8");
  const catalogue = await readFile(new URL("../video/catalogue.md", import.meta.url), "utf8");
  const manifest = JSON.parse(fixture) as unknown;
  if (!Array.isArray(manifest) || manifest.length !== 20
    || manifest.some((item) => !object(item) || typeof object(item)?.id !== "string")) {
    throw new Error("Current evaluation manifest is invalid.");
  }
  const inputs = await Promise.all(paths.map(async (path) => {
    const raw = await readFile(resolve(path), "utf8");
    return { sha256: digest(raw), value: JSON.parse(raw) as unknown };
  }));
  const summary = summarizeVideoReports(inputs,
    manifest.map((item) => (item as Row).id as string), digest(fixture), digest(catalogue));
  await reserveJsonReport(resolve(out), summary);
  process.stdout.write(JSON.stringify({ completedCases: summary.completedCases,
    missingCaseIds: summary.missingCaseIds,
    estimatedCostUsd: summary.estimatedCostUsd,
    scriptReviewGatePassed: summary.scriptReviewGatePassed,
    blockers: summary.blockers }) + "\n");
  if (!summary.scriptReviewGatePassed) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : "Video summary failed."}\n`);
    process.exitCode = 1;
  });
}
