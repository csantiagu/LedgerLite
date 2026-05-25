export function toPence(pounds: number): number {
  return Math.round(pounds * 100);
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
