export function toPence(pounds: number): number {
  return Math.round(pounds * 100);
}

// 1250 → "12.50", -5 → "-0.05". Integer maths only, for spreadsheet/CSV output.
export function penceToDecimal(pence: number): string {
  const sign = pence < 0 ? '-' : '';
  const abs = Math.abs(Math.trunc(pence));
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

/**
 * The net-of-VAT part of a cash amount, in pence. Invoices and bills store VAT
 * separately, so profit and loss recognises `amount * subtotal / total`. A document
 * with no total (or no VAT, so subtotal equals total) contributes the whole amount.
 * Half pennies round half up. The same formula is in the dashboard SQL.
 */
export function netOfVat(amount: number, subtotal: number, total: number): number {
  if (total <= 0) return amount;
  const sign = amount < 0 ? -1 : 1;
  const a = Math.abs(amount);
  const netBase = Math.min(Math.max(subtotal, 0), total);
  return sign * Math.floor((a * netBase * 2 + total) / (2 * total));
}

/**
 * The VAT inside a gross amount at `rate` (0.20 = 20%), in pence: gross * rate / (1 + rate).
 * The rate is taken in basis points so the division is on integers; half pennies round half up.
 * £120.00 at 20% → £20.00 VAT. A rate of 0 (or none) gives 0.
 */
export function vatInGross(amount: number, rate: number | null | undefined): number {
  const bp = Math.round((rate ?? 0) * 10000);
  if (bp <= 0) return 0;
  const sign = amount < 0 ? -1 : 1;
  const a = Math.abs(amount);
  const d = 10000 + bp;
  return sign * Math.floor((a * bp * 2 + d) / (2 * d));
}

/**
 * Splits `total` across `weights` in whole pence. Shares sum to `total`;
 * leftover pennies go to the largest fractional parts.
 */
export function allocateByWeight(total: number, weights: number[]): number[] {
  if (weights.length === 0) return [];
  const safe = weights.map(w => (w > 0 ? w : 0));
  const sum = safe.reduce((s, w) => s + w, 0);
  if (sum <= 0) {
    const out = safe.map(() => 0);
    out[out.length - 1] = total;
    return out;
  }
  const floors = safe.map(w => Math.floor((total * w) / sum));
  let left = total - floors.reduce((s, n) => s + n, 0);
  const order = safe
    .map((w, i) => ({ i, rem: (total * w) % sum }))
    .sort((a, b) => b.rem - a.rem || a.i - b.i);
  for (const { i } of order) {
    if (left <= 0) break;
    floors[i] += 1;
    left -= 1;
  }
  return floors;
}

/** The UK VAT rates a new invoice or bill line may carry: zero, reduced and standard. */
export const VAT_RATES = [0, 0.05, 0.2] as const;
export const isVatRate = (r: number) => (VAT_RATES as readonly number[]).includes(r);

/** VAT charged on a net amount at `rate` (0.20 = 20%), rounded to the penny: £1,000 at 20% → £200. */
export function vatOnNet(net: number, rate: number): number {
  return Math.round(net * rate);
}

export function calculateTotals(
  items: { quantity: number; unit_price: number; tax_rate: number }[]
): { subtotal: number; tax_amount: number; total: number } {
  let subtotal = 0;
  let tax_amount = 0;

  for (const item of items) {
    const line = Math.round(item.quantity * item.unit_price);
    const lineVat = Math.round(line * item.tax_rate);
    subtotal += line;
    tax_amount += lineVat;
  }

  return { subtotal, tax_amount, total: subtotal + tax_amount };
}

// "1,250.5" / "£1250.50" / "-12" → pence (125050 / 125050 / -1200); null when the text isn't an
// amount. Parsed as text so no float is involved.
export function parsePenceText(text: string): number | null {
  const m = /^(-?)£?(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?$/.exec(text.trim());
  if (!m) return null;
  const pence = Number(m[2].replace(/,/g, '')) * 100 + Number((m[3] ?? '').padEnd(2, '0'));
  return m[1] ? -pence : pence;
}
