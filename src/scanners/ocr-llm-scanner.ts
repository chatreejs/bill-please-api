import { getLogger } from '../logger.ts';
import type { ReceiptScanResult } from '../schemas/receipt.ts';
import { UnreadableReceiptError } from './errors.ts';
import type { ReceiptImage, ReceiptScanner, ScannerStatus, ScanOptions, StatusListener } from './types.ts';
import type { ReceiptExtractor } from './llm-client.ts';
import { meanConfidence, type OcrClient } from './ocr-client.ts';
import { reconcile, resolveRates, toReceiptItems } from './postprocess.ts';
import type { ExtractionEvent } from './progress.ts';

const log = getLogger('scanner');

/**
 * Reads the receipt text with bill-please-ocr, then has an LLM turn the text into items.
 * Only the OCR text reaches the LLM, never the photo.
 */
export class OcrLlmReceiptScanner implements ReceiptScanner {
  constructor(
    private readonly ocr: OcrClient,
    private readonly extractor: ReceiptExtractor,
    private readonly minMeanConfidence: number,
  ) {}

  status(): ScannerStatus | undefined {
    return this.extractor.status?.();
  }

  onStatusChange(listener: StatusListener): () => void {
    return this.extractor.onStatusChange?.(listener) ?? (() => {});
  }

  async scan(image: ReceiptImage, { signal, onProgress }: ScanOptions = {}): Promise<ReceiptScanResult> {
    onProgress?.({ stage: 'ocr' });
    const ocr = await this.ocr.recognize(image, signal);
    // The client can cancel just as OCR returns. Then skip the LLM call
    signal?.throwIfAborted();
    const confidence = meanConfidence(ocr.lines);
    // Skip the LLM call, which costs 10 s or more, when there is nothing to read
    if (ocr.lines.length === 0 || confidence < this.minMeanConfidence) {
      throw new UnreadableReceiptError(
        `OCR found ${ocr.lines.length} lines with mean confidence ${confidence.toFixed(2)}`,
      );
    }

    const onEvent = (event: ExtractionEvent) => {
      if (event.type === 'queued') onProgress?.({ stage: 'queue', position: event.position });
      else onProgress?.({ stage: 'llm', items: event.type === 'item' ? event.count : 0 });
    };
    const raw = await this.extractor.extract(ocr.text, { signal, onEvent });
    const extraction = resolveRates(raw, ocr.text);
    if (extraction !== raw) {
      const { servicePercent, vatPercent, vatIncluded } = extraction;
      log.info(
        `Set servicePercent=${servicePercent} vatPercent=${vatPercent} vatIncluded=${vatIncluded}, ` +
          'because the model reading did not match the printed total',
        {
          rates: {
            model: { servicePercent: raw.servicePercent, vatPercent: raw.vatPercent, vatIncluded: raw.vatIncluded },
            resolved: { servicePercent, vatPercent, vatIncluded },
          },
        },
      );
    }
    const items = toReceiptItems(extraction);
    if (items.length === 0) {
      throw new UnreadableReceiptError('The LLM found no items in the receipt text');
    }

    const check = reconcile(items, extraction.total);
    const fields = { total: { items: items.length, ...check } };
    if (check.printedTotal === null) {
      log.warn(`Extracted ${items.length} items, total ${check.computedTotal}, but found no printed total to check`, fields);
    } else if (check.matches) {
      log.info(`Extracted ${items.length} items, total ${check.computedTotal} (printed ${check.printedTotal})`, fields);
    } else {
      log.warn(
        `Extracted ${items.length} items, but they add up to ${check.computedTotal} ` +
          `while the receipt says ${check.printedTotal}`,
        fields,
      );
    }
    return { items };
  }
}
