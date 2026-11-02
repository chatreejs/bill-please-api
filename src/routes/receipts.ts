import { Elysia, t } from 'elysia';

import type { Config } from '../config.ts';
import { getLogger } from '../logger.ts';
import { clientIp } from '../request-logger.ts';
import {
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

      try {
        log.info('Received receipt image', { image: { mimeType: image.type, bytes: image.size } });
        return await scanReceiptImage(
          scanner,
          { data: new Uint8Array(await image.arrayBuffer()), mimeType: image.type },
          request.signal,
        );
      } catch (error) {
        if (error instanceof UnreadableReceiptError) {
          log.warn(`Receipt unreadable: ${error.message}`);
          return status(422, { error: 'No receipt text found in the image' });
        }
        if (error instanceof ScannerBusyError) {
          set.headers['retry-after'] = String(RETRY_AFTER_SECONDS);
          return status(503, { error: 'The receipt scanner is busy, try again shortly' });
        }
        if (request.signal.aborted) {
          log.warn('Receipt scan stopped, because the client went away');
          return status(503, { error: 'Request aborted' });
        }
        log.error('Receipt scan failed', error);
        return status(502, { error: 'Could not read the receipt' });
      }
    },
    { body: t.Object({ image: t.File(), 'cf-turnstile-response': t.Optional(t.String()) }) },
  );
