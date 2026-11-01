import { beforeEach, describe, expect, it } from 'bun:test';

import { createApp } from '../src/app.ts';
import { config } from '../src/config.ts';
import { configureLogger } from '../src/logger.ts';
import { clientIp } from '../src/request-logger.ts';
import type { ReceiptScanner } from '../src/scanners/index.ts';

// Bun loads .env into tests, so turn Turnstile off here; test/turnstile.test.ts covers it
const testConfig = { ...config, rateLimitPerMinute: 1000, maxImageBytes: 1024, turnstileSecretKey: undefined };
const stubScanner: ReceiptScanner = {
  scan: async () => ({ items: [{ name: 'Pad Thai', quantity: 2, price: 120, servicePercentage: 10, vatPercentage: 7 }] }),
};
const app = createApp(testConfig, stubScanner);
const png = new File([new Uint8Array([137, 80, 78, 71])], 'bill.png', { type: 'image/png' });

// Capture log output instead of printing it
type LogRecord = Record<string, any>;
let logs: LogRecord[] = [];
beforeEach(() => {
  logs = [];
  configureLogger({ level: 'INFO', write: (line) => logs.push(JSON.parse(line)) });
});

// The access log is written after the response has been sent
const waitForLog = async (match: (record: LogRecord) => boolean) => {
  for (let i = 0; i < 50 && !logs.some(match); i++) await Bun.sleep(1);
  return logs.find(match);
};

const scan = (file: File, target = app) => {
  const form = new FormData();
  form.append('image', file);
  return target.handle(
    new Request('http://localhost/api/receipts/scan', { method: 'POST', body: form }),
  );
};

const mcp = (method: string, params: unknown = {}) =>
  app.handle(
    new Request('http://localhost/mcp', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    }),
  );

describe('REST /api/receipts/scan', () => {
  it('returns receipt items', async () => {
    const res = await scan(png);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: unknown[] };
    expect(body.items.length).toBeGreaterThan(0);
  });

  it('rejects non image files', async () => {
    const res = await scan(new File(['hi'], 'a.txt', { type: 'text/plain' }));
    expect(res.status).toBe(415);
  });

  it('rejects images over the size limit', async () => {
    const res = await scan(new File([new Uint8Array(2048)], 'big.png', { type: 'image/png' }));
    expect(res.status).toBe(413);
  });

  it('returns 502 when the scanner output breaks the contract', async () => {
    const broken: ReceiptScanner = {
      scan: async () => ({ items: [{ name: '', quantity: 0, price: 1 }] }),
    };
    const res = await scan(png, createApp(testConfig, broken));
    expect(res.status).toBe(502);
  });
});

describe('request logging', () => {
  it('assigns a request id and writes an access log record', async () => {
    const res = await scan(png);
    const requestId = res.headers.get('x-request-id');
    expect(requestId).toMatch(/^[0-9a-f]{8}$/);

    const record = await waitForLog((r) => r.requestId === requestId && r.logger === 'http.access');
    expect(record?.http).toMatchObject({ method: 'POST', path: '/api/receipts/scan', status: 200 });
    expect(logs.some((r) => r.requestId === requestId && r.logger === 'receipts.route')).toBe(true);
  });

  it('reuses a valid incoming X-Request-Id', async () => {
    const res = await app.handle(
      new Request('http://localhost/health', { headers: { 'x-request-id': 'trace-abc_123' } }),
    );
    expect(res.headers.get('x-request-id')).toBe('trace-abc_123');
  });

  it('ignores an unsafe incoming X-Request-Id', async () => {
    const res = await app.handle(
      new Request('http://localhost/health', { headers: { 'x-request-id': 'bad id with spaces' } }),
    );
    expect(res.headers.get('x-request-id')).toMatch(/^[0-9a-f]{8}$/);
  });

  it('logs /health from the web but not from kube-probe', async () => {
    const health = (userAgent: string) =>
      app.handle(new Request('http://localhost/health', { headers: { 'user-agent': userAgent } }));

    const probe = await health('kube-probe/1.31');
    const web = await health('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)');

    const record = await waitForLog((r) => r.requestId === web.headers.get('x-request-id'));
    expect(record?.level).toBe('info');
    expect(record?.userAgent).toBe('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)');
    expect(logs.some((r) => r.requestId === probe.headers.get('x-request-id'))).toBe(false);
  });

  it('logs scanner failures with the error', async () => {
    const broken: ReceiptScanner = {
      scan: async () => {
        throw new Error('model timeout');
      },
    };
    await scan(png, createApp(testConfig, broken));
    expect(logs.find((r) => r.msg === 'Receipt scan failed')?.error).toMatchObject({ type: 'Error', message: 'model timeout' });
    expect(await waitForLog((r) => r.level === 'error' && r.http?.status === 502)).toBeDefined();
  });
});

describe('clientIp', () => {
  const server = { requestIP: () => ({ address: '10.42.2.217' }) };
  const request = (headers: Record<string, string>) => new Request('http://localhost/', { headers });

  it('prefers CF-Connecting-IP, then X-Forwarded-For, behind the proxy', () => {
    const both = request({ 'cf-connecting-ip': '203.0.113.7', 'x-forwarded-for': '10.42.2.217, 10.42.0.1' });
    expect(clientIp(both, server, true)).toBe('203.0.113.7');
    expect(clientIp(request({ 'x-forwarded-for': '198.51.100.2, 10.42.0.1' }), server, true)).toBe('198.51.100.2');
    expect(clientIp(request({}), server, true)).toBe('10.42.2.217');
  });

  it('ignores proxy headers when TRUST_PROXY is off', () => {
    expect(clientIp(request({ 'cf-connecting-ip': '203.0.113.7' }), server, false)).toBe('10.42.2.217');
  });
});

describe('MCP /mcp', () => {
  it('initializes', async () => {
    const res = await mcp('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'test', version: '0.0.0' },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { result: { serverInfo: { name: string } } };
    expect(body.result.serverInfo.name).toBe('bill-please');
  });

  it('lists the scan_receipt tool', async () => {
    const body = (await (await mcp('tools/list')).json()) as {
      result: { tools: { name: string }[] };
    };
    expect(body.result.tools.map((tool) => tool.name)).toContain('scan_receipt');
  });

  it('scans a receipt via tools/call', async () => {
    const body = (await (
      await mcp('tools/call', {
        name: 'scan_receipt',
        arguments: { imageBase64: Buffer.from('fake').toString('base64'), mimeType: 'image/png' },
      })
    ).json()) as { result: { isError?: boolean; structuredContent: { items: unknown[] } } };
    expect(body.result.isError).toBeFalsy();
    expect(body.result.structuredContent.items.length).toBeGreaterThan(0);
  });
});

describe('cors', () => {
  const corsApp = createApp(
    { ...testConfig, corsOrigins: ['http://localhost:3000', 'https://bill-please-*-chatreejs-projects.vercel.app'] },
    stubScanner,
  );
  const allowOrigin = async (origin: string) =>
    (await corsApp.handle(new Request('http://localhost/health', { headers: { origin } }))).headers.get(
      'access-control-allow-origin',
    );

  it('allows exact and wildcard origins', async () => {
    expect(await allowOrigin('http://localhost:3000')).toBe('http://localhost:3000');
    expect(await allowOrigin('https://bill-please-2a4k1iats-chatreejs-projects.vercel.app')).toBe(
      'https://bill-please-2a4k1iats-chatreejs-projects.vercel.app',
    );
  });

  it('rejects origins outside the wildcard', async () => {
    expect(await allowOrigin('https://evil.example')).toBeNull();
    expect(await allowOrigin('https://bill-please-x.evil.com-chatreejs-projects.vercel.app')).toBeNull();
    expect(await allowOrigin('http://bill-please-2a4k1iats-chatreejs-projects.vercel.app')).toBeNull();
  });
});
