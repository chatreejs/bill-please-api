import { getLogger } from './logger.ts';

const log = getLogger('health');

// Probes poll every 10 s and /readyz is public, so reuse one result for this long
const CACHE_MS = 5000;

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
  let lastReady: boolean | undefined;

  const run = async (): Promise<Readiness> => {
    const [ocr, llm] = await Promise.all([
      check(`${ocrUrl}/readyz`, {}, timeoutMs, fetchFn),
      check(`${llmUrl}/models`, llmApiKey ? { authorization: `Bearer ${llmApiKey}` } : {}, timeoutMs, fetchFn),
    ]);
    const result = { ready: ocr.ok && llm.ok, checks: { ocr, llm } };
    // Log changes only, because probes call this every 10 s
    if (result.ready !== lastReady) {
      if (result.ready) log.info('Dependencies are ready', { checks: result.checks });
      else log.warn('Dependencies are not ready', { checks: result.checks });
      lastReady = result.ready;
    }
    return result;
  };

  return () => {
    const now = performance.now();
    if (!cached || now - cached.at >= CACHE_MS) cached = { at: now, result: run() };
    return cached.result;
  };
};
