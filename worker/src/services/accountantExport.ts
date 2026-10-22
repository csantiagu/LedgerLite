import { zipSync } from 'fflate';
import { zipEntryPath } from './yearEndExport';
import { buildXlsx, type Cell, type Row, type Sheet } from './xlsx';
import { netOfVat, vatInGross } from './money';

type TxnRow = {
  id: string;
  date: string;
  bank_account_id: string | null;
  account_name: string | null;
  description: string;
  reference: string | null;
  amount: number;
  category: string | null;
  vat_rate: number | null;
  notes: string | null;
  attachment_r2_key: string | null;
  attachment_filename: string | null;
  match_type: 'invoice' | 'bill' | null;
  match_label: string | null;
};

type InvoiceRow = {
  id: string; pdf_r2_key: string | null; invoice_number: string; client_name: string; issue_date: string; due_date: string;
  subtotal: number; tax_amount: number; total: number; amount_paid: number; status: string; kind: string;
};

type BillRow = {
  id: string; vendor_name: string; bill_number: string | null; issue_date: string | null;
  subtotal: number; tax_amount: number; total: number; amount_paid: number; status: string;
  category: string | null; attachment_r2_key: string | null; attachment_filename: string | null;
};

export type AccountantExport = { filename: string; contentType: string; body: Uint8Array };

const UNEXPLAINED = 'UNEXPLAINED';
const VAT_NOT_SET = 'NOT SET';

function safeFilePart(s: string, max = 40): string {
  return s.replace(/[^a-z0-9.]+/gi, '-').replace(/^-+|-+$/g, '').slice(0, max) || 'file';
}

export async function buildAccountantExport(
  env: { DB: D1Database; R2: R2Bucket },
  from: string,
  to: string,
  includeReceipts: boolean,
): Promise<AccountantExport> {
  const db = env.DB;

  const company = await db.prepare(
    'SELECT company_name FROM company_settings WHERE id = 1'
  ).first<{ company_name: string | null }>();

  // One row per bank line; an accepted (pending/posted) match explains it just like a category does
  const { results: txns } = await db.prepare(`
    SELECT t.id, t.date, t.bank_account_id, ba.name as account_name, t.description, t.reference, t.amount,
           ec.name as category, t.vat_rate, t.notes, t.attachment_r2_key, t.attachment_filename,
           m.match_type,
           CASE m.match_type
             WHEN 'invoice' THEN i.invoice_number || ' — ' || cl.name
             WHEN 'bill'    THEN v.name || COALESCE(' · ' || b.bill_number, '')
           END as match_label
    FROM transactions t
    LEFT JOIN bank_accounts ba ON ba.id = t.bank_account_id
    LEFT JOIN expense_categories ec ON ec.id = t.expense_category_id
    LEFT JOIN transaction_matches m ON m.id = (
      SELECT tm.id FROM transaction_matches tm
      WHERE tm.transaction_id = t.id AND tm.status IN ('pending','posted')
      ORDER BY CASE tm.status WHEN 'posted' THEN 0 ELSE 1 END LIMIT 1)
    LEFT JOIN invoices i ON i.id = m.invoice_id
    LEFT JOIN clients cl ON cl.id = i.client_id
    LEFT JOIN bills b ON b.id = m.bill_id
    LEFT JOIN vendors v ON v.id = b.vendor_id
    WHERE t.date BETWEEN ? AND ?
    ORDER BY t.date ASC, ba.name ASC, t.created_at ASC
  `).bind(from, to).all<TxnRow>();

  // Each bank account gets its own sheet: every active account, plus any closed one with lines
  // in the period
  const { results: accounts } = await db.prepare(`
    SELECT ba.id, ba.name, ba.bank_name, ba.last_four FROM bank_accounts ba
    WHERE ba.is_active = 1
       OR EXISTS (SELECT 1 FROM transactions t WHERE t.bank_account_id = ba.id AND t.date BETWEEN ? AND ?)
    ORDER BY ba.name COLLATE NOCASE ASC, ba.created_at ASC
  `).bind(from, to).all<{ id: string; name: string; bank_name: string; last_four: string | null }>();

  // Every accepted match, with the invoice's/bill's net and gross so each line's VAT can be split
  const { results: matchRows } = await db.prepare(`
    SELECT tm.transaction_id, tm.allocated_amount,
           COALESCE(i.subtotal, b.subtotal) AS subtotal, COALESCE(i.total, b.total) AS total
    FROM transaction_matches tm
    JOIN transactions t ON t.id = tm.transaction_id
    LEFT JOIN invoices i ON i.id = tm.invoice_id
    LEFT JOIN bills b ON b.id = tm.bill_id
    WHERE tm.status IN ('pending','posted') AND t.date BETWEEN ? AND ?
  `).bind(from, to).all<{ transaction_id: string; allocated_amount: number; subtotal: number | null; total: number | null }>();
  const matchesByTxn = new Map<string, typeof matchRows>();
  for (const m of matchRows) {
    const list = matchesByTxn.get(m.transaction_id) ?? [];
    list.push(m);
    matchesByTxn.set(m.transaction_id, list);
  }

  const { results: invoices } = await db.prepare(`
    SELECT i.id, i.pdf_r2_key, i.invoice_number, c.name as client_name, i.issue_date, i.due_date,
           i.subtotal, i.tax_amount, i.total, i.amount_paid, i.status, i.kind
    FROM invoices i JOIN clients c ON c.id = i.client_id
    WHERE i.status != 'draft' AND i.issue_date BETWEEN ? AND ?
    ORDER BY i.issue_date ASC, i.invoice_number ASC
  `).bind(from, to).all<InvoiceRow>();

  const { results: bills } = await db.prepare(`
    SELECT b.id, v.name as vendor_name, b.bill_number, b.issue_date,
           b.subtotal, b.tax_amount, b.total, b.amount_paid, b.status,
           (SELECT CASE WHEN COUNT(DISTINCT bi.expense_category_id) > 1 THEN 'Multiple'
                        ELSE MAX(ec.name) END
            FROM bill_items bi LEFT JOIN expense_categories ec ON ec.id = bi.expense_category_id
            WHERE bi.bill_id = b.id) as category,
           b.attachment_r2_key, b.attachment_filename
    FROM bills b JOIN vendors v ON v.id = b.vendor_id
    WHERE b.status != 'void'
      AND COALESCE(b.issue_date, substr(b.created_at, 1, 10)) BETWEEN ? AND ?
    ORDER BY COALESCE(b.issue_date, b.created_at) ASC
  `).bind(from, to).all<BillRow>();

  // Receipt filenames are assigned up front so the sheet can point at files in the ZIP
  const receipts: Array<{ zipPath: string; r2Key: string }> = [];
  const receiptName = new Map<string, string>();
  for (const t of txns) {
    if (!t.attachment_r2_key) continue;
    const name = `receipts/${t.date}_${safeFilePart(t.description)}_${safeFilePart(t.attachment_filename ?? 'receipt', 60)}`;
    receiptName.set(t.id, name);
    receipts.push({ zipPath: name, r2Key: t.attachment_r2_key });
  }
  // Invoice PDFs: the one we generated on finalising, or the original uploaded for a QuickBooks one
  const usedInvoicePaths = new Set<string>();
  for (const i of invoices) {
    if (!i.pdf_r2_key) continue;
    const name = zipEntryPath('invoices', `${i.invoice_number.replace(/[/\\]/g, '-')}.pdf`, usedInvoicePaths);
    receiptName.set(i.id, name);
    receipts.push({ zipPath: name, r2Key: i.pdf_r2_key });
  }
  for (const b of bills) {
    if (!b.attachment_r2_key) continue;
    const name = `bills/${b.issue_date ?? 'undated'}_${safeFilePart(b.vendor_name)}_${safeFilePart(b.attachment_filename ?? 'bill', 60)}`;
    receiptName.set(b.id, name);
    receipts.push({ zipPath: name, r2Key: b.attachment_r2_key });
  }

  // ── Bank transactions ────────────────────────────────────────────
  const categoryFor = (t: TxnRow): string =>
    t.category
    ?? (t.match_type === 'invoice' ? 'Sales invoice payment'
      : t.match_type === 'bill' ? 'Supplier bill payment'
      : UNEXPLAINED);

  // VAT inside each line (as a positive amount, like Money in / Money out): matched parts take
  // the invoice's/bill's VAT share, and the rest the rate chosen on the line. Unknown when the
  // rest has no rate yet.
  const vatFor = (t: TxnRow): { label: string; vat: number | null } => {
    const gross = Math.abs(t.amount);
    const matches = matchesByTxn.get(t.id) ?? [];
    let vat = 0, allocated = 0, fromDocs = false;
    for (const m of matches) {
      allocated += m.allocated_amount;
      const share = m.allocated_amount - netOfVat(m.allocated_amount, m.subtotal ?? 0, m.total ?? 0);
      vat += share;
      fromDocs = true;
    }
    const rest = Math.max(0, gross - allocated);
    if (rest === 0 && fromDocs) return { label: 'Per invoice/bill', vat };
    if (!t.category) return { label: '', vat: null };
    if (t.vat_rate === null) return { label: VAT_NOT_SET, vat: null };
    vat += vatInGross(rest, t.vat_rate);
    const rate = t.vat_rate === 0 ? 'No VAT' : `${Math.round(t.vat_rate * 10000) / 100}% included`;
    return { label: fromDocs ? `${rate} + invoice/bill` : rate, vat };
  };

  // The combined sheets (Unexplained, VAT not set) say which account a line is from; an
  // account's own sheet doesn't need to
  const txnHeader = ['Date', 'Account', 'Description', 'Reference', 'Money in', 'Money out',
    'Category', 'VAT', 'Net', 'VAT amount', 'Explanation', 'Matched to', 'Receipt', 'Status'];
  const txnCols = [11, 18, 40, 16, 12, 12, 26, 18, 12, 12, 40, 30, 30, 13];
  const accountHeader = txnHeader.filter((h) => h !== 'Account');
  const accountCols = txnCols.filter((_, i) => i !== 1);
  const txnRow = (t: TxnRow, withAccount = true): Cell[] => {
    const cat = categoryFor(t);
    const { label, vat } = vatFor(t);
    return [
      { date: t.date }, ...(withAccount ? [t.account_name ?? ''] : []), t.description, t.reference ?? '',
      t.amount > 0 ? { money: t.amount } : null,
      t.amount < 0 ? { money: -t.amount } : null,
      cat === UNEXPLAINED ? '' : cat,
      label,
      vat === null ? null : { money: Math.abs(t.amount) - vat },
      vat === null ? null : { money: vat },
      t.notes ?? '', t.match_label ?? '',
      receiptName.get(t.id) ?? '',
      cat === UNEXPLAINED ? UNEXPLAINED : 'Explained',
    ];
  };

  const unexplained = txns.filter((t) => categoryFor(t) === UNEXPLAINED);
  const vatMissing = txns.filter((t) => vatFor(t).label === VAT_NOT_SET);
  let vatIn = 0, vatOut = 0;
  for (const t of txns) {
    const { vat } = vatFor(t);
    if (vat === null) continue;
    if (t.amount > 0) vatIn += vat; else vatOut += vat;
  }

  // ── Summary ──────────────────────────────────────────────────────
  const byCategory = new Map<string, { inP: number; outP: number; count: number }>();
  let totalIn = 0, totalOut = 0;
  for (const t of txns) {
    const key = categoryFor(t);
    const agg = byCategory.get(key) ?? { inP: 0, outP: 0, count: 0 };
    if (t.amount > 0) { agg.inP += t.amount; totalIn += t.amount; }
    else { agg.outP -= t.amount; totalOut -= t.amount; }
    agg.count += 1;
    byCategory.set(key, agg);
  }
  const categoryRows: Row[] = [...byCategory.entries()]
    .sort(([a], [b]) => (a === UNEXPLAINED ? 1 : b === UNEXPLAINED ? -1 : a.localeCompare(b)))
    .map(([name, agg]) => [name, { money: agg.inP }, { money: agg.outP }, agg.count]);

  // Lines per account, in the order of the account sheets; lines with no account go last
  const NO_ACCOUNT = 'No bank account';
  const byAccount = new Map<string, TxnRow[]>();
  for (const a of accounts) byAccount.set(a.id, []);
  for (const t of txns) {
    const key = t.bank_account_id && byAccount.has(t.bank_account_id) ? t.bank_account_id : NO_ACCOUNT;
    if (!byAccount.has(key)) byAccount.set(key, []);
    byAccount.get(key)!.push(t);
  }
  const accountName = (id: string) => {
    const a = accounts.find((x) => x.id === id);
    return a ? a.name : NO_ACCOUNT;
  };
  const totalsOf = (rows: TxnRow[]) => ({
    inP: rows.reduce((acc, t) => acc + (t.amount > 0 ? t.amount : 0), 0),
    outP: rows.reduce((acc, t) => acc + (t.amount < 0 ? -t.amount : 0), 0),
  });
  const accountRows: Row[] = [...byAccount.entries()].map(([id, rows]) => {
    const tot = totalsOf(rows);
    return [accountName(id), { money: tot.inP }, { money: tot.outP }, rows.length];
  });

  const sum = <T,>(rows: T[], f: (r: T) => number) => rows.reduce((acc, r) => acc + f(r), 0);
  const liveInvoices = invoices.filter((i) => i.status !== 'void');

  const summary: Sheet = {
    name: 'Summary',
    columns: [34, 16, 16, 10],
    rows: [
      { bold: true, cells: [company?.company_name || 'Bank transactions for accountant'] },
      ['Period', `${from} to ${to}`],
      ['Generated', new Date().toISOString().slice(0, 10)],
      [],
      ['Bank lines', txns.length],
      ['Explained', txns.length - unexplained.length],
      [unexplained.length ? 'UNEXPLAINED (see sheet)' : 'Unexplained', unexplained.length],
      ['Total money in', { money: totalIn }],
      ['Total money out', { money: totalOut }],
      [],
      { bold: true, cells: ['VAT on bank lines', 'VAT'] },
      ['VAT in money received', { money: vatIn }],
      ['VAT in money paid out', { money: vatOut }],
      [vatMissing.length ? 'VAT NOT SET (see sheet)' : 'VAT not set', vatMissing.length],
      [],
      { bold: true, cells: ['Bank lines by account (one sheet each)', 'Money in', 'Money out', 'Lines'] },
      ...accountRows,
      { bold: true, cells: ['Total', { money: totalIn }, { money: totalOut }, txns.length] },
      [],
      { bold: true, cells: ['Bank lines by category', 'Money in', 'Money out', 'Lines'] },
      ...categoryRows,
      { bold: true, cells: ['Total', { money: totalIn }, { money: totalOut }, txns.length] },
      [],
      { bold: true, cells: ['Invoices & bills raised in period', 'Net', 'VAT', 'Gross'] },
      // Net of credit notes
      [`Sales invoices and credit notes (${liveInvoices.length})`,
        { money: sum(liveInvoices, (i) => (i.kind === 'credit_note' ? -1 : 1) * i.subtotal) },
        { money: sum(liveInvoices, (i) => (i.kind === 'credit_note' ? -1 : 1) * i.tax_amount) },
        { money: sum(liveInvoices, (i) => (i.kind === 'credit_note' ? -1 : 1) * i.total) }],
      [`Supplier bills (${bills.length})`,
        { money: sum(bills, (b) => b.subtotal) },
        { money: sum(bills, (b) => b.tax_amount) },
        { money: sum(bills, (b) => b.total) }],
    ],
  };

  // One sheet per bank account, named after it, with its totals at the foot
  const sheets: Sheet[] = [summary];
  for (const [id, rows] of byAccount) {
    const tot = totalsOf(rows);
    const totalRow: Cell[] = accountHeader.map(() => null);
    totalRow[0] = rows.length ? `Total (${rows.length} line${rows.length === 1 ? '' : 's'})` : 'No transactions in this period';
    totalRow[accountHeader.indexOf('Money in')] = { money: tot.inP };
    totalRow[accountHeader.indexOf('Money out')] = { money: tot.outP };
    sheets.push({
      name: accountName(id),
      header: accountHeader,
      columns: accountCols,
      rows: rows.map((t) => txnRow(t, false)),
      footer: [{ bold: true, cells: totalRow }],
    });
  }
  if (unexplained.length) {
    sheets.push({ name: 'Unexplained', header: txnHeader, columns: txnCols, rows: unexplained.map((t) => txnRow(t)) });
  }
  if (vatMissing.length) {
    sheets.push({ name: 'VAT not set', header: txnHeader, columns: txnCols, rows: vatMissing.map((t) => txnRow(t)) });
  }
  sheets.push({
    name: 'Sales invoices',
    header: ['Invoice', 'Client', 'Issued', 'Due', 'Net', 'VAT', 'Gross', 'Paid', 'Outstanding', 'Status', 'PDF'],
    columns: [15, 28, 11, 11, 12, 12, 12, 12, 12, 10, 30],
    // Credit notes are shown negative, so each column adds up to the net sales
    rows: invoices.map((i) => {
      const sign = i.kind === 'credit_note' ? -1 : 1;
      return [
        i.invoice_number, i.client_name, { date: i.issue_date }, { date: i.due_date },
        { money: sign * i.subtotal }, { money: sign * i.tax_amount }, { money: sign * i.total },
        { money: sign * i.amount_paid }, { money: i.status === 'void' ? 0 : sign * (i.total - i.amount_paid) },
        i.kind === 'credit_note' ? `credit note (${i.status})` : i.status,
        receiptName.get(i.id) ?? '',
      ];
    }),
  });
  sheets.push({
    name: 'Supplier bills',
    header: ['Supplier', 'Bill no.', 'Date', 'Category', 'Net', 'VAT', 'Gross', 'Paid', 'Status', 'Attachment'],
    columns: [28, 14, 11, 24, 12, 12, 12, 12, 10, 34],
    rows: bills.map((b) => [
      b.vendor_name, b.bill_number ?? '', b.issue_date ? { date: b.issue_date } : '', b.category ?? '',
      { money: b.subtotal }, { money: b.tax_amount }, { money: b.total },
      { money: b.amount_paid }, b.status, receiptName.get(b.id) ?? '',
    ]),
  });

  const xlsx = buildXlsx(sheets);
  const base = `accounts-${from}-to-${to}`;

  if (!includeReceipts) {
    return {
      filename: `${base}.xlsx`,
      contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      body: xlsx,
    };
  }

  const files: Record<string, Uint8Array> = { [`${base}.xlsx`]: xlsx };
  for (const r of receipts) {
    const obj = await env.R2.get(r.r2Key);
    if (obj) files[r.zipPath] = new Uint8Array(await obj.arrayBuffer());
  }
  return { filename: `${base}.zip`, contentType: 'application/zip', body: zipSync(files, { level: 6 }) };
}
