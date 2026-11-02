import { Elysia, t } from 'elysia';

import type { Config } from '../config.ts';
import { getLogger } from '../logger.ts';
import { clientIp } from '../request-logger.ts';
import {
  type ReceiptImage,
  type ReceiptScanner,
  ScannerBusyError,
  scanReceiptImage,
  UnreadableReceiptError,
} from '../scanners/index.ts';
import { SUPPORTED_IMAGE_TYPES, type SupportedImageType } from '../schemas/receipt.ts';
import { RECEIPT_SCAN_ACTION, type TurnstileVerifier } from '../turnstile.ts';

const log = getLogger('receipts.route');

// One scan takes about this long on the T400
const RETRY_AFTER_SECONDS = 15;

// The LLM can read the prompt for 12 s without output. A ping every 5 s keeps proxies
// from closing the stream as idle
const HEARTBEAT_MS = 5000;

interface ScanFailure {
  status: 422 | 502 | 503;
  body: { error: string; code?: 'scanner_busy' };
}

/** The status and body for a failed scan, the same for JSON and SSE */
const scanFailure = (error: unknown, signal: AbortSignal): ScanFailure => {
  if (error instanceof UnreadableReceiptError) {
    log.warn(`Receipt unreadable: ${error.message}`);
    return { status: 422, body: { error: 'No receipt text found in the image' } };
  }
  if (error instanceof ScannerBusyError) {
    // The code field tells this 503 apart from the Turnstile 503. The web can't read Retry-After cross-origin
    return { status: 503, body: { error: 'The receipt scanner is busy, try again shortly', code: 'scanner_busy' } };
  }
  if (signal.aborted) {
    log.warn('Receipt scan stopped, because the client went away');
    return { status: 503, body: { error: 'Request aborted' } };
  }
  log.error('Receipt scan failed', error);
  return { status: 502, body: { error: 'Could not read the receipt' } };
};

/**
 * Answers 200 with Server-Sent Events: `progress` with a ScanProgress for each step, then
 * one `result` with the items or one `error` with the status and body the JSON answer would have.
 */
const streamScan = (
  scanner: ReceiptScanner,
  image: ReceiptImage,
  requestSignal: AbortSignal,
  headers: Record<string, unknown>,
) => {
  const encoder = new TextEncoder();
  const cancelled = new AbortController();
  const signal = AbortSignal.any([requestSignal, cancelled.signal]);
  const startedAt = performance.now();
  let closed = false;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const write = (text: string) => {
        if (!closed) controller.enqueue(encoder.encode(text));
      };
      const send = (event: string, data: unknown) => write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      const heartbeat = setInterval(() => write(': ping\n\n'), HEARTBEAT_MS);

      scanReceiptImage(scanner, image, { signal, onProgress: (progress) => send('progress', progress) })
        .then((result) => {
          send('result', result);
          return 200;
        })
        .catch((error: unknown) => {
          const { status, body } = scanFailure(error, signal);
          send('error', { status, ...body });
          return status;
        })
        .then((status) => {
          // The access log writes a stream when its first byte goes out, so log the real status here
          const elapsedMs = Math.round(performance.now() - startedAt);
          log.info(`Closed the scan stream with status ${status} after ${elapsedMs}ms`, {
            stream: { status, elapsedMs },
          });
        })
        .finally(() => {
          clearInterval(heartbeat);
          if (closed) return;
          closed = true;
          controller.close();
        });
    },
    cancel() {
      closed = true;
      cancelled.abort(new Error('The client closed the scan stream'));
    },
  });

  return new Response(stream, {
    headers: {
      ...(headers as Record<string, string>),
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
    },
  });
};

const isSupportedImageType = (type: string): type is SupportedImageType =>
  (SUPPORTED_IMAGE_TYPES as readonly string[]).includes(type);

/** REST endpoint used by bill-please web */
export const receiptRoutes = (
  config: Config,
  scanner: ReceiptScanner,
  verifyTurnstile?: TurnstileVerifier,
) =>
  new Elysia({ prefix: '/api/receipts' })
    // bill-please web polls this every few seconds and disables "Add from bill" while busy
    .get('/status', () => {
      const status = scanner.status?.();
      return { status: 'ok' as const, busy: status?.busy ?? false, ...(status ? { queue: status.queue } : {}) };
    })
    .post(
    '/scan',
    async ({ body, status, request, server, set }) => {
      const { image } = body;
      // Check Turnstile first, so a bot never reaches the paid OCR and LLM steps
      if (verifyTurnstile) {
        const outcome = await verifyTurnstile(
          body['cf-turnstile-response'],
          clientIp(request, server, config.trustProxy),
          RECEIPT_SCAN_ACTION,
        );
        if (!outcome.ok) {
          log.warn(`Turnstile check failed: ${outcome.reason}`);
          return outcome.status === 503
            ? status(503, { error: 'Could not verify the Turnstile challenge' })
            : status(403, { error: 'Turnstile verification failed' });
        }
      }

      if (!isSupportedImageType(image.type)) {
        log.warn(`Rejected unsupported image type "${image.type}"`);
        return status(415, { error: `Unsupported image type "${image.type}"` });
      }
      if (image.size > config.maxImageBytes) {
        log.warn(`Rejected image of ${image.size} bytes (max ${config.maxImageBytes})`);
        return status(413, { error: `Image larger than ${config.maxImageBytes} bytes` });
      }

      log.info('Received receipt image', { image: { mimeType: image.type, bytes: image.size } });
      const receipt = { data: new Uint8Array(await image.arrayBuffer()), mimeType: image.type };

      // bill-please web asks for SSE to show each step of the scan. Other clients get one JSON body
      if (request.headers.get('accept')?.includes('text/event-stream')) {
        return streamScan(scanner, receipt, request.signal, set.headers);
      }
      try {
        return await scanReceiptImage(scanner, receipt, { signal: request.signal });
      } catch (error) {
        const failure = scanFailure(error, request.signal);
        if (failure.status === 503 && failure.body.code === 'scanner_busy') {
          set.headers['retry-after'] = String(RETRY_AFTER_SECONDS);
        }
        return status(failure.status, failure.body);
      }
    },
    { body: t.Object({ image: t.File(), 'cf-turnstile-response': t.Optional(t.String()) }) },
  );
