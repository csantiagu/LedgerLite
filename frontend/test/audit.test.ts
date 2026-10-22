import { describe, expect, it } from 'vitest';
import { auditActor, auditChanges, auditHref, auditTitle, formatAuditValue } from '@/lib/audit';

describe('formatAuditValue', () => {
  it('shows money, VAT rates, flags, statuses, dates and line lists as a person would write them', () => {
    expect(formatAuditValue('total', 24_000)).toBe('£240.00');
    expect(formatAuditValue('vatRate', 0.2)).toBe('20%');
    expect(formatAuditValue('vatRate', 0.05)).toBe('5%');
    expect(formatAuditValue('tax_rate', 0)).toBe('No VAT');
    expect(formatAuditValue('flagged', true)).toBe('Yes');
    expect(formatAuditValue('status', 'partial')).toBe('Part paid');
    expect(formatAuditValue('issue_date', '2026-06-01')).toBe('01 Jun 2026');
    expect(formatAuditValue('items', [{}, {}])).toBe('2 lines');
    expect(formatAuditValue('notes', null)).toBe('—');
    expect(formatAuditValue('notes', '')).toBe('—');
    expect(formatAuditValue('priority', 100)).toBe('100');
  });
});

describe('auditChanges', () => {
  it('lists each changed field old → new, by name, leaving out ids and storage keys', () => {
    expect(auditChanges({
      old_values: { expenseCategoryId: 'a1', category: 'Travel', vatRate: null },
      new_values: { expenseCategoryId: 'b2', category: 'Software', vatRate: 0.2 },
    })).toEqual([
      { field: 'Category', from: 'Travel', to: 'Software' },
      { field: 'VAT', from: '—', to: '20%' },
    ]);
  });

  it('shows fields only one side has, and drops ones that read the same', () => {
    expect(auditChanges({ old_values: null, new_values: { total: 500, key: 'r2/x', paymentId: 'p' } }))
      .toEqual([{ field: 'Total', from: '—', to: '£5.00' }]);
    expect(auditChanges({ old_values: { notes: '' }, new_values: { notes: null } })).toEqual([]);
    expect(auditChanges({ old_values: { someNewField: 1 }, new_values: { someNewField: 2 } }))
      .toEqual([{ field: 'Some New Field', from: '1', to: '2' }]);
  });
});

describe('auditTitle, auditActor and auditHref', () => {
  it('falls back to the action when an older entry has no summary', () => {
    expect(auditTitle({ summary: 'Voided INV-2026-0001', action: 'invoice.voided' })).toBe('Voided INV-2026-0001');
    expect(auditTitle({ summary: null, action: 'transaction.match_added' })).toBe('Match added');
  });

  it('names who made the change, and marks API keys', () => {
    expect(auditActor({ user_name: 'Olivia', api_key_id: null })).toBe('Olivia');
    expect(auditActor({ user_name: 'Olivia', api_key_id: 'k' })).toBe('Olivia (API key)');
    expect(auditActor({ user_name: null, api_key_id: null })).toBe('System');
  });

  it('links to records that have a page', () => {
    expect(auditHref({ resource_type: 'invoice', resource_id: 'abc' })).toBe('/invoices/view?id=abc');
    expect(auditHref({ resource_type: 'vendor', resource_id: 'v' })).toBe('/vendors/view?id=v');
    expect(auditHref({ resource_type: 'transaction', resource_id: 't' })).toBeNull();
    expect(auditHref({ resource_type: 'invoice', resource_id: null })).toBeNull();
  });
});
