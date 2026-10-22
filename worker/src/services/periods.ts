// VAT quarters and the lock date. Locking a quarter freezes the bank lines, bills, payments and new
// sales invoices dated up to its last day, so a reviewed quarter is not edited by accident.
// Credit notes, voids and VAT-only invoices stay open: that is how a submitted quarter is corrected
// (VAT the customer will not pay after it was sent to HMRC, or VAT charged back to the registration
// date). Dates are ISO strings ('YYYY-MM-DD').

export type Quarter = { start: string; end: string; label: string };

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const pad = (n: number) => String(n).padStart(2, '0');
const lastDay = (year: number, month: number) => new Date(Date.UTC(year, month, 0)).getUTCDate(); // month 1–12

/**
 * The VAT quarter a date falls in. `endMonth` is any month a quarter ends in (1–12): 3 means
 * quarters end in Mar, Jun, Sep and Dec.
 */
export function quarterFor(date: string, endMonth: number): Quarter {
  const year = Number(date.slice(0, 4));
  const month = Number(date.slice(5, 7));
  // Months until this quarter's end month (0–2)
  const ahead = (((endMonth - month) % 3) + 3) % 3;
  let endYear = year;
  let end = month + ahead;
  if (end > 12) { end -= 12; endYear += 1; }
  let startYear = endYear;
  let start = end - 2;
  if (start < 1) { start += 12; startYear -= 1; }
  return {
    start: `${startYear}-${pad(start)}-01`,
    end: `${endYear}-${pad(end)}-${pad(lastDay(endYear, end))}`,
    label: `${MONTHS[start - 1]}${startYear !== endYear ? ` ${startYear}` : ''}–${MONTHS[end - 1]} ${endYear}`,
  };
}

/** The quarter after this one. */
export function nextQuarter(q: Quarter, endMonth: number): Quarter {
  const d = new Date(`${q.end}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return quarterFor(d.toISOString().slice(0, 10), endMonth);
}

/** Quarters from the one containing `from` to the one containing `to`, oldest first. */
export function quartersBetween(from: string, to: string, endMonth: number): Quarter[] {
  const out: Quarter[] = [];
  for (let q = quarterFor(from, endMonth); q.start <= to; q = nextQuarter(q, endMonth)) out.push(q);
  return out;
}

/** Whether a date is the last day of a quarter. */
export const isQuarterEnd = (date: string, endMonth: number) => quarterFor(date, endMonth).end === date;

export const today = () => new Date().toISOString().slice(0, 10);

const ukDate = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;

export type Locked = { ok: false; status: 423; error: string };

/** The lock date: the end of the latest locked quarter, or null when nothing is locked. */
export async function lockDate(db: D1Database): Promise<string | null> {
  const row = await db.prepare('SELECT MAX(period_end) AS d FROM period_locks WHERE unlocked_at IS NULL')
    .first<{ d: string | null }>();
  return row?.d ?? null;
}

/** Whether a date is on or before the lock date. Missing dates are never locked. */
export const isLocked = (date: string | null | undefined, lock: string | null) =>
  !!lock && !!date && date.slice(0, 10) <= lock;

export const lockedMessage = (date: string, lock: string) =>
  `${ukDate(date.slice(0, 10))} is in a locked VAT period (everything up to ${ukDate(lock)} has been reviewed and locked). `
  + 'The owner can unlock it in VAT periods.';

/**
 * Refuses when any of the dates is in a locked period. Pass the lock date when already known
 * (to save a query), or the database to look it up.
 */
export async function checkOpen(
  source: D1Database | { lock: string | null }, ...dates: Array<string | null | undefined>
): Promise<Locked | null> {
  const lock = 'lock' in source ? source.lock : await lockDate(source);
  const hit = dates.filter(d => isLocked(d, lock)).sort()[0];
  return hit ? { ok: false, status: 423, error: lockedMessage(hit, lock!) } : null;
}
