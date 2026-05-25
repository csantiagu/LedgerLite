import { zipSync, strToU8 } from 'fflate';

export function assembleYearEndZip(data: {
  incomeRows: string[][];
  expenseRows: string[][];
  transactionRows: string[][];
  flaggedRows: string[][];
  invoicePdfs: Array<{ name: string; data: Uint8Array }>;
  summaryPdf: Uint8Array;
}): Uint8Array {
  const toCsv = (rows: string[][]): Uint8Array =>
    strToU8(rows.map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\n'));

  const files: Record<string, Uint8Array> = {
    'income.csv': toCsv(data.incomeRows),
    'expenses.csv': toCsv(data.expenseRows),
    'transactions.csv': toCsv(data.transactionRows),
    'flagged-items.csv': toCsv(data.flaggedRows),
    'summary.pdf': data.summaryPdf,
  };

  for (const pdf of data.invoicePdfs) {
    files[`invoices/${pdf.name}`] = pdf.data;
  }

  return zipSync(files, { level: 6 });
}
