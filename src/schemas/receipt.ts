import * as z from 'zod';

/** Item categories the scanner can return. Discounts get no category. */
export const ITEM_CATEGORIES = ['food', 'drink', 'alcohol', 'dessert', 'other'] as const;

export type ItemCategory = (typeof ITEM_CATEGORIES)[number];

/**
 * Contract shared with bill-please web (`IReceiptItem` / `IReceiptScanResult`).
 * Keep both sides in sync when changing it.
 */
export const ReceiptItemSchema = z.object({
  name: z.string().min(1).describe('Item name as printed on the receipt, with OCR errors fixed'),
  quantity: z.number().positive().describe('Quantity ordered'),
  price: z
    .number()
    .describe('Unit price before service charge and VAT, negative for discounts'),
  servicePercentage: z
    .number()
    .min(0)
    .optional()
    .describe('Service charge percentage applied to this item, e.g. 10'),
  vatPercentage: z
    .number()
    .min(0)
    .optional()
    .describe('VAT percentage applied to this item, e.g. 7'),
  category: z
    .enum(ITEM_CATEGORIES)
    .optional()
    .describe('What the item is: food, drink, alcohol, dessert or other. Discounts have none'),
});

export const ReceiptScanResultSchema = z.object({
  items: z.array(ReceiptItemSchema),
});

export type ReceiptItem = z.infer<typeof ReceiptItemSchema>;
export type ReceiptScanResult = z.infer<typeof ReceiptScanResultSchema>;

export const SUPPORTED_IMAGE_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/heic',
  'image/heif',
] as const;

export type SupportedImageType = (typeof SUPPORTED_IMAGE_TYPES)[number];
