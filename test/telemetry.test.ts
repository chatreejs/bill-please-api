import { context, trace } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test';

import { scanReceiptImage, type ReceiptScanner } from '../src/scanners/index.ts';
import { OpenAiCompatibleExtractor } from '../src/scanners/llm-client.ts';

const exporter = new InMemorySpanExporter();
const image = { data: new Uint8Array([1, 2, 3]), mimeType: 'image/jpeg' as const };
const realFetch = globalThis.fetch;

beforeAll(() => {
  context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
  trace.setGlobalTracerProvider(new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] }));
});
afterEach(() => {
  exporter.reset();
  globalThis.fetch = realFetch;
});
afterAll(() => {
  trace.disable();
  context.disable();
});

describe('receipt.scan span', () => {
  it('covers the whole scan and records the item count', async () => {
    const scanner = {
      scan: async () => {
        await trace.getTracer('test').startActiveSpan('step', async (span) => span.end());
        return { items: [{ name: 'Tea', quantity: 1, price: 40 }] };
      },
    } as unknown as ReceiptScanner;

    await scanReceiptImage(scanner, image);

    const spans = exporter.getFinishedSpans();
    const scan = spans.find((s) => s.name === 'receipt.scan');
    expect(scan?.attributes).toMatchObject({ 'receipt.mime_type': 'image/jpeg', 'receipt.bytes': 3, 'receipt.items': 1 });
    expect(spans.find((s) => s.name === 'step')?.parentSpanContext?.spanId).toBe(scan?.spanContext().spanId);
  });

  it('is marked failed when the scan throws', async () => {
    const scanner = { scan: async () => Promise.reject(new Error('ocr down')) } as unknown as ReceiptScanner;

    await expect(scanReceiptImage(scanner, image)).rejects.toThrow('ocr down');
    expect(exporter.getFinishedSpans()[0]?.status.message).toBe('ocr down');
  });
});

describe('LLM span', () => {
  it('names llm-server as the peer service', async () => {
    globalThis.fetch = (async () => new Response('', { status: 500 })) as unknown as typeof fetch;

    await new OpenAiCompatibleExtractor('http://llm', 'qwen', 1000).extract('text').catch(() => {});
    expect(exporter.getFinishedSpans()[0]?.attributes['peer.service']).toBe('llm-server');
  });
});
