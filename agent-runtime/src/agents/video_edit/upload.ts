/** Retry a transient Storage failure against the same content-addressed path. */
export async function uploadRenderedCut(
  upload: () => Promise<{ error: { message: string; statusCode?: string | number } | null }>,
  options: { sleep?: (ms: number) => Promise<void>; onRetry?: (attempt: number, reason: string) => void } = {},
): Promise<void> {
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const { error } = await upload();
    if (!error) return;
    const status = Number(error.statusCode);
    const transient = status === 408 || status === 429 || status >= 500
      || /internal server error|timeout|fetch failed|network/i.test(error.message);
    if (!transient || attempt === 3) throw new Error(`Could not store the cut: ${error.message}`);
    options.onRetry?.(attempt, error.message);
    await sleep(attempt * 1_000);
  }
}
