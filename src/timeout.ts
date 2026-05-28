export function formatSeconds(ms: number): string {
  return `${Math.round(ms / 1000)}s`;
}

/**
 * Race a promise against a timeout. Does NOT cancel the underlying promise —
 * cleanup must be handled via the optional `onTimeout` callback or the caller's
 * own finally/cleanup logic.
 */
export async function raceWithTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string,
  onTimeout?: () => void,
): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => {
      onTimeout?.();
      reject(
        new Error(`${label} timed out after ${formatSeconds(timeoutMs)}`),
      );
    }, timeoutMs);
  });

  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}
