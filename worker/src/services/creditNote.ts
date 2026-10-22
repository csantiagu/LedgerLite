// How much of an invoice a credit note may still take, per VAT rate. A credit can use any rate the
// invoice itself uses (including a QuickBooks rate that is not exactly 0%, 5% or 20%), and no more
// net or VAT at that rate than the invoice still has. Shifting the money onto a higher rate would
// claim back more VAT than was charged.
import { penceToDecimal } from './money';

export type RatedLine = { quantity: number; unit_price: number; tax_rate: number };

/** The rate in basis points, so 0.2 and a value SQLite hands back as 0.20000000000000004 compare equal. */
export const rateKey = (rate: number) => Math.round(rate * 10000);

const rateLabel = (key: number) => `${key / 100}%`;

export function lineNetVat(item: RatedLine): { net: number; vat: number } {
  const net = Math.round(item.quantity * item.unit_price);
  return { net, vat: Math.round(net * item.tax_rate) };
}

/** Net and VAT still available to credit, keyed by the rate in basis points. */
export function roomByRate(original: RatedLine[], credited: RatedLine[]): Map<number, { net: number; vat: number }> {
  const room = new Map<number, { net: number; vat: number }>();
  const apply = (items: RatedLine[], sign: number) => {
    for (const item of items) {
      const key = rateKey(item.tax_rate);
      const { net, vat } = lineNetVat(item);
      const cur = room.get(key) ?? { net: 0, vat: 0 };
      cur.net += sign * net;
      cur.vat += sign * vat;
      room.set(key, cur);
    }
  };
  apply(original, 1);
  apply(credited, -1);
  return room;
}

export type CreditCheck = { ok: true } | { ok: false; error: string };

/** The lines of a credit note, checked against what the invoice has left at each VAT rate. */
export function checkCreditLines(original: RatedLine[], credited: RatedLine[], items: RatedLine[]): CreditCheck {
  const room = roomByRate(original, credited);
  // The credit at each rate, added up first: comparing line by line would let VAT rounded up on
  // several small lines refuse a credit whose total fits
  const wanted = roomByRate(items, []);
  for (const [key, want] of wanted) {
    const slot = room.get(key);
    if (!slot) {
      const shown = [...room.keys()].map(rateLabel).join(' or ') || 'none';
      return { ok: false, error: `A credit note takes the VAT rate of the invoice it credits (${shown})` };
    }
    // A penny of rounding on VAT is tolerated; the total is still capped by what is left to credit
    if (want.net > slot.net || want.vat > slot.vat + 1) {
      return {
        ok: false,
        error: `Only £${penceToDecimal(Math.max(0, slot.net))} net (£${penceToDecimal(Math.max(0, slot.vat))} VAT) at ${rateLabel(key)} is left to credit on this invoice`,
      };
    }
  }
  return { ok: true };
}
