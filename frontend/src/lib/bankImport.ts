// What a bank statement import did, in words for the owner.
import { formatDate } from './formatters';

export type ImportResult = {
  newRowCount?: number;
  skipped?: number;
  inLockedPeriod?: number;
  lockDate?: string | null;
  overlaps?: Array<{ filename: string; imported_at: string; first_date: string; last_date: string }>;
  suggested?: number;
  categorised?: number;
  openingBalanceSet?: boolean;
};

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export function importSummary(r: ImportResult): string {
  const parts = [`Imported ${plural(r.newRowCount ?? 0, 'new transaction')} into For Review`];
  if (r.skipped) {
    const from = r.overlaps?.length === 1
      ? ` (also in ${r.overlaps[0]!.filename}, imported ${formatDate(r.overlaps[0]!.imported_at.slice(0, 10))})`
      : r.overlaps?.length ? ` (also in ${plural(r.overlaps.length, 'earlier import')})` : '';
    parts.push(`${plural(r.skipped, 'line')} already in the books skipped${from}`);
  }
  if (r.inLockedPeriod) {
    parts.push(`${plural(r.inLockedPeriod, 'line')} dated in a locked VAT period${r.lockDate ? ` (up to ${formatDate(r.lockDate)})` : ''} left out`);
  }
  if (r.suggested) parts.push(plural(r.suggested, 'match suggestion'));
  if (r.categorised) parts.push(`${r.categorised} categorised by rules`);
  if (r.openingBalanceSet) parts.push('opening balance auto-detected from CSV');
  return `${parts.join(' · ')}.`;
}
