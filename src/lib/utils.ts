export function formatNumber(n: number) {
  return n.toLocaleString("en-US", { maximumFractionDigits: 2 });
}

export function formatCost(n: number) {
  return `$${n.toFixed(2)}`;
}

export function formatPercentage(rate: number | undefined) {
  return typeof rate === "number" && Number.isFinite(rate) ? `${(rate * 100).toFixed(1)}%` : "—";
}

export function formatSpeed(speed: number | undefined) {
  if (typeof speed !== "number" || !Number.isFinite(speed)) return "—";
  return `${Number(speed.toFixed(1))} t/s`;
}

export function abortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  signal.throwIfAborted();

  return new Promise<T>((resolve, reject) => {
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    const onAbort = () => {
      cleanup();
      reject(signal.reason);
    };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error) => {
        cleanup();
        reject(error);
      },
    );
  });
}

export function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

export function hasResponseError(response: unknown): boolean {
  if (!response || typeof response !== "object") return false;
  return Boolean((response as { error?: unknown }).error);
}

/** Run independent work with stable result order and a bounded worker pool. */
export async function mapWithConcurrency<Input, Output>(
  inputs: ReadonlyArray<Input>,
  concurrency: number,
  task: (input: Input, index: number) => Promise<Output>,
  signal?: AbortSignal,
) {
  const results: Output[] = [];
  results.length = inputs.length;
  const limit = Number.isFinite(concurrency) ? Math.max(1, Math.floor(concurrency)) : 1;
  let nextIndex = 0;

  const worker = async () => {
    while (true) {
      signal?.throwIfAborted();
      const index = nextIndex++;
      if (index >= inputs.length) return;
      results[index] = await task(inputs[index], index);
    }
  };

  await Promise.all(Array.from({ length: Math.min(limit, inputs.length) }, () => worker()));
  return results;
}
