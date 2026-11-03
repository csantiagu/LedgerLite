import { describe, expect, it } from 'vitest';
import { duplicateInvoice } from '@/app/invoices/new/duplicate';

const source = {
  id: 'a', invoice_number: 'INV-2026-0007', client_id: 'c1',
  issue_date: '2026-09-01', due_date: '2026-09-15', notes: 'Monthly retainer',
  items: [{ description: 'Retainer', quantity: 2, unit_price: 50000, tax_rate: 0.2 }],
};

describe('duplicateInvoice', () => {
  it('copies the client, lines and notes, dated today with the same payment terms', () => {
    expect(duplicateInvoice(source, '2026-11-02')).toEqual({
      initial: {
        client_id: 'c1', issue_date: '2026-11-02', due_date: '2026-11-16', notes: 'Monthly retainer',
        items: [{ description: 'Retainer', quantity: 2, unit_price: 50000, tax_rate: 0.2 }],
      },
      warnings: [],
    });
  });

  it('sets a VAT rate new invoices can’t use to 20% and says so', () => {
    const { initial, warnings } = duplicateInvoice(
      { ...source, notes: null, items: [{ ...source.items[0], tax_rate: 0.175 }, { ...source.items[0], tax_rate: 0 }] },
      '2026-11-02',
    );
    expect(warnings).toEqual([expect.stringContaining('set to 20%')]);
    expect(initial.items.map(i => i.tax_rate)).toEqual([0.2, 0]);
    expect(initial.notes).toBe('');
  });

  it('makes a duplicate of an invoice due on its issue date due today', () => {
    expect(duplicateInvoice({ ...source, due_date: '2026-09-01' }, '2026-11-02').initial.due_date).toBe('2026-11-02');
  });

  it('keeps every line in order, with 0% and 5% VAT as they were', () => {
    const items = [
      { description: 'Design', quantity: 1.5, unit_price: 12_345, tax_rate: 0.05 },
      { description: 'Postage', quantity: 3, unit_price: 99, tax_rate: 0 },
      { description: 'Print', quantity: 1, unit_price: 0, tax_rate: 0.2 },
    ];
    const { initial, warnings } = duplicateInvoice({ ...source, items }, '2026-11-02');
    expect(initial.items).toEqual(items);
    expect(warnings).toEqual([]);
  });

  it('counts the payment term in days across month ends and a leap day', () => {
    expect(duplicateInvoice({ ...source, issue_date: '2026-01-31', due_date: '2026-03-02' }, '2028-02-15').initial.due_date)
      .toBe('2028-03-16');
    expect(duplicateInvoice(source, '2026-12-25').initial.due_date).toBe('2027-01-08');
  });

  it('makes a duplicate of an invoice due before its issue date due today', () => {
    expect(duplicateInvoice({ ...source, due_date: '2026-08-20' }, '2026-11-02').initial.due_date).toBe('2026-11-02');
  });

  it('doesn’t carry over anything but the client, dates, notes and lines', () => {
    const extra = { ...source, status: 'paid', invoice_number: 'INV-2026-0007', amount_paid: 120_000 };
    expect(Object.keys(duplicateInvoice(extra, '2026-11-02').initial).sort())
      .toEqual(['client_id', 'due_date', 'issue_date', 'items', 'notes']);
  });

  it('empties a QuickBooks import’s “Imported from QuickBooks” line so the work gets described', () => {
    const { initial, warnings } = duplicateInvoice({
      ...source,
      items: [{ description: 'Imported from QuickBooks', quantity: 1, unit_price: 90_000, tax_rate: 0.2 }],
    }, '2026-11-02');
    expect(initial.items).toEqual([{ description: '', quantity: 1, unit_price: 90_000, tax_rate: 0.2 }]);
    expect(warnings).toEqual([expect.stringContaining('describe the work')]);
  });

  it('keeps a line that only mentions QuickBooks', () => {
    const items = [{ description: 'Imported from QuickBooks: consultancy', quantity: 1, unit_price: 100, tax_rate: 0.2 }];
    expect(duplicateInvoice({ ...source, items }, '2026-11-02').initial.items[0].description)
      .toBe('Imported from QuickBooks: consultancy');
  });

  it('lists both warnings when both apply', () => {
    const items = [{ description: 'Imported from QuickBooks', quantity: 1, unit_price: 100, tax_rate: 0.15 }];
    expect(duplicateInvoice({ ...source, items }, '2026-11-02').warnings).toHaveLength(2);
  });
});
