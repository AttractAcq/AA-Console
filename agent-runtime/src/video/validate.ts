import { Ajv2020 } from "ajv/dist/2020.js";
import irSchema from "./ir.schema.json" with { type: "json" };
import { semanticProblems } from "./semantic.js";

const ajv = new Ajv2020({ allErrors: true, strict: false });
const checkShape = ajv.compile(irSchema);
export type RuntimeIR = Parameters<typeof semanticProblems>[0];
export type RuntimeIRValidation =
  | { ok: true; ir: RuntimeIR }
  | { ok: false; problems: string[] };

export function validateRuntimeIR(raw: unknown): RuntimeIRValidation {
  if (!checkShape(raw)) return {
    ok: false,
    problems: (checkShape.errors ?? []).map((error) =>
      `${error.instancePath || "root"}: ${error.message ?? "invalid value"}`),
  };
  const ir = raw as RuntimeIR;
  const problems = semanticProblems(ir);
  return problems.length ? { ok: false, problems } : { ok: true, ir };
}

export function parseRuntimeIR(raw: unknown): RuntimeIR {
  const result = validateRuntimeIR(raw);
  if (!result.ok) throw new Error(`Invalid video IR:\n${result.problems.join("\n")}`);
  return result.ir;
}
