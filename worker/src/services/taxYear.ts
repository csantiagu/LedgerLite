// UK tax years run 6 April → 5 April and are labelled like "2025-26".

const LABEL = /^(\d{4})-(\d{2})$/;

/** "2025-26" → { from: "2025-04-06", to: "2026-04-05" }, or null if the label is malformed. */
export function taxYearRange(label: string): { from: string; to: string } | null {
  const m = LABEL.exec(label);
  if (!m) return null;
  const start = Number(m[1]);
  if (start < 2000 || start > 2999 || Number(m[2]) !== (start + 1) % 100) return null;
  return { from: `${start}-04-06`, to: `${start + 1}-04-05` };
}

/** The tax year containing a date (UTC calendar date). */
export function taxYearFor(date: Date): string {
  const y = date.getUTCFullYear();
  const afterApril6 = date.getUTCMonth() > 3 || (date.getUTCMonth() === 3 && date.getUTCDate() >= 6);
  const start = afterApril6 ? y : y - 1;
  return `${start}-${String((start + 1) % 100).padStart(2, '0')}`;
}
