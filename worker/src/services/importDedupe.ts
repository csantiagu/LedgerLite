// Which lines of a bank statement are new. Two genuine payments can look identical (two £4.50
// coffees on the same day), so lines are counted, not just looked up: a file with two of a line
// that's already in the books once brings in one more. Importing the same file, or an overlapping
// one, again adds nothing.

export type StatementLine = {
  date: string;
  description: string;
  amount: number;
  reference: string | null;
};

/** What makes two lines "the same" for duplicate checks. The running balance is left out on purpose:
 *  not every bank exports one, and the books may hold lines from a file that didn't. */
export const lineKey = (l: StatementLine) =>
  JSON.stringify([l.date, l.description, l.amount, l.reference ?? '']);

/**
 * Splits a parsed file into lines to insert and lines already in the books.
 * `existing` is the lines already stored for this account on the file's dates.
 * Within each key, the first copies count as already imported, so the extra ones are new.
 */
export function newLines<T extends StatementLine>(
  parsed: T[],
  existing: StatementLine[],
): { fresh: T[]; duplicates: T[] } {
  const stored = new Map<string, number>();
  for (const l of existing) {
    const key = lineKey(l);
    stored.set(key, (stored.get(key) ?? 0) + 1);
  }
  const fresh: T[] = [];
  const duplicates: T[] = [];
  for (const line of parsed) {
    const key = lineKey(line);
    const left = stored.get(key) ?? 0;
    if (left > 0) {
      stored.set(key, left - 1);
      duplicates.push(line);
    } else {
      fresh.push(line);
    }
  }
  return { fresh, duplicates };
}

/** The first and last date in a file, or null when it has no lines. */
export function dateRange(lines: Array<{ date: string }>): { from: string; to: string } | null {
  if (!lines.length) return null;
  const dates = lines.map(l => l.date).sort();
  return { from: dates[0]!, to: dates.at(-1)! };
}
