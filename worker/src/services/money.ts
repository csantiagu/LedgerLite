export function toPence(pounds: number): number {
  return Math.round(pounds * 100);
}

// 1250 → "12.50", -5 → "-0.05". Integer maths only, for spreadsheet/CSV output.
export function penceToDecimal(pence: number): string {
  const sign = pence < 0 ? '-' : '';
  const abs = Math.abs(Math.trunc(pence));
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
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
