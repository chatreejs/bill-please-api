import { beforeEach, describe, expect, it } from 'bun:test';

import { createApp } from '../src/app.ts';
import { config } from '../src/config.ts';
import { createDependencyMonitor, createReadinessCheck, type Readiness } from '../src/health.ts';
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

const readiness = (ready: boolean): Readiness => ({
  ready,
  checks: {
    ocr: { ok: true, status: 200, elapsedMs: 1 },
    llm: ready ? { ok: true, status: 200, elapsedMs: 1 } : { ok: false, error: 'down', elapsedMs: 1 },
  },
});

/** A monitor whose dependencies are up or down as `state.ready` says */
const switchableMonitor = (state = { ready: true }) =>
  createDependencyMonitor(async () => readiness(state.ready), { failuresBeforeUnavailable: 1 });

describe('dependency monitor', () => {
  it('turns unavailable after enough failed checks in a row, and back on the first good one', async () => {
    const state = { ready: true };
    const monitor = createDependencyMonitor(async () => readiness(state.ready), { failuresBeforeUnavailable: 2 });
    const changes: boolean[] = [];
    monitor.onChange((available) => changes.push(available));

    expect(monitor.available).toBe(true);
    state.ready = false;
    await monitor.check();
    expect(monitor.available).toBe(true);
    await monitor.check();
    expect(monitor.available).toBe(false);
    await monitor.check();
    state.ready = true;
    await monitor.check();
    expect(monitor.available).toBe(true);
    expect(changes).toEqual([false, true]);
  });

  it('resets the failure count after a good check', async () => {
    const results = [false, true, false];
    const monitor = createDependencyMonitor(async () => readiness(results.shift() ?? true), {
      failuresBeforeUnavailable: 2,
    });
    for (let i = 0; i < 3; i++) await monitor.check();
    expect(monitor.available).toBe(true);
  });

  it('checks in the background between start and stop', async () => {
    let calls = 0;
    const monitor = createDependencyMonitor(
      async () => {
        calls++;
        return readiness(true);
      },
      { intervalMs: 5 },
    );
    monitor.start();
    await Bun.sleep(30);
    monitor.stop();
    const afterStop = calls;
    expect(afterStop).toBeGreaterThan(1);
    await Bun.sleep(20);
    expect(calls).toBe(afterStop);
  });
});

describe('probe routes', () => {
  const get = (path: string, ready = false) =>
    createApp(testConfig, stubScanner, undefined, switchableMonitor({ ready })).handle(
      new Request(`http://localhost${path}`),
    );

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

describe('while OCR or the LLM is down', () => {
  const setup = async () => {
    const state = { ready: true };
    const monitor = switchableMonitor(state);
    let scans = 0;
    const scanner: ReceiptScanner = {
      scan: async () => {
        scans++;
        return { items: [] };
      },
    };
    const app = createApp(testConfig, scanner, undefined, monitor);
    const goDown = async () => {
      state.ready = false;
      await monitor.check();
    };
    return { app, monitor, state, goDown, scans: () => scans };
  };

  const scanRequest = (accept?: string) => {
    const form = new FormData();
    form.append('image', new File([new Uint8Array([137, 80, 78, 71])], 'bill.png', { type: 'image/png' }));
    return new Request('http://localhost/api/receipts/scan', {
      method: 'POST',
      body: form,
      headers: accept ? { accept } : {},
    });
  };

  it('reports available: false on the status endpoint', async () => {
    const { app, goDown } = await setup();
    const status = async () => (await app.handle(new Request('http://localhost/api/receipts/status'))).json();
    expect(await status()).toMatchObject({ available: true });
    await goDown();
    expect(await status()).toMatchObject({ available: false, busy: false });
  });

  it('pushes a status event on the open stream when a dependency goes down', async () => {
    const { app, goDown } = await setup();
    const controller = new AbortController();
    const res = await app.handle(
      new Request('http://localhost/api/receipts/status', {
        headers: { accept: 'text/event-stream' },
        signal: controller.signal,
      }),
    );
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let text = '';
    const readUntil = async (match: string) => {
      while (!text.includes(match)) text += decoder.decode((await reader.read()).value);
    };
    await readUntil('"available":true');
    await goDown();
    await readUntil('"available":false');
    controller.abort();
    await reader.cancel();
  });

  it('answers a scan with 503 scanner_unavailable without calling the scanner', async () => {
    const { app, goDown, scans } = await setup();
    await goDown();
    const res = await app.handle(scanRequest());
    expect(res.status).toBe(503);
    expect(res.headers.get('retry-after')).toBe('30');
    expect(await res.json()).toEqual({
      error: 'The receipt scanner is temporarily unavailable',
      code: 'scanner_unavailable',
    });
    expect(scans()).toBe(0);
  });

  it('answers with a real 503 before a scan stream starts', async () => {
    const { app, goDown } = await setup();
    await goDown();
    const res = await app.handle(scanRequest('text/event-stream'));
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ code: 'scanner_unavailable' });
  });

  it('scans again once the dependencies come back', async () => {
    const { app, monitor, state, goDown } = await setup();
    await goDown();
    state.ready = true;
    await monitor.check();
    expect((await app.handle(scanRequest())).status).toBe(200);
  });
});
