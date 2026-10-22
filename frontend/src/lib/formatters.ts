// The only file in the frontend that divides by 100.
export const formatPence = (p: number): string =>
  new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'GBP' }).format(p / 100);

/** 1250 → 12.5, for filling a pounds input from stored pence. */
export const penceToPounds = (p: number): number => p / 100;

export const formatDate = (iso: string): string =>
  new Date(iso).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });

export const formatDateShort = (iso: string): string =>
  new Date(iso).toLocaleDateString('en-GB', { day: '2-digit', month: 'short' });

export const statusLabel: Record<string, string> = {
  draft:   'Draft',
  sent:    'Sent',
  partial: 'Part paid',
  paid:    'Paid',
  void:    'Void',
  overdue: 'Overdue',
  pending: 'Pending',
};

export const statusBadgeClass: Record<string, string> = {
  draft:   'badge-gray',
  sent:    'badge-blue',
  partial: 'badge-yellow',
  paid:    'badge-green',
  void:    'badge-gray',
  overdue: 'badge-red',
  pending: 'badge-yellow',
};

/** A UTC SQLite timestamp ("2026-06-01 14:05:09") in local time: "01 Jun 2026, 15:05". */
export const formatDateTime = (sqlUtc: string): string =>
  new Date(`${sqlUtc.replace(' ', 'T')}${/[zZ]|[+-]\d\d:?\d\d$/.test(sqlUtc) ? '' : 'Z'}`)
    .toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
