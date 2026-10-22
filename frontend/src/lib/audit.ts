// Turning audit log rows into readable lines: "Category: Travel → Software".
import { formatDate, formatPence, statusLabel } from './formatters';

export type AuditEntry = {
  id: string;
  action: string;
  resource_type: string;
  resource_id: string | null;
  summary: string | null;
  old_values: Record<string, unknown> | null;
  new_values: Record<string, unknown> | null;
  user_id: string | null;
  user_name: string | null;
  api_key_id: string | null;
  created_at: string;
};

export type AuditChange = { field: string; from: string; to: string };

const LABELS: Record<string, string> = {
  category: 'Category', vatRate: 'VAT', tax_rate: 'VAT', notes: 'Notes', flagged: 'Flag',
  accountantNotes: 'Accountant notes', accountant_notes: 'Accountant notes', status: 'Status',
  total: 'Total', subtotal: 'Net', tax_amount: 'VAT', amount: 'Amount', amount_paid: 'Paid',
  allocatedAmount: 'Amount', openingBalance: 'Opening balance', items: 'Lines',
  issue_date: 'Issue date', due_date: 'Due date', payment_date: 'Payment date',
  bill_number: 'Bill number', invoice_number: 'Invoice number', name: 'Name', email: 'Email',
  phone: 'Phone', address: 'Address', tax_id: 'Tax ID', description: 'Description',
  matchText: 'Matches text', direction: 'Direction', priority: 'Priority', explanation: 'Explanation',
  defaultVatRate: 'Usual VAT', is_active: 'Active', isActive: 'Active', file: 'File', target: 'Matched to',
  posted: 'Posted', is_reconciled: 'Posted', method: 'Method', reference: 'Reference', lastFour: 'Last four digits',
  invoice_prefix: 'Invoice prefix', invoice_next_sequence: 'Next invoice number', vat_number: 'VAT number',
};

const MONEY = new Set([
  'total', 'subtotal', 'tax_amount', 'amount', 'amount_paid', 'allocatedAmount', 'openingBalance', 'net',
]);
const RATES = new Set(['vatRate', 'tax_rate', 'defaultVatRate', 'rate']);
const DATES = new Set(['issue_date', 'due_date', 'payment_date']);

// Ids and storage keys mean nothing to a reader; their readable twin (e.g. `category`) is shown instead
const HIDDEN = /(Id|_id|Ids|key)$|^(transactionIds|payments|reopened|links|undoneWith|paymentId|matchId|type)$/;

/** One value as a person would write it. */
export function formatAuditValue(field: string, value: unknown): string {
  if (value === null || value === undefined || value === '') return '—';
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (typeof value === 'number') {
    if (MONEY.has(field)) return formatPence(value);
    if (RATES.has(field)) return value === 0 ? 'No VAT' : `${Math.round(value * 10000) / 100}%`;
    return String(value);
  }
  if (Array.isArray(value)) return `${value.length} ${value.length === 1 ? 'line' : 'lines'}`;
  if (typeof value === 'string') {
    if (field === 'status') return statusLabel[value] ?? value;
    if (DATES.has(field) && /^\d{4}-\d{2}-\d{2}$/.test(value)) return formatDate(value);
    return value;
  }
  return '…';
}

/** The fields an entry changed, old → new, in the order they were recorded. */
export function auditChanges(entry: Pick<AuditEntry, 'old_values' | 'new_values'>): AuditChange[] {
  const before = entry.old_values ?? {};
  const after = entry.new_values ?? {};
  const fields = [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .filter(f => !HIDDEN.test(f));
  return fields.map(f => ({
    field: LABELS[f] ?? f.replace(/_/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').replace(/^./, s => s.toUpperCase()),
    from: formatAuditValue(f, before[f]),
    to: formatAuditValue(f, after[f]),
  })).filter(c => c.from !== c.to);
}

/** The entry's one-line description; older rows have no summary, so fall back to the action. */
export function auditTitle(entry: Pick<AuditEntry, 'summary' | 'action'>): string {
  if (entry.summary) return entry.summary;
  const verb = entry.action.split('.').pop() ?? entry.action;
  return verb.replace(/_/g, ' ').replace(/^./, s => s.toUpperCase());
}

/** Who made the change. */
export function auditActor(entry: Pick<AuditEntry, 'user_name' | 'api_key_id'>): string {
  if (entry.api_key_id) return `${entry.user_name ?? 'Someone'} (API key)`;
  return entry.user_name ?? 'System';
}

/** The page a record's entry links to, when it has one. */
export function auditHref(entry: Pick<AuditEntry, 'resource_type' | 'resource_id'>): string | null {
  const id = entry.resource_id;
  if (!id) return null;
  switch (entry.resource_type) {
    case 'invoice': return `/invoices/view?id=${encodeURIComponent(id)}`;
    case 'bill':    return `/bills/view?id=${encodeURIComponent(id)}`;
    case 'client':  return `/clients/view?id=${encodeURIComponent(id)}`;
    case 'vendor':  return `/vendors/view?id=${encodeURIComponent(id)}`;
    default:        return null;
  }
}

/** Record types the log can be filtered by, as the API names them. */
export const AUDIT_RECORD_TYPES: Array<{ value: string; label: string }> = [
  { value: 'invoice', label: 'Invoices' },
  { value: 'bill', label: 'Bills' },
  { value: 'transaction', label: 'Bank lines' },
  { value: 'bank_import', label: 'Bank imports' },
  { value: 'client', label: 'Clients' },
  { value: 'vendor', label: 'Vendors' },
  { value: 'bank_account', label: 'Bank accounts' },
  { value: 'expense_category', label: 'Categories' },
  { value: 'categorisation_rule', label: 'Rules' },
  { value: 'company_settings', label: 'Company settings' },
  { value: 'user', label: 'Users and sign-ins' },
];
