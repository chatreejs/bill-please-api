import type { Config } from '../config.ts';
import { getLogger } from '../logger.ts';
import { withSpan } from '../telemetry.ts';
import {
  ReceiptScanResultSchema,
  type ReceiptScanResult,
} from '../schemas/receipt.ts';
import { OcrLlmReceiptScanner } from './ocr-llm-scanner.ts';
import { OpenAiCompatibleExtractor } from './llm-client.ts';
import { ConcurrencyLimiter, QueuedExtractor } from './llm-queue.ts';
import { HttpOcrClient } from './ocr-client.ts';
import type { ReceiptImage, ReceiptScanner, ScanOptions } from './types.ts';

const log = getLogger('scanner');

export { ScannerBusyError, UnreadableReceiptError } from './errors.ts';
export type { ScanProgress } from './progress.ts';
export type { ReceiptImage, ReceiptScanner, ScannerStatus, ScanOptions, StatusListener } from './types.ts';

export const createScanner = (config: Config): ReceiptScanner =>
  new OcrLlmReceiptScanner(
    new HttpOcrClient(config.ocrUrl, config.ocrTimeoutMs),
    // The llm-server runs llama.cpp with --parallel 1 and handles one scan at a time, so later scans wait
    new QueuedExtractor(
      new OpenAiCompatibleExtractor(config.llmUrl, config.llmModel, config.llmTimeoutMs, {
        apiKey: config.llmApiKey,
        reasoningEffort: config.llmReasoningEffort,
        outputFormat: config.llmOutputFormat,
      }),
      new ConcurrencyLimiter({
        maxConcurrent: config.llmMaxConcurrent,
        maxQueue: config.llmQueueMax,
        timeoutMs: config.llmQueueTimeoutMs,
      }),
    ),
    config.ocrMinConfidence,
  );

/**
 * Scan an image and validate the scanner output against the shared contract,
 * so a misbehaving AI model can never send malformed items to clients.
 */
export const scanReceiptImage = (
  scanner: ReceiptScanner,
  image: ReceiptImage,
  options?: ScanOptions,
): Promise<ReceiptScanResult> =>
  // The request span ends when the response starts, but a streamed scan keeps running.
  // This span lasts until the scan finishes, so its duration is how long the visitor waits
  withSpan(
    'receipt.scan',
    { attributes: { 'receipt.mime_type': image.mimeType, 'receipt.bytes': image.data.byteLength } },
    async (span) => {
      const startedAt = performance.now();
      const result = ReceiptScanResultSchema.parse(await scanner.scan(image, options));
      const elapsedMs = Math.round(performance.now() - startedAt);
      span.setAttribute('receipt.items', result.items.length);
      log.info(`Scan complete with ${result.items.length} items in ${elapsedMs}ms`, {
        scan: { items: result.items.length, elapsedMs },
      });
      return result;
    },
  );
