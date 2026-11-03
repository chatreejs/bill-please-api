import { getLogger } from './logger.ts';

const log = getLogger('health');

// /readyz is public, so concurrent calls share one check and reuse its result this long.
// Keep it under MONITOR_INTERVAL_MS, so each monitor tick runs a fresh check
const CACHE_MS = 2000;

// How often the monitor checks OCR and the LLM in the background
export const MONITOR_INTERVAL_MS = 5000;

// Failed checks in a row before scanning counts as unavailable, so one slow answer doesn't
// disable "Add from bill". With MONITOR_INTERVAL_MS this notices an outage within about 10 s
export const FAILURES_BEFORE_UNAVAILABLE = 2;

export interface DependencyCheck {
  ok: boolean;
  /** HTTP status the dependency answered, when it answered */
  status?: number;
  error?: string;
  elapsedMs: number;
}

export interface Readiness {
  ready: boolean;
  checks: { ocr: DependencyCheck; llm: DependencyCheck };
}

export type ReadinessCheck = () => Promise<Readiness>;

export interface ReadinessOptions {
  ocrUrl: string;
  llmUrl: string;
  llmApiKey?: string;
  /** Per dependency. Keep it under the probe's timeoutSeconds */
  timeoutMs: number;
}

const check = async (
  url: string,
  headers: Record<string, string>,
  timeoutMs: number,
  fetchFn: typeof fetch,
): Promise<DependencyCheck> => {
  const startedAt = performance.now();
  const elapsedMs = () => Math.round(performance.now() - startedAt);
  try {
    const res = await fetchFn(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
    // Drain the body so the connection can be released
    await res.body?.cancel();
    return res.ok
      ? { ok: true, status: res.status, elapsedMs: elapsedMs() }
      : { ok: false, status: res.status, error: `answered ${res.status}`, elapsedMs: elapsedMs() };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error), elapsedMs: elapsedMs() };
  }
};

/**
 * Checks that a scan could succeed right now: bill-please-ocr `GET /readyz` (200 once its models
 * have loaded) and the LLM's `GET /models`, which any OpenAI compatible API serves and llama.cpp
 * answers with 503 while it loads the model. Concurrent calls share one check, and a result is
 * reused for CACHE_MS, so a flood of /readyz requests never reaches the dependencies.
 */
export const createReadinessCheck = (
  { ocrUrl, llmUrl, llmApiKey, timeoutMs }: ReadinessOptions,
  fetchFn: typeof fetch = fetch,
): ReadinessCheck => {
  let cached: { at: number; result: Promise<Readiness> } | undefined;

  const run = async (): Promise<Readiness> => {
    const [ocr, llm] = await Promise.all([
      check(`${ocrUrl}/readyz`, {}, timeoutMs, fetchFn),
      check(`${llmUrl}/models`, llmApiKey ? { authorization: `Bearer ${llmApiKey}` } : {}, timeoutMs, fetchFn),
    ]);
    return { ready: ocr.ok && llm.ok, checks: { ocr, llm } };
  };

  return () => {
    const now = performance.now();
    if (!cached || now - cached.at >= CACHE_MS) cached = { at: now, result: run() };
    return cached.result;
  };
};

export type AvailabilityListener = (available: boolean) => void;

/** Whether OCR and the LLM answer, kept up to date in the background */
export interface DependencyMonitor {
  /** False once FAILURES_BEFORE_UNAVAILABLE checks in a row failed. True before the first check */
  readonly available: boolean;
  /** Runs the readiness check now and updates `available` */
  check(): Promise<Readiness>;
  /** Calls listener each time `available` changes. Returns a function that stops it */
  onChange(listener: AvailabilityListener): () => void;
  /** Checks now and then every intervalMs, until stop() */
  start(): void;
  stop(): void;
}

export const createDependencyMonitor = (
  checkReadiness: ReadinessCheck,
  { intervalMs = MONITOR_INTERVAL_MS, failuresBeforeUnavailable = FAILURES_BEFORE_UNAVAILABLE } = {},
): DependencyMonitor => {
  const listeners = new Set<AvailabilityListener>();
  let available = true;
  let failures = 0;
  let timer: ReturnType<typeof setInterval> | undefined;

  const update = (result: Readiness) => {
    failures = result.ready ? 0 : failures + 1;
    // Recover on the first good check, so the button comes back as soon as it can
    const next = result.ready || (available && failures < failuresBeforeUnavailable);
    if (next === available) return;
    available = next;
    if (available) log.info('Receipt scanning is available again', { checks: result.checks });
    else log.warn('Receipt scanning is unavailable, because a dependency is down', { checks: result.checks });
    for (const listener of listeners) listener(available);
  };

  const monitor: DependencyMonitor = {
    get available() {
      return available;
    },
    async check() {
      const result = await checkReadiness();
      update(result);
      return result;
    },
    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    start() {
      if (timer) return;
      void monitor.check();
      timer = setInterval(() => void monitor.check(), intervalMs);
      // Don't keep the process alive for the monitor alone
      timer.unref?.();
    },
    stop() {
      clearInterval(timer);
      timer = undefined;
    },
  };
  return monitor;
};
