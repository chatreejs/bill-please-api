import { getLogger } from '../logger.ts';
import { ScannerBusyError } from './errors.ts';
import type { Extraction } from './extraction.ts';
import type { ReceiptExtractor } from './llm-client.ts';

const log = getLogger('scanner.queue');

export interface QueueOptions {
  /** Tasks allowed to run at the same time, at least 1 */
  maxConcurrent: number;
  /** Tasks allowed to wait for a free slot. More are rejected with ScannerBusyError */
  maxQueue: number;
  /** Longest wait for a slot in ms, 0 waits until the caller aborts */
  timeoutMs: number;
}

interface Waiter {
  start: () => void;
  fail: (error: unknown) => void;
}

/**
 * First in, first out limiter for one process. A task runs when one of the
 * maxConcurrent slots is free. Otherwise it waits behind the earlier tasks.
 */
export class ConcurrencyLimiter {
  private active = 0;
  private readonly waiting: Waiter[] = [];
  private readonly options: QueueOptions;

  constructor(options: QueueOptions) {
    this.options = { ...options, maxConcurrent: Math.max(1, options.maxConcurrent), maxQueue: Math.max(0, options.maxQueue) };
  }

  get stats() {
    return { active: this.active, waiting: this.waiting.length, maxConcurrent: this.options.maxConcurrent };
  }

  async run<T>(task: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    await this.acquire(signal);
    try {
      return await task();
    } finally {
      this.release();
    }
  }

  private acquire(signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    if (this.active < this.options.maxConcurrent && this.waiting.length === 0) {
      this.active++;
      return Promise.resolve();
    }
    if (this.waiting.length >= this.options.maxQueue) {
      log.warn(`Rejected a scan, ${this.waiting.length} scans are already waiting for the LLM`, { queue: this.stats });
      return Promise.reject(
        new ScannerBusyError(`${this.waiting.length} scans are already waiting for the LLM`, 'queue_full'),
      );
    }

    const position = this.waiting.length + 1;
    log.info(`Waiting for an LLM slot at position ${position}`, { queue: { ...this.stats, position } });
    const startedAt = performance.now();

    return new Promise<void>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const cleanup = () => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        const index = this.waiting.indexOf(waiter);
        if (index !== -1) this.waiting.splice(index, 1);
      };
      const waiter: Waiter = {
        start: () => {
          cleanup();
          this.active++;
          const waitMs = Math.round(performance.now() - startedAt);
          log.info(`Got an LLM slot after waiting ${waitMs}ms`, { queue: { ...this.stats, waitMs } });
          resolve();
        },
        fail: (error) => {
          cleanup();
          reject(error);
        },
      };
      const onAbort = () => {
        log.info('Scan left the LLM queue, because the client went away', { queue: this.stats });
        waiter.fail(signal!.reason);
      };

      this.waiting.push(waiter);
      signal?.addEventListener('abort', onAbort, { once: true });
      if (this.options.timeoutMs > 0) {
        timer = setTimeout(() => {
          log.warn(`Gave up after waiting ${this.options.timeoutMs}ms for an LLM slot`, { queue: this.stats });
          waiter.fail(
            new ScannerBusyError(`Waited ${this.options.timeoutMs}ms for an LLM slot`, 'queue_timeout'),
          );
        }, this.options.timeoutMs);
      }
    });
  }

  private release() {
    this.active--;
    this.waiting[0]?.start();
  }
}

/** Sends at most maxConcurrent extractions to the LLM server and queues the rest */
export class QueuedExtractor implements ReceiptExtractor {
  constructor(
    private readonly extractor: ReceiptExtractor,
    readonly limiter: ConcurrencyLimiter,
  ) {}

  extract(ocrText: string, signal?: AbortSignal): Promise<Extraction> {
    return this.limiter.run(() => this.extractor.extract(ocrText, signal), signal);
  }
}
