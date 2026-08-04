export async function withTimeout<T>(
  work: (signal: AbortSignal | undefined) => Promise<T>,
  timeoutMs?: number,
  label?: string,
  upstreamSignal?: AbortSignal,
): Promise<T> {
  const resolved =
    typeof timeoutMs === "number" && Number.isFinite(timeoutMs)
      ? Math.max(1, Math.floor(timeoutMs))
      : undefined;
  if (!resolved && !upstreamSignal) {
    return await work(undefined);
  }

  const abortCtrl = new AbortController();
  const timeoutError = new Error(`${label ?? "request"} timed out`);
  const timer = resolved ? setTimeout(() => abortCtrl.abort(timeoutError), resolved) : undefined;
  timer?.unref?.();
  const onUpstreamAbort = () => abortCtrl.abort(upstreamSignal?.reason);
  if (upstreamSignal?.aborted) {
    onUpstreamAbort();
  } else {
    upstreamSignal?.addEventListener("abort", onUpstreamAbort, { once: true });
  }

  let abortListener: (() => void) | undefined;
  const abortPromise: Promise<never> = abortCtrl.signal.aborted
    ? Promise.reject(abortCtrl.signal.reason ?? timeoutError)
    : new Promise((_, reject) => {
        abortListener = () => reject(abortCtrl.signal.reason ?? timeoutError);
        abortCtrl.signal.addEventListener("abort", abortListener, { once: true });
      });

  try {
    return await Promise.race([work(abortCtrl.signal), abortPromise]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
    upstreamSignal?.removeEventListener("abort", onUpstreamAbort);
    if (abortListener) {
      abortCtrl.signal.removeEventListener("abort", abortListener);
    }
  }
}
