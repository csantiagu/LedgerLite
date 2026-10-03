import { describe, expect, it } from 'vitest';
import { planImport, suggestNumbering, type ImportRow } from '../../src/services/invoiceImport';

const row = (over: Partial<ImportRow> = {}): ImportRow => ({
  invoiceNumber: '1001', customer: 'Bright Tech', issueDate: '2025-04-10', dueDate: '2025-05-10',
  total: 120_000, subtotal: 100_000, taxAmount: 20_000, openBalance: 0, ...over,
});
const plan = (rows: ImportRow[], numbers: string[] = [], customers: string[] = []) =>
  planImport(rows, new Set(numbers), new Set(customers));

describe('planImport', () => {
  it('turns a paid invoice into one line and one payment on the invoice date', () => {
    const { invoices, outcomes } = plan([row()]);
    expect(invoices).toEqual([expect.objectContaining({
      invoiceNumber: '1001', status: 'paid', subtotal: 100_000, taxAmount: 20_000, total: 120_000,
      amountPaid: 120_000, taxRate: 0.2, paymentDate: '2025-04-10', description: 'Imported from QuickBooks',
    })]);
    expect(outcomes[0]).toMatchObject({ action: 'create', newCustomer: true });
    expect(outcomes[0].action === 'create' && outcomes[0].warnings).toEqual(['No payment date: payment recorded on the invoice date']);
  });

  it('works out the status from the open balance', () => {
    const { invoices } = plan([
      row({ invoiceNumber: 'a', openBalance: 120_000 }),
      row({ invoiceNumber: 'b', openBalance: 20_000, paymentDate: '2025-05-01' }),
    ]);
    expect(invoices.map(i => [i.status, i.amountPaid, i.paymentDate])).toEqual([
      ['sent', 0, '2025-04-10'], ['partial', 100_000, '2025-05-01'],
    ]);
  });

  it('fills in net or VAT from the total, and warns when there is no VAT at all', () => {
    const { invoices, outcomes } = plan([
      row({ invoiceNumber: 'a', subtotal: null }),
      row({ invoiceNumber: 'b', taxAmount: null }),
      row({ invoiceNumber: 'c', subtotal: null, taxAmount: null }),
    ]);
    expect(invoices.map(i => [i.subtotal, i.taxAmount])).toEqual([[100_000, 20_000], [100_000, 20_000], [120_000, 0]]);
    expect(outcomes[2].action === 'create' && outcomes[2].warnings[0]).toMatch(/No VAT/);
  });

  it('skips rows it cannot import, with a reason', () => {
    const { invoices, outcomes } = plan([
      row({ invoiceNumber: '' }),
      row({ invoiceNumber: 'neg', total: -5_000, subtotal: null, taxAmount: null }),
      row({ invoiceNumber: 'sum', taxAmount: 19_999 }),
      row({ invoiceNumber: 'date', issueDate: '10/04/2025' }),
      row({ invoiceNumber: 'open', openBalance: 999_999 }),
      row({ invoiceNumber: 'old' }),
      row({ invoiceNumber: 'twice' }), row({ invoiceNumber: 'twice' }),
    ], ['old']);
    expect(invoices.map(i => i.invoiceNumber)).toEqual(['twice']);
    expect(outcomes.filter(o => o.action === 'skip').map(o => o.action === 'skip' && o.reason)).toEqual([
      'No invoice number',
      'Credit notes and zero-value invoices are not imported',
      'Net + VAT does not add up to the total',
      'Invoice date is missing or not a date',
      'Open balance must be between 0 and the total',
      'Already in LedgerLite',
      'Appears twice in this file',
    ]);
  });

  it('matches existing customers ignoring case and spacing', () => {
    const { outcomes } = plan([row({ customer: '  BRIGHT   tech ' })], [], ['bright tech']);
    expect(outcomes[0]).toMatchObject({ action: 'create', newCustomer: false, customer: 'BRIGHT tech' });
  });
});

describe('suggestNumbering', () => {
  it('continues plain and prefixed sequences', () => {
    expect(suggestNumbering(['1001', '1043', '1002'])).toEqual({ prefix: '', next: 1044 });
    expect(suggestNumbering(['INV-0042', 'INV-0043'])).toEqual({ prefix: 'INV', next: 44 });
  });

  it('gives up on mixed patterns', () => {
    expect(suggestNumbering(['INV-1', 'ABC-2'])).toBeNull();
    expect(suggestNumbering([])).toBeNull();
  });
});
