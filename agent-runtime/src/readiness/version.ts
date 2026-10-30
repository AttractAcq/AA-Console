/** A build identity is evidence only when it is the complete Git commit. */
export function deployedCommitSha(env: NodeJS.ProcessEnv = process.env): string | null {
  for (const key of ["RAILWAY_GIT_COMMIT_SHA", "RENDER_GIT_COMMIT", "VERCEL_GIT_COMMIT_SHA", "SOURCE_VERSION"]) {
    const value = env[key]?.trim() ?? "";
    if (/^[0-9a-f]{40}$/i.test(value)) return value.toLowerCase();
  }
  return null;
}
