import * as z from 'zod';

import { getLogger } from '../logger.ts';
import { type Extraction, ExtractionSchema, extractionGrammar, extractionJsonSchema } from './extraction.ts';
import { type ExtractionEvent, ItemCounter } from './progress.ts';
import { SYSTEM_PROMPT, userPrompt } from './prompt.ts';
import type { ScannerStatus } from './types.ts';

const log = getLogger('scanner.llm');

const ChatCompletionSchema = z.object({
  choices: z
    .array(z.object({ message: z.object({ content: z.string() }), finish_reason: z.string().nullish() }))
    .min(1),
  usage: z.object({ prompt_tokens: z.number(), completion_tokens: z.number() }).optional(),
});

const UsageSchema = z.object({ prompt_tokens: z.number(), completion_tokens: z.number() });

const ChunkSchema = z.object({
  choices: z
    .array(z.object({ delta: z.object({ content: z.string().nullish() }).optional(), finish_reason: z.string().nullish() }))
    .optional(),
  usage: UsageSchema.nullish(),
});

interface Completion {
  content: string;
  finishReason?: string;
  usage?: z.infer<typeof UsageSchema>;
}

export interface ExtractOptions {
  /** Aborts the call when the client goes away */
  signal?: AbortSignal;
  /** Gets the queue position, the start of the call and each finished item */
  onEvent?: (event: ExtractionEvent) => void;
}

export interface ReceiptExtractor {
  extract(ocrText: string, options?: ExtractOptions): Promise<Extraction>;
  /** Queue state, when the extractor has a queue */
  status?(): ScannerStatus;
}

/**
 * Extractor for any OpenAI compatible chat completions API, such as llama.cpp
 * llama-server. A GBNF `grammar` (llama.cpp only) or the JSON schema in `response_format`
 * constrains decoding, so the model can only produce JSON in the extraction shape.
 */
export class OpenAiCompatibleExtractor implements ReceiptExtractor {
  constructor(
    private readonly url: string,
    private readonly model: string,
    private readonly timeoutMs: number,
    private readonly options: {
      apiKey?: string;
      reasoningEffort?: string;
      outputFormat?: 'gbnf' | 'json_schema';
    } = {},
  ) {}

  async extract(ocrText: string, { signal, onEvent }: ExtractOptions = {}): Promise<Extraction> {
    const startedAt = performance.now();
    onEvent?.({ type: 'started' });
    log.info(`Calling LLM ${this.model}`, {
      llm: { url: this.url, model: this.model, outputFormat: this.options.outputFormat ?? 'json_schema', ocrChars: ocrText.length },
    });
    const res = await fetch(`${this.url}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(this.options.apiKey ? { authorization: `Bearer ${this.options.apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: this.model,
        temperature: 0,
        max_tokens: 2048,
        // Streaming lets the scan report each item as the model finishes it
        stream: true,
        stream_options: { include_usage: true },
        ...(this.options.reasoningEffort ? { reasoning_effort: this.options.reasoningEffort } : {}),
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: userPrompt(ocrText) },
        ],
        ...(this.options.outputFormat === 'gbnf'
          ? { grammar: extractionGrammar }
          : {
              response_format: {
                type: 'json_schema',
                json_schema: { name: 'receipt', strict: true, schema: extractionJsonSchema },
              },
            }),
      }),
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(this.timeoutMs)])
        : AbortSignal.timeout(this.timeoutMs),
      // A queued scan starts as soon as the previous stream ends, and a reused connection then
      // failed with ECONNRESET every time. A new connection adds one TCP handshake per scan
      keepalive: false,
    });
    if (!res.ok) {
      throw new Error(`LLM server answered ${res.status}: ${(await res.text()).slice(0, 200)}`);
    }

    // An API that ignores stream answers with one JSON body
    const completion = res.headers.get('content-type')?.includes('text/event-stream')
      ? await readStream(res, onEvent)
      : parseCompletion(await res.json());
    const elapsedMs = Math.round(performance.now() - startedAt);
    log.info(`LLM complete in ${elapsedMs}ms`, {
      llm: {
        model: this.model,
        elapsedMs,
        promptTokens: completion.usage?.prompt_tokens,
        completionTokens: completion.usage?.completion_tokens,
        finishReason: completion.finishReason,
      },
    });
    if (completion.finishReason === 'length') {
      throw new Error('LLM output was cut off at max_tokens');
    }

    return ExtractionSchema.parse(JSON.parse(completion.content));
  }
}

const parseCompletion = (body: unknown): Completion => {
  const completion = ChatCompletionSchema.parse(body);
  const choice = completion.choices[0]!;
  return { content: choice.message.content, finishReason: choice.finish_reason ?? undefined, usage: completion.usage };
};

/** Reads an SSE chat completion stream, and reports each finished item */
const readStream = async (res: Response, onEvent?: (event: ExtractionEvent) => void): Promise<Completion> => {
  const completion: Completion = { content: '' };
  const counter = new ItemCounter();
  const decoder = new TextDecoder();
  let buffer = '';

  const handleLine = (line: string) => {
    if (!line.startsWith('data:')) return;
    const data = line.slice(5).trim();
    if (data === '[DONE]') return;
    const chunk = ChunkSchema.parse(JSON.parse(data));
    if (chunk.usage) completion.usage = chunk.usage;
    const choice = chunk.choices?.[0];
    if (choice?.finish_reason) completion.finishReason = choice.finish_reason;
    const content = choice?.delta?.content;
    if (!content) return;
    completion.content += content;
    if (counter.push(content)) onEvent?.({ type: 'item', count: counter.count });
  };

  for await (const bytes of res.body!) {
    buffer += decoder.decode(bytes, { stream: true });
    let newline: number;
    while ((newline = buffer.indexOf('\n')) !== -1) {
      handleLine(buffer.slice(0, newline).trim());
      buffer = buffer.slice(newline + 1);
    }
  }
  handleLine(buffer.trim());
  return completion;
};
