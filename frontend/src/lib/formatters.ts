// The only file in the frontend that divides by 100.
export const formatPence = (p: number): string =>
  new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'GBP' }).format(p / 100);

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
