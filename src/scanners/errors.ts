/**
 * The image was fine but held no usable receipt text, for example a blurry photo
 * or a picture of something else. The REST route answers 422 instead of 502.
 */
export class UnreadableReceiptError extends Error {
  override name = 'UnreadableReceiptError';
}

/**
 * Too many scans are already waiting for the LLM, or this one waited longer than
 * LLM_QUEUE_TIMEOUT_MS. The REST route answers 503 with Retry-After.
 */
export class ScannerBusyError extends Error {
  override name = 'ScannerBusyError';
  constructor(
    message: string,
    readonly reason: 'queue_full' | 'queue_timeout',
  ) {
    super(message);
  }
}
