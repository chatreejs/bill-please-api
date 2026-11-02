/** One step of a scan, as POST /api/receipts/scan streams it to bill-please web */
export type ScanStage = 'ocr' | 'queue' | 'llm';

export interface ScanProgress {
  stage: ScanStage;
  /** Place in the LLM queue while stage is queue. 1 is next */
  position?: number;
  /** Items the LLM has written so far while stage is llm */
  items?: number;
}

export type ProgressListener = (progress: ScanProgress) => void;

/** Events the extractor sends during a call */
export type ExtractionEvent =
  | { type: 'queued'; position: number }
  | { type: 'started' }
  | { type: 'item'; count: number };

/**
 * Counts finished items in the LLM output as it streams in. `items` is the first key, so every
 * `]` that closes a 3rd-level array ends an item. It tracks strings, because names can hold brackets.
 */
export class ItemCounter {
  count = 0;
  private depth = 0;
  private inString = false;
  private escaped = false;

  /** Returns true when the chunk finished at least one item */
  push(chunk: string): boolean {
    const before = this.count;
    for (const char of chunk) {
      if (this.inString) {
        if (this.escaped) this.escaped = false;
        else if (char === '\\') this.escaped = true;
        else if (char === '"') this.inString = false;
      } else if (char === '"') {
        this.inString = true;
      } else if (char === '{' || char === '[') {
        this.depth++;
      } else if (char === '}' || char === ']') {
        if (this.depth === 3 && char === ']') this.count++;
        this.depth--;
      }
    }
    return this.count > before;
  }
}
