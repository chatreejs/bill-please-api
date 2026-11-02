import { getLogger } from '../logger.ts';
import { ScannerBusyError } from './errors.ts';
import type { Extraction } from './extraction.ts';
import type { ExtractOptions, ReceiptExtractor } from './llm-client.ts';
import type { ScannerStatus, StatusListener } from './types.ts';

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
  private readonly listeners = new Set<StatusListener>();

  constructor(options: QueueOptions) {
    this.options = { ...options, maxConcurrent: Math.max(1, options.maxConcurrent), maxQueue: Math.max(0, options.maxQueue) };
  }

  get stats() {
    return { active: this.active, waiting: this.waiting.length, maxConcurrent: this.options.maxConcurrent };
  }

  /** busy is true when a new task would be rejected now, because every slot and queue place is taken */
  status(): ScannerStatus {
    const { maxConcurrent, maxQueue } = this.options;
    return {
      busy: this.active >= maxConcurrent && this.waiting.length >= maxQueue,
      queue: { active: this.active, waiting: this.waiting.length, maxConcurrent, maxQueue },
    };
  }

  /** Calls listener with the new status each time a task starts, queues, leaves the queue or finishes */
  onStatusChange(listener: StatusListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify() {
    if (this.listeners.size === 0) return;
    const status = this.status();
    for (const listener of this.listeners) {
      try {
        listener(status);
      } catch (error) {
        log.error('A queue status listener failed', error);
      }
    }
  }

  /** onQueued gets the task's position when it has to wait. Position 1 is next */
  async run<T>(task: () => Promise<T>, signal?: AbortSignal, onQueued?: (position: number) => void): Promise<T> {
    await this.acquire(signal, onQueued);
    try {
      return await task();
    } finally {
      this.release();
    }
  }

  private acquire(signal?: AbortSignal, onQueued?: (position: number) => void): Promise<void> {
    signal?.throwIfAborted();
    if (this.active < this.options.maxConcurrent && this.waiting.length === 0) {
      this.active++;
      this.notify();
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
    onQueued?.(position);

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
          this.notify();
          resolve();
        },
        fail: (error) => {
          cleanup();
          this.notify();
          reject(error);
        },
      };
      const onAbort = () => {
        log.info('Scan left the LLM queue, because the client went away', { queue: this.stats });
        waiter.fail(signal!.reason);
      };

      this.waiting.push(waiter);
      this.notify();
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
    // start() notifies when a waiting task takes the slot
    if (this.waiting.length > 0) this.waiting[0]!.start();
    else this.notify();
  }
}

/** Sends at most maxConcurrent extractions to the LLM server and queues the rest */
export class QueuedExtractor implements ReceiptExtractor {
  constructor(
    private readonly extractor: ReceiptExtractor,
    readonly limiter: ConcurrencyLimiter,
  ) {}

  status(): ScannerStatus {
    return this.limiter.status();
  }

  onStatusChange(listener: StatusListener): () => void {
    return this.limiter.onStatusChange(listener);
  }

  extract(ocrText: string, options: ExtractOptions = {}): Promise<Extraction> {
    return this.limiter.run(
      () => this.extractor.extract(ocrText, options),
      options.signal,
      (position) => options.onEvent?.({ type: 'queued', position }),
    );
  }
}
