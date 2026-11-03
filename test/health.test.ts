import { beforeEach, describe, expect, it } from 'bun:test';

import { createApp } from '../src/app.ts';
import { config } from '../src/config.ts';
import { createReadinessCheck } from '../src/health.ts';
import { configureLogger } from '../src/logger.ts';
import type { ReceiptScanner } from '../src/scanners/index.ts';

const testConfig = { ...config, turnstileSecretKey: undefined, ocrUrl: 'http://ocr', llmUrl: 'http://llm/v1' };
const stubScanner: ReceiptScanner = { scan: async () => ({ items: [] }) };

beforeEach(() => configureLogger({ level: 'OFF' }));

/** A fetch stub that answers each URL with the given status, or throws for 'down' */
const stubFetch = (answers: Record<string, number | 'down'>, calls: string[] = []) =>
  (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push(url);
    const answer = answers[url];
    if (answer === undefined || answer === 'down') throw new Error(`connect ECONNREFUSED ${url}`);
    expect(init?.signal).toBeDefined();
    return new Response('{}', { status: answer });
  }) as typeof fetch;

const options = { ocrUrl: 'http://ocr', llmUrl: 'http://llm/v1', timeoutMs: 1000 };

describe('readiness check', () => {
  it('is ready when OCR and the LLM answer', async () => {
    const calls: string[] = [];
    const check = createReadinessCheck(options, stubFetch({ 'http://ocr/readyz': 200, 'http://llm/v1/models': 200 }, calls));
    const result = await check();
    expect(result.ready).toBe(true);
    expect(calls.sort()).toEqual(['http://llm/v1/models', 'http://ocr/readyz']);
  });

  it('is not ready while OCR loads its models', async () => {
    const check = createReadinessCheck(options, stubFetch({ 'http://ocr/readyz': 503, 'http://llm/v1/models': 200 }));
    const result = await check();
    expect(result.ready).toBe(false);
    expect(result.checks.ocr).toMatchObject({ ok: false, status: 503 });
    expect(result.checks.llm.ok).toBe(true);
  });

  it('is not ready when the LLM is unreachable', async () => {
    const check = createReadinessCheck(options, stubFetch({ 'http://ocr/readyz': 200, 'http://llm/v1/models': 'down' }));
    const result = await check();
    expect(result.ready).toBe(false);
    expect(result.checks.llm.error).toContain('ECONNREFUSED');
  });

  it('sends the LLM API key', async () => {
    let auth: string | null | undefined;
    const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input).endsWith('/models')) auth = new Headers(init?.headers).get('authorization');
      return new Response('{}');
    }) as typeof fetch;
    await createReadinessCheck({ ...options, llmApiKey: 'sk-test' }, fetchFn)();
    expect(auth).toBe('Bearer sk-test');
  });

  it('shares one check between calls in a short window', async () => {
    const calls: string[] = [];
    const check = createReadinessCheck(options, stubFetch({ 'http://ocr/readyz': 200, 'http://llm/v1/models': 200 }, calls));
    await Promise.all([check(), check(), check()]);
    await check();
    expect(calls.length).toBe(2);
  });
});

describe('probe routes', () => {
  const app = (ready: boolean) =>
    createApp(testConfig, stubScanner, undefined, async () => ({
      ready,
      checks: {
        ocr: { ok: true, status: 200, elapsedMs: 1 },
        llm: ready ? { ok: true, status: 200, elapsedMs: 1 } : { ok: false, error: 'down', elapsedMs: 1 },
      },
    }));
  const get = (path: string, ready = false) => app(ready).handle(new Request(`http://localhost${path}`));

  it('answers /livez and /health without checking dependencies', async () => {
    for (const path of ['/livez', '/health']) {
      const res = await get(path);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ status: 'ok' });
    }
  });

  it('answers /readyz with 200 when ready', async () => {
    const res = await get('/readyz', true);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: 'ok', checks: { llm: { ok: true } } });
  });

  it('answers /readyz with 503 and the failing check when not ready', async () => {
    const res = await get('/readyz');
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ status: 'unavailable', checks: { llm: { ok: false, error: 'down' } } });
  });
});
