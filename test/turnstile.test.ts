import { beforeEach, describe, expect, it } from 'bun:test';

import { createApp } from '../src/app.ts';
import { config } from '../src/config.ts';
import { configureLogger } from '../src/logger.ts';
import type { ReceiptScanner } from '../src/scanners/index.ts';
import { createTurnstileVerifier, RECEIPT_SCAN_ACTION, SITEVERIFY_URL } from '../src/turnstile.ts';

const testConfig = { ...config, rateLimitPerMinute: 1000, maxImageBytes: 1024, trustProxy: true };
const png = new File([new Uint8Array([137, 80, 78, 71])], 'bill.png', { type: 'image/png' });

let scans = 0;
const countingScanner: ReceiptScanner = {
  scan: async () => {
    scans++;
    return { items: [{ name: 'Pad Thai', quantity: 1, price: 120 }] };
  },
};

type Siteverify = {
  success: boolean;
  'error-codes'?: string[];
  hostname?: string;
  action?: string;
  metadata?: { result_with_testing_key?: boolean };
};
let calls: FormData[] = [];
const siteverify =
  (answer: Siteverify | (() => never)): typeof fetch =>
  (async (input: string | URL | Request, init?: RequestInit) => {
    expect(String(input)).toBe(SITEVERIFY_URL);
    calls.push(init?.body as FormData);
    if (typeof answer === 'function') answer();
    return Response.json(answer);
  }) as typeof fetch;

const passed: Siteverify = { success: true, hostname: 'bill-please.chatree.dev', action: RECEIPT_SCAN_ACTION };

const appWith = (answer: Siteverify | (() => never), hostnames = ['bill-please.chatree.dev']) =>
  createApp(
    testConfig,
    countingScanner,
    createTurnstileVerifier({ secretKey: 'test-secret', hostnames, timeoutMs: 1000 }, siteverify(answer)),
  );

const scan = (app: ReturnType<typeof createApp>, token?: string) => {
  const form = new FormData();
  form.append('image', png);
  if (token !== undefined) form.append('cf-turnstile-response', token);
  return app.handle(
    new Request('http://localhost/api/receipts/scan', {
      method: 'POST',
      body: form,
      headers: { 'cf-connecting-ip': '203.0.113.7' },
    }),
  );
};

beforeEach(() => {
  scans = 0;
  calls = [];
  configureLogger({ level: 'OFF', write: () => {} });
});

describe('Turnstile on POST /api/receipts/scan', () => {
  it('scans when Cloudflare accepts the token', async () => {
    const res = await scan(appWith(passed), 'token-1');
    expect(res.status).toBe(200);
    expect(scans).toBe(1);
    expect(calls[0]?.get('secret')).toBe('test-secret');
    expect(calls[0]?.get('response')).toBe('token-1');
    expect(calls[0]?.get('remoteip')).toBe('203.0.113.7');
  });

  it('answers 403 without calling Cloudflare when the token is missing', async () => {
    const res = await scan(appWith(passed));
    expect(res.status).toBe(403);
    expect(calls).toHaveLength(0);
    expect(scans).toBe(0);
  });

  it('answers 403 when Cloudflare rejects the token', async () => {
    const res = await scan(appWith({ success: false, 'error-codes': ['timeout-or-duplicate'] }), 'used');
    expect(res.status).toBe(403);
    expect(scans).toBe(0);
  });

  it('answers 403 for a token from another action', async () => {
    const res = await scan(appWith({ ...passed, action: 'login' }), 'token-1');
    expect(res.status).toBe(403);
    expect(scans).toBe(0);
  });

  it('answers 403 for a token from another hostname', async () => {
    const res = await scan(appWith({ ...passed, hostname: 'evil.example' }), 'token-1');
    expect(res.status).toBe(403);
    expect(scans).toBe(0);
  });

  it('accepts any hostname when TURNSTILE_HOSTNAMES is empty', async () => {
    const res = await scan(appWith({ ...passed, hostname: 'bill-please-git-x.vercel.app' }, []), 'token-1');
    expect(res.status).toBe(200);
  });

  it("accepts Cloudflare's test key results, which carry no action", async () => {
    const testKey = { success: true, hostname: 'example.com', metadata: { result_with_testing_key: true } };
    const res = await scan(appWith(testKey), 'XXXX.DUMMY.TOKEN.XXXX');
    expect(res.status).toBe(200);
  });

  it('answers 503 when siteverify is unreachable', async () => {
    const res = await scan(
      appWith(() => {
        throw new Error('network down');
      }),
      'token-1',
    );
    expect(res.status).toBe(503);
    expect(scans).toBe(0);
  });

  it('skips the check when no secret key is set', async () => {
    expect(createTurnstileVerifier({ hostnames: [], timeoutMs: 1000 })).toBeUndefined();
    const app = createApp({ ...testConfig, turnstileSecretKey: undefined }, countingScanner);
    const res = await scan(app);
    expect(res.status).toBe(200);
    expect(scans).toBe(1);
  });
});
