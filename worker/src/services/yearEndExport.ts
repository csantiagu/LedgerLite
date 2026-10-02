import { zipSync, strToU8 } from 'fflate';

export function assembleYearEndZip(data: {
  incomeRows: string[][];
  expenseRows: string[][];
  accountTransactions: Array<{ accountName: string; rows: string[][] }>;
  flaggedRows: string[][];
  invoiceRegisterRows: string[][];
  billRegisterRows: string[][];
  invoicePdfs: Array<{ name: string; data: Uint8Array }>;
  billAttachments: Array<{ name: string; data: Uint8Array }>;
  expenseReceipts: Array<{ name: string; data: Uint8Array }>;
  summaryPdf: Uint8Array;
}): Uint8Array {
  const toCsv = (rows: string[][]): Uint8Array =>
    strToU8(rows.map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\n'));

  const files: Record<string, Uint8Array> = {
    'income.csv': toCsv(data.incomeRows),
    'expenses.csv': toCsv(data.expenseRows),
    'invoices-register.csv': toCsv(data.invoiceRegisterRows),
    'bills-register.csv': toCsv(data.billRegisterRows),
    'flagged-items.csv': toCsv(data.flaggedRows),
    'summary.pdf': data.summaryPdf,
  };

  for (const account of data.accountTransactions) {
    const safeName = account.accountName.replace(/[^a-z0-9]/gi, '-').toLowerCase();
    files[`transactions/${safeName}.csv`] = toCsv(account.rows);
  }

  for (const pdf of data.invoicePdfs) {
    files[`invoices-sent/${pdf.name}`] = pdf.data;
  }

  for (const att of data.billAttachments) {
    files[`bills-received/${att.name}`] = att.data;
  }

  for (const receipt of data.expenseReceipts) {
    files[`expense-receipts/${receipt.name}`] = receipt.data;
  }

  return zipSync(files, { level: 6 });
}
