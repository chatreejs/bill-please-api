import type { ReceiptScanResult, SupportedImageType } from '../schemas/receipt.ts';

export interface ReceiptImage {
  data: Uint8Array;
  mimeType: SupportedImageType;
}

/** Turns a receipt image into structured bill items (OCR / VLM backend) */
export interface ReceiptScanner {
  /** signal aborts the scan, including its place in the LLM queue, when the client goes away */
  scan(image: ReceiptImage, signal?: AbortSignal): Promise<ReceiptScanResult>;
}
