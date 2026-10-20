// Pure rules for the Invoices list headings, kept apart from the page so they can be tested.

export type SortKey = 'number' | 'client' | 'issue_date' | 'due_date' | 'status' | 'total' | 'balance';
export type SortState = { sort: SortKey | ''; dir: 'asc' | 'desc' };

/** Text columns start A→Z; dates and amounts start newest / largest first. */
export const firstDir = (key: SortKey): 'asc' | 'desc' => (key === 'number' || key === 'client' ? 'asc' : 'desc');

/**
 * Clicking a heading: sort by it, click again to flip it, a third time to go back to the default
 * order (drafts first, then newest), shown as no sort.
 */
export function nextSort(current: SortState, key: SortKey): SortState {
  if (current.sort !== key) return { sort: key, dir: firstDir(key) };
  if (current.dir === firstDir(key)) return { sort: key, dir: current.dir === 'asc' ? 'desc' : 'asc' };
  return { sort: '', dir: 'desc' };
}
