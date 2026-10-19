import { strFromU8, unzipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { assembleYearEndZip } from '../../src/services/yearEndExport';

const empty = new Uint8Array();

describe('year-end export', () => {
  it('neutralises spreadsheet formulas and keeps generated amounts numeric', () => {
    const zip = assembleYearEndZip({
      incomeRows: [['client_name'], ['=cmd|'], ['-12.50']],
      expenseRows: [],
      accountTransactions: [],
      flaggedRows: [],
      invoiceRegisterRows: [],
      billRegisterRows: [],
      invoicePdfs: [],
      billAttachments: [],
      expenseReceipts: [],
      summaryPdf: empty,
    });
    const csv = strFromU8(unzipSync(zip)['income.csv']);
    expect(csv).toContain(`"'=cmd|"`);
    expect(csv).toContain('"-12.50"');
  });

  it('keeps invoice filenames inside invoices-sent', () => {
    const zip = assembleYearEndZip({
      incomeRows: [],
      expenseRows: [],
      accountTransactions: [],
      flaggedRows: [],
      invoiceRegisterRows: [],
      billRegisterRows: [],
      invoicePdfs: [{ name: '../../outside.pdf', data: new Uint8Array([1]) }],
      billAttachments: [{ name: '..\\bills.pdf', data: new Uint8Array([2]) }],
      expenseReceipts: [],
      summaryPdf: empty,
    });
    const names = Object.keys(unzipSync(zip));
    expect(names).toContain('invoices-sent/outside.pdf');
    expect(names).toContain('bills-received/bills.pdf');
    expect(names.some(name => name.includes('..'))).toBe(false);
  });
});
