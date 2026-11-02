import type { ReceiptScanResult, SupportedImageType } from '../schemas/receipt.ts';
import type { ProgressListener } from './progress.ts';

export interface ReceiptImage {
  data: Uint8Array;
  mimeType: SupportedImageType;
}

/** How busy the scanner is, for GET /api/receipts/status */
export interface ScannerStatus {
  /** A new scan would be rejected right now, because the LLM queue is full */
  busy: boolean;
  queue: { active: number; waiting: number; maxConcurrent: number; maxQueue: number };
}

export interface ScanOptions {
  /** Aborts the scan, including its place in the LLM queue, when the client goes away */
  signal?: AbortSignal;
  /** Gets each step of the scan */
  onProgress?: ProgressListener;
}

/** Turns a receipt image into structured bill items (OCR / VLM backend) */
export interface ReceiptScanner {
  scan(image: ReceiptImage, options?: ScanOptions): Promise<ReceiptScanResult>;
  /** Queue state, undefined when the scanner has no queue */
  status?(): ScannerStatus | undefined;
}
