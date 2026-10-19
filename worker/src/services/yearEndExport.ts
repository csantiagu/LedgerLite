import { zipSync, strToU8 } from 'fflate';

/** Quote a CSV cell. Spreadsheet formulas are prefixed so Excel treats them as text. */
export function csvCell(value: unknown): string {
  let s = String(value ?? '');
  // Amounts we generated ("-12.50") stay numeric. Anything else that a spreadsheet
  // would execute is text.
  if (!/^-?\d+(\.\d+)?$/.test(s) && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
}

/**
 * A ZIP entry under `folder`. Invoice numbers and bill filenames come from imports
 * and can contain slashes or ".."; only the last path segment is kept, and the
 * result can never leave `folder`.
 */
export function zipEntryPath(folder: string, name: string, used: Set<string>): string {
  const base = name.split(/[/\\]/).filter(Boolean).pop() ?? 'file';
  let cleaned = base.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[-.]+/, '').slice(0, 80);
  if (!cleaned) cleaned = 'file';
  const dot = cleaned.lastIndexOf('.');
  const stem = dot > 0 ? cleaned.slice(0, dot) : cleaned;
  const ext = dot > 0 ? cleaned.slice(dot) : '';
  let path = `${folder}/${cleaned}`;
  let n = 2;
  while (used.has(path)) {
    path = `${folder}/${stem}-${n}${ext}`;
    n += 1;
  }
  used.add(path);
  return path;
}

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
    strToU8(rows.map((r) => r.map(csvCell).join(',')).join('\n'));
  const used = new Set<string>();

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
    files[zipEntryPath('invoices-sent', pdf.name, used)] = pdf.data;
  }

  for (const att of data.billAttachments) {
    files[zipEntryPath('bills-received', att.name, used)] = att.data;
  }

  for (const receipt of data.expenseReceipts) {
    files[zipEntryPath('expense-receipts', receipt.name, used)] = receipt.data;
  }

  return zipSync(files, { level: 6 });
}
