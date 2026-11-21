import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const projectDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const functionSpec = Object.freeze({ memorySizeInMb: 3009,
  diskSizeInMb: 4096, timeoutInSeconds: 900 });
const expectedCompositions = Object.freeze([
  "VideoThumbnail", "VideoIR-16x9", "VideoIR-9x16", "VideoIR-1x1",
]);

export function releasePlan({ sha, expectedSha, region, clean,
  licenseConfirmed, execute }) {
  if (!/^[0-9a-f]{40}$/.test(sha)
    || !/^[0-9a-f]{40}$/.test(expectedSha)
    || sha !== expectedSha) throw new Error("Renderer release SHA does not match the reviewed commit.");
  if (!clean) throw new Error("Renderer deployment requires a clean checkout.");
  if (!/^[a-z]{2}(?:-[a-z]+)+-[1-9]$/.test(region ?? "")) {
    throw new Error("REMOTION_AWS_REGION must identify one AWS region.");
  }
  if (execute && !licenseConfirmed) {
    throw new Error("Remotion licence eligibility must be confirmed before provisioning.");
  }
  return { sha, region, siteName: `aa-video-${sha.slice(0,12)}`,
    functionSpec, expectedCompositions, execute };
}

function git(...args) {
  return execFileSync("git", args, { cwd: projectDir,
    encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

export async function deployVerified(plan, provider) {
  const { functionName } = await provider.deployFunction({
    region: plan.region, ...plan.functionSpec,
    createCloudWatchLogGroup: true,
    cloudWatchLogRetentionPeriodInDays: 14,
  });
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(functionName)) {
    throw new Error("Remotion returned an invalid function name.");
  }
  const { bucketName } = await provider.getOrCreateBucket({ region: plan.region });
  if (!bucketName) throw new Error("Remotion returned no bucket.");
  const { serveUrl, siteName } = await provider.deploySite({
    entryPoint: resolve(projectDir, "src/index.ts"),
    bucketName, region: plan.region, siteName: plan.siteName,
    throwIfSiteExists: true,
  });
  if (siteName !== plan.siteName || !serveUrl?.startsWith("https://")) {
    throw new Error("Remotion site identity differs from the pinned release.");
  }
  const functionInfo = await provider.getFunctionInfo({
    region: plan.region, functionName });
  if (functionInfo.functionName !== functionName
    || functionInfo.version !== "4.0.545"
    || functionInfo.memorySizeInMb !== plan.functionSpec.memorySizeInMb
    || functionInfo.diskSizeInMb !== plan.functionSpec.diskSizeInMb
    || functionInfo.timeoutInSeconds !== plan.functionSpec.timeoutInSeconds) {
    throw new Error("The deployed Lambda function failed identity read-back.");
  }
  const compositions = await provider.getCompositionsOnLambda({
    region: plan.region, functionName, serveUrl, inputProps: {},
  });
  const ids = new Set(compositions.map((item) => item.id));
  if (plan.expectedCompositions.some((id) => !ids.has(id))) {
    throw new Error("The deployed site is missing a required video composition.");
  }
  return { sourceSha: plan.sha, region: plan.region,
    functionName, serveUrl, siteName,
    functionVersion: functionInfo.version,
    compositions: plan.expectedCompositions };
}

async function main() {
  const execute = process.argv.includes("--execute");
  const shaArg = process.argv.find((arg) => arg.startsWith("--expected-sha="));
  const expectedSha = shaArg?.slice("--expected-sha=".length) ?? "";
  const plan = releasePlan({ sha: git("rev-parse", "HEAD"),
    expectedSha, region: process.env.REMOTION_AWS_REGION,
    clean: git("status", "--porcelain").length === 0,
    licenseConfirmed: process.env.AA_REMOTION_LICENSE_CONFIRMED === "1",
    execute });
  if (!execute) {
    process.stdout.write(`${JSON.stringify({ ...plan,
      note: "Read-only plan. Add --execute only for the approved AWS release." }, null, 2)}\n`);
    return;
  }
  const lambda = await import("@remotion/lambda");
  const client = await import("@remotion/lambda/client");
  const result = await deployVerified(plan, { ...lambda,
    getCompositionsOnLambda: client.getCompositionsOnLambda });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : "Video Lambda deployment failed."}\n`);
    process.exitCode = 1;
  });
}
