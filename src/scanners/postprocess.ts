import type { ReceiptItem } from '../schemas/receipt.ts';
import type { Extraction } from './extraction.ts';

const round2 = (value: number) => Math.round(value * 100) / 100;

// Small models sometimes write 10% as 0.1
const percent = (value: number) => {
  const fixed = value > 0 && value < 1 ? value * 100 : value;
  return fixed > 0 && fixed <= 100 ? round2(fixed) : 0;
};

export interface Reconciliation {
  computedTotal: number;
  printedTotal: number | null;
  // false when the receipt has no printed total, because nothing was checked
  matches: boolean;
}

// A quantity column printed before the name, e.g. "4.00 F1.Water", that the model left in the name
const LEADING_QUANTITY = /^(\d+(?:\.\d+)?)\s*[x×]?\s+(?=\S)/;

const splitLeadingQuantity = (name: string, quantity: number): [string, number] => {
  const match = LEADING_QUANTITY.exec(name);
  if (!match) return [name, quantity];
  const printed = Number(match[1]);
  // A decimal like "4.00" is always a quantity column. A bare "2" counts only when it equals the quantity
  if (printed === quantity || (quantity === 1 && match[1]!.includes('.') && printed > 0)) {
    return [name.slice(match[0].length), printed];
  }
  return [name, quantity];
};

/**
 * Maps the LLM output to the client contract. The receipt-level service charge and
 * VAT go on every item, discounts included, so the web total equals the receipt total.
 * A VAT-inclusive receipt keeps its printed prices and gets no VAT percentage.
 * Every item except a discount keeps the model's category.
 */
export const toReceiptItems = (extraction: Extraction): ReceiptItem[] => {
  const servicePercentage = percent(extraction.servicePercent);
  const vatPercentage = extraction.vatIncluded ? 0 : percent(extraction.vatPercent);

  return extraction.items.flatMap(([rawName, rawQuantity, amount, category]) => {
    const [name, quantity] = splitLeadingQuantity(
      rawName.trim(),
      Number.isFinite(rawQuantity) && rawQuantity > 0 ? rawQuantity : 1,
    );
    if (!name || !Number.isFinite(amount) || amount === 0) return [];
    // Discounts are one line, whatever quantity the model wrote
    const unitQuantity = amount < 0 ? 1 : quantity;

    return [
      {
        name,
        quantity: unitQuantity,
        price: round2(amount / unitQuantity),
        ...(servicePercentage ? { servicePercentage } : {}),
        ...(vatPercentage ? { vatPercentage } : {}),
        // A discount isn't an item someone ordered, so it gets no category
        ...(amount > 0 ? { category } : {}),
      },
    ];
  });
};

/** Compares the items, priced the way the web prices them, with the printed grand total */
export const reconcile = (items: ReceiptItem[], printedTotal: number | null): Reconciliation => {
  const computedTotal = round2(
    items.reduce((sum, item) => {
      const base = item.price * item.quantity;
      const service = base * ((item.servicePercentage ?? 0) / 100);
      const vat = (base + service) * ((item.vatPercentage ?? 0) / 100);
      return sum + base + service + vat;
    }, 0),
  );
  const tolerance = Math.max(1, Math.abs(printedTotal ?? 0) * 0.005);
  return {
    computedTotal,
    printedTotal,
    matches: printedTotal !== null && Math.abs(computedTotal - printedTotal) <= tolerance,
  };
};

// Rates printed on the receipt, e.g. "TAX 6%", "VAT 7%", "ภาษีมูลค่าเพิ่ม 7%" or "Service Charge 10%"
const PRINTED_TAX = /(?:\bVAT|\bTAX|ภาษี\S*)\s*:?\s*(\d{1,2}(?:\.\d+)?)\s*%/giu;
const PRINTED_SERVICE = /(?:\bservice(?:\s+charge)?|\bS\.?C\.?|ค่าบริการ)\s*:?\s*(\d{1,2}(?:\.\d+)?)\s*%/giu;

const printedRates = (text: string, pattern: RegExp) => [...text.matchAll(pattern)].map((match) => Number(match[1]));

/**
 * Small models misread the receipt-level rates in two ways. Receipts such as "ราคารวม 315.89,
 * VAT 7% 22.11, ราคารวมสุทธิ 338.00" print a VAT line although the item prices already include
 * it, and the model reads that as VAT on top. On bill-2 Qwen3 4B returns no rate for "TAX 6%".
 * When the model's reading doesn't match the printed total, this tries the rates printed in the
 * OCR text with VAT on top and included, and keeps the first reading that matches.
 */
export const resolveRates = (extraction: Extraction, ocrText: string): Extraction => {
  if (extraction.total === null) return extraction;
  const matches = (candidate: Extraction) =>
    reconcile(toReceiptItems(candidate), extraction.total).matches;
  if (matches(extraction)) return extraction;

  const unique = (values: number[]) => [...new Set(values.map(percent))];
  const services = unique([extraction.servicePercent, ...printedRates(ocrText, PRINTED_SERVICE), 0]);
  const vats = unique([extraction.vatPercent, ...printedRates(ocrText, PRINTED_TAX), 0]);
  for (const servicePercent of services) {
    for (const vatPercent of vats) {
      for (const vatIncluded of [extraction.vatIncluded, !extraction.vatIncluded]) {
        const candidate = { ...extraction, servicePercent, vatPercent, vatIncluded };
        if (matches(candidate)) return candidate;
      }
    }
  }
  return extraction;
};
