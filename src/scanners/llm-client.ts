import * as z from 'zod';

import { getLogger } from '../logger.ts';
import { type Extraction, ExtractionSchema, extractionGrammar, extractionJsonSchema } from './extraction.ts';
import { SYSTEM_PROMPT, userPrompt } from './prompt.ts';

const log = getLogger('scanner.llm');

const ChatCompletionSchema = z.object({
  choices: z
    .array(z.object({ message: z.object({ content: z.string() }), finish_reason: z.string().nullish() }))
    .min(1),
  usage: z.object({ prompt_tokens: z.number(), completion_tokens: z.number() }).optional(),
});

export interface ReceiptExtractor {
  /** signal aborts the call when the client goes away */
  extract(ocrText: string, signal?: AbortSignal): Promise<Extraction>;
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

  async extract(ocrText: string, signal?: AbortSignal): Promise<Extraction> {
    const startedAt = performance.now();
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
    });
    if (!res.ok) {
      throw new Error(`LLM server answered ${res.status}: ${(await res.text()).slice(0, 200)}`);
    }

    const completion = ChatCompletionSchema.parse(await res.json());
    const choice = completion.choices[0]!;
    const elapsedMs = Math.round(performance.now() - startedAt);
    log.info(`LLM complete in ${elapsedMs}ms`, {
      llm: {
        model: this.model,
        elapsedMs,
        promptTokens: completion.usage?.prompt_tokens,
        completionTokens: completion.usage?.completion_tokens,
        finishReason: choice.finish_reason ?? undefined,
      },
    });
    if (choice.finish_reason === 'length') {
      throw new Error('LLM output was cut off at max_tokens');
    }

    return ExtractionSchema.parse(JSON.parse(choice.message.content));
  }
}
