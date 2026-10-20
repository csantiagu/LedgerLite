import type { D1Database } from '@cloudflare/workers-types';
import { parsePenceText } from './money';
import { IMPORTED_PAYMENT_REFERENCE } from './invoiceImport';

// Find match: what a bank line in review could be matched to, best first. Money in can pay open
// invoices (or, while QuickBooks history is being reconciled, be linked to the payment on a paid
// imported invoice); money out can pay open bills.

export type Candidate = {
  type: 'invoice' | 'bill';
  id: string;
  number: string | null;
  /** Another number that identifies it: for a VAT-only invoice, the invoice it charges VAT on */
  alt_number?: string | null;
  party: string;
  total: number;
  /** What can still be matched: unpaid (and not claimed by other lines) or, for a link, unlinked */
  outstanding: number;
  /** Due date, or for a link the date QuickBooks recorded the payment */
  date: string | null;
  /** Paid invoice imported from QuickBooks: matching links the bank line to its payment */
  link?: boolean;
};

/** Why a candidate ranked where it did, strongest first. */
export type Reason = 'number' | 'name' | 'exact' | 'near';
export type Ranked = Candidate & { reasons: Reason[] };

export type BankLineText = { description: string; reference: string | null; remaining: number };

// Words that say nothing about who a company is, so they never make a name match on their own
const NAME_STOPWORDS = new Set([
  'the', 'and', 'of', 'for', 'ltd', 'limited', 'plc', 'llp', 'llc', 'inc', 'co', 'company', 'uk', 'gb',
  'group', 'holdings', 'services', 'solutions', 'consulting', 'trading', 'international', 'partners',
]);

const tokens = (text: string) => text.toLowerCase().split(/[^a-z0-9]+/).filter(t => t.length >= 2);
const compact = (text: string) => text.toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * Share (0–1) of the client/vendor name found in the bank text. Bank references are often cut
 * short or run words together, so "ACME LINKI" and "ACMELINKING" both count for "Acme Linking Ltd".
 */
export function nameMatch(party: string, text: string): number {
  const all = tokens(party);
  const significant = all.filter(t => !NAME_STOPWORDS.has(t));
  const wanted = significant.length ? significant : all;
  if (!wanted.length) return 0;
  const textCompact = compact(text);
  const joined = wanted.join('');
  if (joined.length >= 5 && textCompact.includes(joined)) return 1;
  const seen = tokens(text);
  const found = wanted.filter(w => seen.some(s =>
    s === w || (s.length >= 4 && w.startsWith(s)) || (w.length >= 4 && s.startsWith(w))));
  return found.length / wanted.length;
}

/** Whether the invoice/bill number appears in the bank text. */
export function numberMatch(number: string | null, text: string): boolean {
  if (!number) return false;
  const n = compact(number);
  if (n.length < 3) return false;
  // A bare number ("1043") must be a whole word, so it isn't found inside an amount or a date
  return /^\d+$/.test(n) ? tokens(text).includes(n) : compact(text).includes(n);
}

/** 2 = the outstanding amount is exactly what's left of the line, 1 = within 2% (at least £1), 0 = neither. */
export function amountMatch(outstanding: number, remaining: number): 0 | 1 | 2 {
  if (remaining <= 0) return 0;
  const diff = Math.abs(outstanding - remaining);
  if (diff === 0) return 2;
  return diff <= Math.max(100, Math.round(remaining / 50)) ? 1 : 0;
}

/** Candidates for a line, best first: number in the text, then name, then amount, then closeness. */
export function rankCandidates(candidates: Candidate[], line: BankLineText): Ranked[] {
  const text = `${line.description} ${line.reference ?? ''}`;
  const scored = candidates.map(c => {
    const byNumber = numberMatch(c.number, text) || numberMatch(c.alt_number ?? null, text);
    const name = nameMatch(c.party, text);
    const byName = name >= 0.5;
    const amount = amountMatch(c.outstanding, line.remaining);
    const reasons: Reason[] = [];
    if (byNumber) reasons.push('number');
    if (byName) reasons.push('name');
    if (amount === 2) reasons.push('exact');
    if (amount === 1) reasons.push('near');
    return { c: { ...c, reasons }, byNumber, byName, name, amount, diff: Math.abs(c.outstanding - line.remaining) };
  });
  scored.sort((a, b) =>
    Number(b.byNumber) - Number(a.byNumber)
    || Number(b.byName) - Number(a.byName)
    || b.amount - a.amount
    || b.name - a.name
    || a.diff - b.diff
    || (b.c.date ?? '').localeCompare(a.c.date ?? '')
    || a.c.id.localeCompare(b.c.id));
  return scored.map(s => s.c);
}

/** Whether a search box entry picks out a candidate: part of its number or name, or its amount. */
export function matchesQuery(c: Candidate, q: string): boolean {
  const needle = q.trim().toLowerCase();
  if (!needle) return true;
  if ((c.number ?? '').toLowerCase().includes(needle) || c.party.toLowerCase().includes(needle)) return true;
  if (c.alt_number && c.alt_number.toLowerCase().includes(needle)) return true;
  const pence = parsePenceText(needle);
  return pence !== null && (Math.abs(pence) === c.outstanding || Math.abs(pence) === c.total);
}

export const BEST_LIMIT = 20;
export const ALL_LIMIT = 100;

/**
 * Narrows ranked candidates to what Find match shows: with a search, whatever it picks out; with
 * `all`, everything; otherwise only candidates with a reason to be there (number, name or amount).
 */
export function pickCandidates(ranked: Ranked[], opts: { q?: string; all?: boolean }) {
  const q = opts.q?.trim() ?? '';
  if (q) {
    const hits = ranked.filter(r => matchesQuery(r, q));
    return { results: hits.slice(0, ALL_LIMIT), hidden: Math.max(0, hits.length - ALL_LIMIT) };
  }
  if (opts.all) return { results: ranked.slice(0, ALL_LIMIT), hidden: Math.max(0, ranked.length - ALL_LIMIT) };
  const best = ranked.filter(r => r.reasons.length).slice(0, BEST_LIMIT);
  return { results: best, hidden: ranked.length - best.length };
}

// Pending matches from other bank lines already claim part of an invoice/bill
const claimedSql = (col: 'invoice_id' | 'bill_id', id: string) => `(
  SELECT COALESCE(SUM(om.allocated_amount), 0) FROM transaction_matches om
  WHERE om.${col} = ${id} AND om.status = 'pending' AND om.transaction_id != ?)`;

export type BankLine = {
  id: string; date: string; description: string; reference: string | null; amount: number; allocated: number;
};

/**
 * Everything a bank line could be matched to: open invoices or bills with money left on them and,
 * when `links` is true, paid QuickBooks invoices whose payment isn't fully linked yet. Anything
 * already matched to this line is left out.
 */
export async function loadCandidates(db: D1Database, line: BankLine, links: boolean): Promise<Candidate[]> {
  const out: Candidate[] = [];
  if (line.amount > 0) {
    const { results } = await db.prepare(`
      SELECT * FROM (
        SELECT i.id, i.invoice_number AS number, o.invoice_number AS alt_number, c.name AS party, i.total,
               i.due_date AS date, i.total - i.amount_paid - ${claimedSql('invoice_id', 'i.id')} AS outstanding
        FROM invoices i JOIN clients c ON c.id = i.client_id
        LEFT JOIN invoices o ON o.id = i.vat_for_invoice_id
        WHERE i.status IN ('sent','partial','overdue') AND i.amount_paid < i.total
          AND NOT EXISTS (SELECT 1 FROM transaction_matches m WHERE m.transaction_id = ? AND m.invoice_id = i.id)
      ) WHERE outstanding > 0
    `).bind(line.id, line.id).all<Omit<Candidate, 'type'>>();
    for (const r of results) out.push({ ...r, type: 'invoice' });

    if (links) {
      const { results: paid } = await db.prepare(`
        SELECT * FROM (
          SELECT i.id, i.invoice_number AS number, c.name AS party, i.total,
                 (SELECT MAX(payment_date) FROM payments_received WHERE invoice_id = i.id) AS date,
                 (SELECT COALESCE(SUM(pr.amount), 0) FROM payments_received pr
                   WHERE pr.invoice_id = i.id AND pr.method = 'other' AND pr.reference = ?)
                 - (SELECT COALESCE(SUM(lm.allocated_amount), 0) FROM transaction_matches lm
                   WHERE lm.invoice_id = i.id AND lm.kind = 'link') AS outstanding
          FROM invoices i JOIN clients c ON c.id = i.client_id
          WHERE i.source = 'quickbooks' AND i.status != 'void'
            AND NOT EXISTS (SELECT 1 FROM transaction_matches m WHERE m.transaction_id = ? AND m.invoice_id = i.id)
        ) WHERE outstanding > 0
      `).bind(IMPORTED_PAYMENT_REFERENCE, line.id).all<Omit<Candidate, 'type' | 'link'>>();
      for (const r of paid) out.push({ ...r, type: 'invoice', link: true });
    }
  } else if (line.amount < 0) {
    const { results } = await db.prepare(`
      SELECT * FROM (
        SELECT b.id, b.bill_number AS number, v.name AS party, b.total, b.due_date AS date,
               b.total - b.amount_paid - ${claimedSql('bill_id', 'b.id')} AS outstanding
        FROM bills b JOIN vendors v ON v.id = b.vendor_id
        WHERE b.status IN ('pending','partial') AND b.amount_paid < b.total
          AND NOT EXISTS (SELECT 1 FROM transaction_matches m WHERE m.transaction_id = ? AND m.bill_id = b.id)
      ) WHERE outstanding > 0
    `).bind(line.id, line.id).all<Omit<Candidate, 'type'>>();
    for (const r of results) out.push({ ...r, type: 'bill' });
  }
  return out;
}
