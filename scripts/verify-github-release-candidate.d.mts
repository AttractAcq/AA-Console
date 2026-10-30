export interface RequiredReleaseCheck {
  name: string;
  headSha: string;
  runId: string;
  checkRunId: number;
}

export interface PendingMigrationHash {
  version: string;
  filename: string;
  sha256: string;
}

/** GitHub and committed-tree evidence only. This is not a production release
 * approval or a deployment artifact identity. */
export interface GithubPremergePacket {
  schemaVersion: 1;
  kind: 'github_premerge_release_evidence';
  repository: { id: number; fullName: 'AttractAcq/AA-Console' };
  pr: {
    number: number;
    url: string;
    head: { sha: string; ref: string; repositoryId: number };
    base: { sha: string; ref: string; repositoryId: number };
  };
  checks: { workflowRunId: string; workflowSha256: string; required: RequiredReleaseCheck[] };
  migrations: {
    sourceMarkerHead: string;
    targetHead: string;
    pending: PendingMigrationHash[];
  };
  premergePrHeadSha: string;
  /** Unknown until GitHub creates the merge/squash/rebase result. */
  futureDeploymentSha: null;
  productionSchemaVerified: false;
  releaseAuthorized: false;
  /** SHA-256 of the canonical JSON packet without this field. */
  packetSha256: string;
}

export interface VerifyGithubReleaseCandidateOptions {
  prNumber: number;
  checkoutDir?: string;
  fetcher?: typeof fetch;
  token?: string | null;
  timeoutMs?: number;
}

export const REQUIRED_RELEASE_CHECKS: readonly string[];
export function canonicalJson(value: unknown): string;
export function verifyGithubReleaseCandidate(
  options: VerifyGithubReleaseCandidateOptions,
): Promise<GithubPremergePacket>;
