import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { createApp } from '../src/app.ts';
import { config } from '../src/config.ts';
import { configureLogger } from '../src/logger.ts';
import { ScannerBusyError, UnreadableReceiptError } from '../src/scanners/errors.ts';
import type { Extraction } from '../src/scanners/extraction.ts';
import { OpenAiCompatibleExtractor } from '../src/scanners/llm-client.ts';
import { ConcurrencyLimiter, QueuedExtractor } from '../src/scanners/llm-queue.ts';
import { OcrLlmReceiptScanner } from '../src/scanners/ocr-llm-scanner.ts';
import { type ExtractionEvent, ItemCounter } from '../src/scanners/progress.ts';
import type { ReceiptScanner } from '../src/scanners/index.ts';

beforeEach(() => configureLogger({ level: 'OFF', write: () => {} }));

const testConfig = { ...config, rateLimitPerMinute: 1000, turnstileSecretKey: undefined };
const png = new File([new Uint8Array([137, 80, 78, 71])], 'bill.png', { type: 'image/png' });
const image = { data: new Uint8Array([1]), mimeType: 'image/jpeg' as const };

const extraction: Extraction = {
  items: [
    ['Tea [hot]', 2, 90, 'drink'],
    ['Rice', 1, 20, 'food'],
  ],
  servicePercent: 0,
  vatPercent: 0,
  vatIncluded: false,
  total: 110,
};

describe('ItemCounter', () => {
  it('counts each finished item across chunks, and skips brackets inside names', () => {
    const counter = new ItemCounter();
    const output = JSON.stringify(extraction);
    const counts = [];
    for (let i = 0; i < output.length; i += 7) {
      counter.push(output.slice(i, i + 7));
      counts.push(counter.count);
    }
    expect(counter.count).toBe(2);
    expect(counts).toContain(1);
  });

  it('counts indented json_schema output too', () => {
    const counter = new ItemCounter();
    counter.push(JSON.stringify({ ...extraction, items: [['a "[x]" \\ b', 1, 1, 'food']] }, null, 2));
    expect(counter.count).toBe(1);
  });
});

/** An SSE chat completion like llama-server sends with stream: true */
const sseCompletion = (content: string, chunkSize: number) => {
  const chunks: string[] = [];
  for (let i = 0; i < content.length; i += chunkSize) {
    chunks.push(`data: ${JSON.stringify({ choices: [{ delta: { content: content.slice(i, i + chunkSize) } }] })}\n\n`);
  }
  chunks.push(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`);
  chunks.push(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 700, completion_tokens: 40 } })}\n\n`);
  chunks.push('data: [DONE]\n\n');
  const encoder = new TextEncoder();
  // Split the bytes away from event boundaries, as the network can
  const bytes = encoder.encode(chunks.join(''));
  return new Response(
    new ReadableStream({
      start(controller) {
        for (let i = 0; i < bytes.length; i += 50) controller.enqueue(bytes.slice(i, i + 50));
        controller.close();
      },
    }),
    { headers: { 'content-type': 'text/event-stream' } },
  );
};

describe('OpenAiCompatibleExtractor streaming', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it('asks for a stream, reports each item, and parses the output', async () => {
    const bodies: Record<string, unknown>[] = [];
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)));
      return sseCompletion(JSON.stringify(extraction), 5);
    }) as unknown as typeof fetch;

    const events: ExtractionEvent[] = [];
    const extractor = new OpenAiCompatibleExtractor('http://llm/v1', 'm', 1000, { outputFormat: 'gbnf' });
    expect(await extractor.extract('text', { onEvent: (event) => events.push(event) })).toEqual(extraction);
    expect(bodies[0]).toMatchObject({ stream: true, stream_options: { include_usage: true } });
    expect(events).toEqual([
      { type: 'started' },
      { type: 'item', count: 1 },
      { type: 'item', count: 2 },
    ]);
  });

  it('fails when the stream stops at max_tokens', async () => {
    globalThis.fetch = (async () => {
      const res = sseCompletion('{"items":[["Tea"', 5);
      const text = (await res.text()).replace('"stop"', '"length"');
      return new Response(text, { headers: { 'content-type': 'text/event-stream' } });
    }) as unknown as typeof fetch;
    const extractor = new OpenAiCompatibleExtractor('http://llm/v1', 'm', 1000);
    await expect(extractor.extract('text')).rejects.toThrow('max_tokens');
  });
});

describe('progress through the scanner', () => {
  it('reports OCR, the queue position and the LLM steps', async () => {
    const limiter = new ConcurrencyLimiter({ maxConcurrent: 1, maxQueue: 1, timeoutMs: 0 });
    let release!: () => void;
    const blocker = limiter.run(() => new Promise<void>((resolve) => (release = resolve)));
    const inner = {
      async extract(_text: string, options: { onEvent?: (event: ExtractionEvent) => void } = {}) {
        options.onEvent?.({ type: 'started' });
        options.onEvent?.({ type: 'item', count: 1 });
        return extraction;
      },
    };
    const scanner = new OcrLlmReceiptScanner(
      { recognize: async () => ({ lines: [{ text: 'Tea 90.00', confidence: 0.9 }], text: 'Tea 90.00', width: 1, height: 1, durationMs: 1 }) },
      new QueuedExtractor(inner, limiter),
      0.5,
    );

    const stages: string[] = [];
    const scan = scanner.scan(image, { onProgress: (p) => stages.push(`${p.stage}:${p.position ?? p.items ?? ''}`) });
    await Bun.sleep(1);
    expect(stages).toEqual(['ocr:', 'queue:1']);
    release();
    await blocker;
    await scan;
    expect(stages).toEqual(['ocr:', 'queue:1', 'llm:0', 'llm:1']);
  });
});

/** Parses an SSE body into its events */
const readEvents = async (res: Response) =>
  (await res.text())
    .split('\n\n')
    .filter((block) => block.startsWith('event:'))
    .map((block) => {
      const [eventLine, dataLine] = block.split('\n');
      return { event: eventLine!.slice(7), data: JSON.parse(dataLine!.slice(6)) };
    });

const streamScan = (scanner: ReceiptScanner) => {
  const form = new FormData();
  form.append('image', png);
  return createApp(testConfig, scanner).handle(
    new Request('http://localhost/api/receipts/scan', {
      method: 'POST',
      headers: { accept: 'text/event-stream' },
      body: form,
    }),
  );
};

describe('POST /api/receipts/scan with Accept: text/event-stream', () => {
  const items = [{ name: 'Tea', quantity: 1, price: 90 }];

  it('streams progress events, then the result', async () => {
    const res = await streamScan({
      scan: async (_image, options) => {
        options?.onProgress?.({ stage: 'ocr' });
        options?.onProgress?.({ stage: 'llm', items: 1 });
        return { items };
      },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/event-stream');
    expect(res.headers.get('x-request-id')).toBeTruthy();
    expect(await readEvents(res)).toEqual([
      { event: 'progress', data: { stage: 'ocr' } },
      { event: 'progress', data: { stage: 'llm', items: 1 } },
      { event: 'result', data: { items } },
    ]);
  });

  it('sends a failure as an error event with the status the JSON answer would have', async () => {
    const busy = await streamScan({
      scan: async () => Promise.reject(new ScannerBusyError('full', 'queue_full')),
    });
    expect(await readEvents(busy)).toEqual([
      {
        event: 'error',
        data: { status: 503, code: 'scanner_busy', error: 'The receipt scanner is busy, try again shortly' },
      },
    ]);

    const unreadable = await streamScan({
      scan: async () => Promise.reject(new UnreadableReceiptError('no text')),
    });
    expect((await readEvents(unreadable))[0]).toMatchObject({ event: 'error', data: { status: 422 } });

    const broken = await streamScan({ scan: async () => ({ items: [{ name: '', quantity: 0, price: 1 }] }) });
    expect((await readEvents(broken))[0]).toMatchObject({ event: 'error', data: { status: 502 } });
  });

  it('aborts the scan when the client cancels the stream', async () => {
    let aborted = false;
    const res = await streamScan({
      scan: (_image, options) =>
        new Promise((_resolve, reject) => {
          options?.signal?.addEventListener('abort', () => {
            aborted = true;
            reject(options.signal!.reason);
          });
        }),
    });
    await res.body!.cancel();
    await Bun.sleep(1);
    expect(aborted).toBe(true);
  });
});
