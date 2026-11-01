import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { createApp } from '../src/app.ts';
import { createScanner, scanReceiptImage } from '../src/scanners/index.ts';
import { config } from '../src/config.ts';
import { configureLogger } from '../src/logger.ts';
import { UnreadableReceiptError } from '../src/scanners/errors.ts';
import type { Extraction } from '../src/scanners/extraction.ts';
import { extractionGrammar, extractionJsonSchema } from '../src/scanners/extraction.ts';
import { OcrLlmReceiptScanner } from '../src/scanners/ocr-llm-scanner.ts';
import { OpenAiCompatibleExtractor, type ReceiptExtractor } from '../src/scanners/llm-client.ts';
import type { OcrClient, OcrResult } from '../src/scanners/ocr-client.ts';
import { reconcile, resolveRates, toReceiptItems } from '../src/scanners/postprocess.ts';

let logs: string[] = [];
beforeEach(() => {
  logs = [];
  configureLogger({ level: 'INFO', write: (line) => logs.push(line) });
});

const RECEIPT_TEXT = [
  'ผัดไทยกุ้งสด                  2    240.00',
  'ส่วนลดสมาชิก                     -100.00',
  'ค่าบริการ 10%                      14.00',
  'ภาษีมูลค่าเพิ่ม 7%                    10.78',
  'รวมทั้งสิ้น                         164.78',
].join('\n');

const ocrResult = (text: string, confidence = 0.95): OcrResult => ({
  lines: text ? text.split('\n').map((line) => ({ text: line, confidence })) : [],
  text,
  width: 600,
  height: 800,
  durationMs: 1,
});

const extraction: Extraction = {
  items: [
    ['ผัดไทยกุ้งสด', 2, 240, 'food'],
    ['ส่วนลดสมาชิก', 1, -100, 'other'],
  ],
  servicePercent: 10,
  vatPercent: 7,
  vatIncluded: false,
  total: 164.78,
};

const stubOcr = (result: OcrResult): OcrClient => ({ recognize: async () => result });

class StubExtractor implements ReceiptExtractor {
  calls: string[] = [];
  constructor(private readonly result: Extraction) {}
  async extract(text: string) {
    this.calls.push(text);
    return this.result;
  }
}

const image = { data: new Uint8Array([1]), mimeType: 'image/jpeg' as const };

describe('toReceiptItems', () => {
  it('turns line amounts into unit prices and applies receipt rates to every item', () => {
    expect(toReceiptItems(extraction)).toEqual([
      { name: 'ผัดไทยกุ้งสด', quantity: 2, price: 120, servicePercentage: 10, vatPercentage: 7, category: 'food' },
      { name: 'ส่วนลดสมาชิก', quantity: 1, price: -100, servicePercentage: 10, vatPercentage: 7 },
    ]);
  });

  it('leaves out VAT when prices already include it', () => {
    const items = toReceiptItems({ ...extraction, servicePercent: 0, vatIncluded: true });
    expect(items[0]).toEqual({ name: 'ผัดไทยกุ้งสด', quantity: 2, price: 120, category: 'food' });
  });

  it('fixes fractional rates, empty names, zero amounts and bad quantities', () => {
    const items = toReceiptItems({
      items: [
        ['  Tea ', 0, 45, 'drink'],
        ['', 1, 10, 'food'],
        ['Free water', 1, 0, 'drink'],
        ['Coupon', 2, -50, 'other'],
        ['Rice', 3, 100, 'food'],
      ],
      servicePercent: 0.1,
      vatPercent: 0.07,
      vatIncluded: false,
      total: null,
    });
    expect(items).toEqual([
      { name: 'Tea', quantity: 1, price: 45, servicePercentage: 10, vatPercentage: 7, category: 'drink' },
      { name: 'Coupon', quantity: 1, price: -50, servicePercentage: 10, vatPercentage: 7 },
      { name: 'Rice', quantity: 3, price: 33.33, servicePercentage: 10, vatPercentage: 7, category: 'food' },
    ]);
  });

  it('moves a quantity column the model left in the name into the quantity', () => {
    const items = toReceiptItems({
      ...extraction,
      items: [
        ['4.00 F1.Water', 4, 120, 'drink'],
        ['2.00 I11.Squid', 1, 590, 'food'],
        ['2 Pad Thai', 2, 240, 'food'],
        ['3 Cheese Pizza', 1, 300, 'food'],
        ['ไข่มะตูม 1ฟอง', 1, 25, 'food'],
      ],
      servicePercent: 0,
      vatPercent: 0,
    });
    expect(items.map(({ name, quantity, price }) => [name, quantity, price])).toEqual([
      ['F1.Water', 4, 30],
      ['I11.Squid', 2, 295],
      ['Pad Thai', 2, 120],
      ['3 Cheese Pizza', 1, 300],
      ['ไข่มะตูม 1ฟอง', 1, 25],
    ]);
  });
});

describe('reconcile', () => {
  it('prices items like the web and compares with the printed total', () => {
    const items = toReceiptItems(extraction);
    expect(reconcile(items, 164.78)).toEqual({ computedTotal: 164.78, printedTotal: 164.78, matches: true });
    expect(reconcile(items, 200).matches).toBe(false);
    expect(reconcile(items, null).matches).toBe(false);
  });
});

describe('resolveRates', () => {
  // bill-4: ราคารวม 315.89, VAT 7% 22.11, ราคารวมสุทธิ 338.00, items 129 + 209
  const bill4Text = 'ราคารวม: 315.89\nVAT 7% 22.11\nราคารวมสุทธิ: 338.00';
  const vatInPrices: Extraction = {
    items: [
      ['สเต๊กไก่ซอสแจ่วปลาร้า (P)', 1, 129, 'food'],
      ['สเต๊กไก่สไปซี่', 1, 209, 'food'],
    ],
    servicePercent: 0,
    vatPercent: 7,
    vatIncluded: false,
    total: 338,
  };

  it('treats VAT as included when only that matches the printed total', () => {
    const resolved = resolveRates(vatInPrices, bill4Text);
    expect(resolved.vatIncluded).toBe(true);
    expect(toReceiptItems(resolved)[0]).toEqual({
      name: 'สเต๊กไก่ซอสแจ่วปลาร้า (P)',
      quantity: 1,
      price: 129,
      category: 'food',
    });
  });

  it('treats VAT as added when only that matches the printed total', () => {
    expect(resolveRates({ ...extraction, vatIncluded: true }, RECEIPT_TEXT).vatIncluded).toBe(false);
  });

  it('uses a tax rate printed in the OCR text when the model returns none', () => {
    // bill-2: SUBTOTAL $103.35, TAX 6% $6.20, TOTAL $109.55
    const bill2: Extraction = {
      items: [
        ['Pasta with cheese', 2, 71, 'food'],
        ['Chicken Pitzza', 1, 24.55, 'food'],
        ['Drinks', 4, 7.8, 'drink'],
      ],
      servicePercent: 0,
      vatPercent: 0,
      vatIncluded: false,
      total: 109.55,
    };
    const text = 'SUBTOTAL                $103.35\nTAX 6%                   $6.20\nTOTAL                   $109.55';
    expect(resolveRates(bill2, text)).toMatchObject({ vatPercent: 6, vatIncluded: false });
    expect(resolveRates({ ...bill2, vatPercent: 0 }, 'TOTAL $109.55')).toMatchObject({ vatPercent: 0 });
  });

  it('finds a service charge printed in Thai or English', () => {
    const noRates = { ...extraction, servicePercent: 0, vatPercent: 0 };
    expect(resolveRates(noRates, RECEIPT_TEXT)).toMatchObject({ servicePercent: 10, vatPercent: 7 });
    expect(resolveRates(noRates, 'Service Charge 10%\nVAT 7%')).toMatchObject({ servicePercent: 10, vatPercent: 7 });
  });

  it('keeps the model reading when it matches, or when nothing does', () => {
    expect(resolveRates(extraction, RECEIPT_TEXT)).toBe(extraction);
    const wrong = { ...vatInPrices, total: 500 };
    expect(resolveRates(wrong, bill4Text)).toBe(wrong);
    const noTotal = { ...vatInPrices, total: null };
    expect(resolveRates(noTotal, bill4Text)).toBe(noTotal);
  });
});

describe('extraction JSON schema', () => {
  it('has no boolean subschemas, which llama.cpp rejects', () => {
    expect(JSON.stringify(extractionJsonSchema)).not.toContain('"items":false');
  });

  it('limits the category to the contract values in both output formats', () => {
    expect(JSON.stringify(extractionJsonSchema)).toContain('"enum":["food","drink","alcohol","dessert","other"]');
    expect(extractionGrammar).toContain('category ::= "\\"food\\"" | "\\"drink\\""');
  });
});

describe('OpenAiCompatibleExtractor', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  // Answers like llama-server and keeps the request body
  const captureRequest = () => {
    const bodies: Record<string, unknown>[] = [];
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)));
      return Response.json({ choices: [{ message: { content: JSON.stringify(extraction) }, finish_reason: 'stop' }] });
    }) as unknown as typeof fetch;
    return bodies;
  };

  it('sends the compact grammar and reasoning_effort to llama.cpp', async () => {
    const bodies = captureRequest();
    const extractor = new OpenAiCompatibleExtractor('http://llm/v1', 'm', 1000, {
      reasoningEffort: 'none',
      outputFormat: 'gbnf',
    });
    expect(await extractor.extract(RECEIPT_TEXT)).toEqual(extraction);
    expect(bodies[0]).toMatchObject({ grammar: extractionGrammar, reasoning_effort: 'none' });
    expect(bodies[0]).not.toHaveProperty('response_format');
  });

  it('sends the JSON schema, and no reasoning_effort when it is empty', async () => {
    const bodies = captureRequest();
    const extractor = new OpenAiCompatibleExtractor('http://llm/v1', 'm', 1000, {
      reasoningEffort: '',
      outputFormat: 'json_schema',
    });
    await extractor.extract(RECEIPT_TEXT);
    expect(bodies[0]).toMatchObject({ response_format: { type: 'json_schema' } });
    expect(bodies[0]).not.toHaveProperty('grammar');
    expect(bodies[0]).not.toHaveProperty('reasoning_effort');
  });
});

describe('scan step logs', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it('logs each step of a scan with its fields', async () => {
    globalThis.fetch = (async (url: string) =>
      String(url).endsWith('/v1/ocr')
        ? Response.json({ ...ocrResult(RECEIPT_TEXT), durationMs: 5 })
        : Response.json({
            choices: [{ message: { content: JSON.stringify(extraction) }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 700, completion_tokens: 40 },
          })) as unknown as typeof fetch;

    await scanReceiptImage(createScanner(config), image);
    const records = logs.map((line) => JSON.parse(line));
    expect(records.map((r) => r.msg.split(/ \d| with| in /)[0])).toEqual([
      'Calling OCR',
      'OCR complete',
      `Calling LLM ${config.llmModel}`,
      'LLM complete',
      'Extracted',
      'Scan complete',
    ]);
    expect(records[1].ocr).toMatchObject({ lines: 5, meanConfidence: 0.95, durationMs: 5 });
    expect(records[3].llm).toMatchObject({ promptTokens: 700, completionTokens: 40, finishReason: 'stop' });
    expect(records[4].total).toMatchObject({ items: 2, computedTotal: 164.78, matches: true });
    expect(records[5].scan).toMatchObject({ items: 2 });
  });
});

describe('OcrLlmReceiptScanner', () => {
  it('sends the OCR text to the extractor and returns contract items', async () => {
    const extractor = new StubExtractor(extraction);
    const scanner = new OcrLlmReceiptScanner(stubOcr(ocrResult(RECEIPT_TEXT)), extractor, 0.6);

    const result = await scanner.scan(image);
    expect(extractor.calls).toEqual([RECEIPT_TEXT]);
    expect(result.items).toHaveLength(2);
    expect(logs.some((line) => line.includes('total 164.78 (printed 164.78)'))).toBe(true);
  });

  it('warns when the items do not add up to the printed total', async () => {
    const scanner = new OcrLlmReceiptScanner(
      stubOcr(ocrResult(RECEIPT_TEXT)),
      new StubExtractor({ ...extraction, total: 999 }),
      0.6,
    );
    await scanner.scan(image);
    expect(logs.find((line) => line.includes('the receipt says 999'))).toContain('"level":"warn"');
  });

  it('fixes the rates from the printed total and warns when there is none', async () => {
    const fixed = new OcrLlmReceiptScanner(
      stubOcr(ocrResult(RECEIPT_TEXT)),
      new StubExtractor({ ...extraction, vatIncluded: true }),
      0.6,
    );
    expect((await fixed.scan(image)).items[0]!.vatPercentage).toBe(7);
    expect(logs.some((line) => line.includes('vatPercent=7 vatIncluded=false'))).toBe(true);

    const unchecked = new OcrLlmReceiptScanner(
      stubOcr(ocrResult(RECEIPT_TEXT)),
      new StubExtractor({ ...extraction, total: null }),
      0.6,
    );
    await unchecked.scan(image);
    expect(logs.find((line) => line.includes('found no printed total'))).toContain('"level":"warn"');
  });

  it('skips the LLM when OCR finds nothing or is unsure', async () => {
    for (const ocr of [ocrResult(''), ocrResult(RECEIPT_TEXT, 0.3)]) {
      const extractor = new StubExtractor(extraction);
      const scanner = new OcrLlmReceiptScanner(stubOcr(ocr), extractor, 0.6);
      await expect(scanner.scan(image)).rejects.toBeInstanceOf(UnreadableReceiptError);
      expect(extractor.calls).toHaveLength(0);
    }
  });

  it('is unreadable when the LLM finds no items', async () => {
    const scanner = new OcrLlmReceiptScanner(
      stubOcr(ocrResult(RECEIPT_TEXT)),
      new StubExtractor({ ...extraction, items: [] }),
      0.6,
    );
    await expect(scanner.scan(image)).rejects.toBeInstanceOf(UnreadableReceiptError);
  });

  it('answers 422 on REST and a friendly tool error on MCP', async () => {
    const app = createApp(
      { ...config, rateLimitPerMinute: 1000, turnstileSecretKey: undefined },
      new OcrLlmReceiptScanner(stubOcr(ocrResult('')), new StubExtractor(extraction), 0.6),
    );
    const form = new FormData();
    form.append('image', new File([new Uint8Array([1])], 'bill.jpg', { type: 'image/jpeg' }));
    const res = await app.handle(
      new Request('http://localhost/api/receipts/scan', { method: 'POST', body: form }),
    );
    expect(res.status).toBe(422);

    const mcp = await app.handle(
      new Request('http://localhost/mcp', {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name: 'scan_receipt', arguments: { imageBase64: 'AQ==', mimeType: 'image/jpeg' } },
        }),
      }),
    );
    const body = (await mcp.json()) as { result: { isError: boolean; content: { text: string }[] } };
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0]!.text).toContain('No receipt text found');
  });
});
