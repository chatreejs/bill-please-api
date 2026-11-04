import * as z from 'zod';

import { ITEM_CATEGORIES } from '../schemas/receipt.ts';

/**
 * What the LLM returns. It is smaller than the client contract to save tokens,
 * because generation speed is the bottleneck on a small GPU. `toReceiptItems` maps it.
 *
 * Each item is [name, quantity, line amount as printed, category]. The name has OCR errors
 * fixed. Service charge and VAT are
 * receipt level, and `total` is the printed grand total, used only to check the result.
 */
export const ExtractionSchema = z.object({
  items: z.array(z.tuple([z.string(), z.number(), z.number(), z.enum(ITEM_CATEGORIES)])),
  servicePercent: z.number(),
  vatPercent: z.number(),
  vatIncluded: z.boolean(),
  total: z.number().nullable(),
});

export type Extraction = z.infer<typeof ExtractionSchema>;

// llama.cpp rejects the boolean `items: false` that zod adds to tuples.
// maxItems already stops extra tuple entries.
const dropBooleanItems = (node: unknown): unknown => {
  if (Array.isArray(node)) return node.map(dropBooleanItems);
  if (!node || typeof node !== 'object') return node;
  return Object.fromEntries(
    Object.entries(node)
      .filter(([key, value]) => !(key === 'items' && typeof value === 'boolean'))
      .map(([key, value]) => [key, dropBooleanItems(value)]),
  );
};

export const extractionJsonSchema = dropBooleanItems(z.toJSONSchema(ExtractionSchema)) as Record<
  string,
  unknown
>;

/**
 * The same shape as a llama.cpp GBNF grammar, sent in place of json_schema when
 * LLM_OUTPUT_FORMAT is gbnf. Under json_schema the model adds newlines and indentation and
 * writes 120.00 for 120, and Qwen spends a token on each digit and space run. On the cluster's llm-server this
 * grammar cut the output on bill-3 (15 items) from 398 to 337 tokens, and the scan from 22.7 s
 * to 19.5 s. Numbers have at most 7 integer digits and 2 decimals, so the model can't write
 * 338.00000000000006. A rule that forbade a trailing zero made the model write 338.01 for 338.00.
 * Keep the keys in ExtractionSchema order.
 */
export const extractionGrammar = String.raw`root ::= "{\"items\":[" (item ("," item)*)? "],\"servicePercent\":" num ",\"vatPercent\":" num ",\"vatIncluded\":" ("true" | "false") ",\"total\":" (num | "null") "}"
item ::= "[" str "," num "," num "," category "]"
category ::= ${ITEM_CATEGORIES.map((category) => JSON.stringify(JSON.stringify(category))).join(' | ')}
str ::= "\"" ([^"\\\x7F\x00-\x1F] | "\\" (["\\/bfnrt] | "u" [0-9a-fA-F]{4}))* "\""
num ::= "-"? ("0" | [1-9] [0-9]{0,6}) ("." [0-9] [0-9]?)?`;
