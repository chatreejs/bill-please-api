import { beforeEach, describe, expect, it } from 'bun:test';

import { createApp } from '../src/app.ts';
import { config } from '../src/config.ts';
import { configureLogger } from '../src/logger.ts';
import { ScannerBusyError } from '../src/scanners/errors.ts';
import { ConcurrencyLimiter } from '../src/scanners/llm-queue.ts';
import type { ReceiptScanner } from '../src/scanners/index.ts';

beforeEach(() => configureLogger({ level: 'OFF', write: () => {} }));

/** A task that runs until the test calls release() */
const gate = () => {
  let release!: () => void;
  const done = new Promise<void>((resolve) => (release = resolve));
  return { done, release };
};

const tick = () => Bun.sleep(1);

describe('ConcurrencyLimiter', () => {
  it('runs one task at a time and starts waiting tasks in order', async () => {
    const limiter = new ConcurrencyLimiter({ maxConcurrent: 1, maxQueue: 10, timeoutMs: 0 });
    const order: string[] = [];
    const gates = [gate(), gate(), gate()];
    const runs = gates.map((g, i) =>
      limiter.run(async () => {
        order.push(`start ${i}`);
        await g.done;
        order.push(`end ${i}`);
      }),
    );
    await tick();
    expect(order).toEqual(['start 0']);
    expect(limiter.stats).toMatchObject({ active: 1, waiting: 2 });

    gates[0]!.release();
    await tick();
    expect(order).toEqual(['start 0', 'end 0', 'start 1']);
    gates[1]!.release();
    gates[2]!.release();
    await Promise.all(runs);
    expect(order).toEqual(['start 0', 'end 0', 'start 1', 'end 1', 'start 2', 'end 2']);
    expect(limiter.stats).toMatchObject({ active: 0, waiting: 0 });
  });

  it('runs up to maxConcurrent tasks together', async () => {
    const limiter = new ConcurrencyLimiter({ maxConcurrent: 2, maxQueue: 10, timeoutMs: 0 });
    const g = gate();
    const runs = [1, 2, 3].map(() => limiter.run(() => g.done));
    await tick();
    expect(limiter.stats).toMatchObject({ active: 2, waiting: 1 });
    g.release();
    await Promise.all(runs);
  });

  it('frees the slot when a task throws', async () => {
    const limiter = new ConcurrencyLimiter({ maxConcurrent: 1, maxQueue: 10, timeoutMs: 0 });
    await expect(limiter.run(async () => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
    expect(await limiter.run(async () => 'ok')).toBe('ok');
  });

  it('rejects with ScannerBusyError when the queue is full', async () => {
    const limiter = new ConcurrencyLimiter({ maxConcurrent: 1, maxQueue: 1, timeoutMs: 0 });
    const g = gate();
    const first = limiter.run(() => g.done);
    const second = limiter.run(async () => 'second');
    const third = limiter.run(async () => 'third');
    await expect(third).rejects.toMatchObject({ name: 'ScannerBusyError', reason: 'queue_full' });
    g.release();
    await first;
    expect(await second).toBe('second');
  });

  it('gives up after timeoutMs in the queue', async () => {
    const limiter = new ConcurrencyLimiter({ maxConcurrent: 1, maxQueue: 10, timeoutMs: 20 });
    const g = gate();
    const first = limiter.run(() => g.done);
    const waiting = limiter.run(async () => 'never');
    await expect(waiting).rejects.toMatchObject({ name: 'ScannerBusyError', reason: 'queue_timeout' });
    expect(limiter.stats.waiting).toBe(0);
    g.release();
    await first;
  });

  it('drops a waiting task when its signal aborts', async () => {
    const limiter = new ConcurrencyLimiter({ maxConcurrent: 1, maxQueue: 10, timeoutMs: 0 });
    const g = gate();
    const first = limiter.run(() => g.done);
    const controller = new AbortController();
    let ran = false;
    const waiting = limiter.run(async () => void (ran = true), controller.signal);
    await tick();
    controller.abort(new Error('client went away'));
    await expect(waiting).rejects.toThrow('client went away');
    expect(limiter.stats.waiting).toBe(0);
    g.release();
    await first;
    expect(ran).toBe(false);
  });
});

describe('busy scanner responses', () => {
  const busyScanner: ReceiptScanner = {
    scan: async () => {
      throw new ScannerBusyError('10 scans are already waiting for the LLM', 'queue_full');
    },
  };
  const app = createApp({ ...config, rateLimitPerMinute: 1000, turnstileSecretKey: undefined }, busyScanner);

  it('answers 503 with Retry-After on REST', async () => {
    const form = new FormData();
    form.append('image', new File([new Uint8Array([137, 80, 78, 71])], 'bill.png', { type: 'image/png' }));
    const res = await app.handle(new Request('http://localhost/api/receipts/scan', { method: 'POST', body: form }));
    expect(res.status).toBe(503);
    expect(res.headers.get('retry-after')).toBe('15');
    expect(await res.json()).toEqual({ error: 'The receipt scanner is busy, try again shortly', code: 'scanner_busy' });
  });

  it('returns isError from the MCP tool', async () => {
    const res = await app.handle(
      new Request('http://localhost/mcp', {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: {
            name: 'scan_receipt',
            arguments: { imageBase64: Buffer.from('fake').toString('base64'), mimeType: 'image/png' },
          },
        }),
      }),
    );
    const body = (await res.json()) as { result: { isError: boolean; content: { text: string }[] } };
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0]!.text).toContain('busy');
  });
});

describe('GET /api/receipts/status', () => {
  const testConfig = { ...config, rateLimitPerMinute: 1, turnstileSecretKey: undefined };
  const limiter = new ConcurrencyLimiter({ maxConcurrent: 1, maxQueue: 1, timeoutMs: 0 });
  const queuedScanner: ReceiptScanner = {
    scan: async () => ({ items: [] }),
    status: () => limiter.status(),
  };
  const app = createApp(testConfig, queuedScanner);
  const status = async (target = app) =>
    (await target.handle(new Request('http://localhost/api/receipts/status'))).json();

  it('reports not busy while a queue place is free, and busy once the queue is full', async () => {
    expect(await status()).toEqual({
      status: 'ok',
      busy: false,
      queue: { active: 0, waiting: 0, maxConcurrent: 1, maxQueue: 1 },
    });

    const g = gate();
    const running = limiter.run(() => g.done);
    const waiting = limiter.run(async () => {});
    await tick();
    expect(await status()).toMatchObject({ busy: true, queue: { active: 1, waiting: 1 } });

    g.release();
    await Promise.all([running, waiting]);
    expect(await status()).toMatchObject({ busy: false, queue: { active: 0, waiting: 0 } });
  });

  it('skips the rate limit, because every open page polls it', async () => {
    for (let i = 0; i < 3; i++) {
      expect((await app.handle(new Request('http://localhost/api/receipts/status'))).status).toBe(200);
    }
  });

  it('reports not busy for a scanner without a queue', async () => {
    const plain = createApp(testConfig, { scan: async () => ({ items: [] }) });
    expect(await status(plain)).toEqual({ status: 'ok', busy: false });
  });
});

describe('GET /api/receipts/status as Server-Sent Events', () => {
  const testConfig = { ...config, rateLimitPerMinute: 1, turnstileSecretKey: undefined };

  /** Opens the stream and reads its `status` events as they arrive */
  const openStream = async (scanner: ReceiptScanner) => {
    const abort = new AbortController();
    const res = await createApp(testConfig, scanner).handle(
      new Request('http://localhost/api/receipts/status', {
        headers: { accept: 'text/event-stream' },
        signal: abort.signal,
      }),
    );
    const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader();
    let buffer = '';
    const next = async (): Promise<unknown> => {
      for (;;) {
        const end = buffer.indexOf('\n\n');
        if (end !== -1) {
          const block = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          const data = block.split('\n').find((line) => line.startsWith('data: '));
          if (block.startsWith('event: status') && data) return JSON.parse(data.slice(6));
          continue;
        }
        const { value, done } = await reader.read();
        if (done) throw new Error('The status stream ended');
        buffer += value;
      }
    };
    return { res, next, close: () => reader.cancel() };
  };

  it('sends the status now, then each time the queue changes', async () => {
    const limiter = new ConcurrencyLimiter({ maxConcurrent: 1, maxQueue: 1, timeoutMs: 0 });
    const stream = await openStream({
      scan: async () => ({ items: [] }),
      status: () => limiter.status(),
      onStatusChange: (listener) => limiter.onStatusChange(listener),
    });
    expect(stream.res.headers.get('content-type')).toBe('text/event-stream');
    expect(await stream.next()).toEqual({
      status: 'ok',
      busy: false,
      queue: { active: 0, waiting: 0, maxConcurrent: 1, maxQueue: 1 },
    });

    const g = gate();
    const running = limiter.run(() => g.done);
    expect(await stream.next()).toMatchObject({ busy: false, queue: { active: 1, waiting: 0 } });
    const waiting = limiter.run(async () => {});
    expect(await stream.next()).toMatchObject({ busy: true, queue: { active: 1, waiting: 1 } });

    g.release();
    await Promise.all([running, waiting]);
    // The waiting task took the slot, then finished
    expect(await stream.next()).toMatchObject({ busy: false, queue: { active: 1, waiting: 0 } });
    expect(await stream.next()).toMatchObject({ busy: false, queue: { active: 0, waiting: 0 } });
    await stream.close();
  });

  it('stops listening when the client goes away', async () => {
    const limiter = new ConcurrencyLimiter({ maxConcurrent: 1, maxQueue: 1, timeoutMs: 0 });
    let listeners = 0;
    const stream = await openStream({
      scan: async () => ({ items: [] }),
      status: () => limiter.status(),
      onStatusChange: (listener) => {
        listeners++;
        const stop = limiter.onStatusChange(listener);
        return () => {
          listeners--;
          stop();
        };
      },
    });
    await stream.next();
    expect(listeners).toBe(1);
    await stream.close();
    await tick();
    expect(listeners).toBe(0);
  });

  it('sends one not busy status for a scanner without a queue', async () => {
    const stream = await openStream({ scan: async () => ({ items: [] }) });
    expect(await stream.next()).toEqual({ status: 'ok', busy: false });
    await stream.close();
  });
});
