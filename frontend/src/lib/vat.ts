// VAT included in a bank line, a category's usual VAT, or a rule's VAT. Rates are fractions as the
// API stores them (0.2 = 20%); null means not chosen. Select boxes carry them as strings.

export const VAT_CHOICES: Array<{ value: string; label: string }> = [
  { value: '0.2', label: '20% VAT' },
  { value: '0.05', label: '5% VAT' },
  { value: '0', label: 'No VAT' },
];

/** null → '', 0.2 → '0.2' */
export const vatToValue = (rate: number | null | undefined): string =>
  rate === null || rate === undefined ? '' : String(rate);

/** '' → null, '0.2' → 0.2 */
export const valueToVat = (value: string): number | null => (value === '' ? null : Number(value));

/** 0.2 → '20% VAT', 0 → 'No VAT', null → the fallback */
export function vatLabel(rate: number | null | undefined, unset = 'VAT not set'): string {
  if (rate === null || rate === undefined) return unset;
  if (rate === 0) return 'No VAT';
  return `${Math.round(rate * 10000) / 100}% VAT`;
}

/** The choices plus the current rate when it's one the list doesn't offer (set some other way). */
export function vatChoicesFor(rate: number | null | undefined) {
  const value = vatToValue(rate);
  return value === '' || VAT_CHOICES.some(c => c.value === value)
    ? VAT_CHOICES
    : [...VAT_CHOICES, { value, label: vatLabel(rate) }];
}

/** The VAT inside a gross amount in pence, rounded half up (the same sum as the worker's vatInGross). */
export function vatInGross(amount: number, rate: number | null | undefined): number {
  const bp = Math.round((rate ?? 0) * 10000);
  if (bp <= 0) return 0;
  const a = Math.abs(amount);
  const d = 10000 + bp;
  return (amount < 0 ? -1 : 1) * Math.floor((a * bp * 2 + d) / (2 * d));
}
