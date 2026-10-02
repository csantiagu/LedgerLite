import { zipSync } from 'fflate';
import { buildXlsx, type Cell, type Row, type Sheet } from './xlsx';

type TxnRow = {
  id: string;
  date: string;
  account_name: string | null;
  description: string;
  reference: string | null;
  amount: number;
  category: string | null;
  notes: string | null;
  attachment_r2_key: string | null;
  attachment_filename: string | null;
  match_type: 'invoice' | 'bill' | null;
  match_label: string | null;
};

type InvoiceRow = {
  invoice_number: string; client_name: string; issue_date: string; due_date: string;
  subtotal: number; tax_amount: number; total: number; amount_paid: number; status: string;
};

type BillRow = {
  id: string; vendor_name: string; bill_number: string | null; issue_date: string | null;
  subtotal: number; tax_amount: number; total: number; amount_paid: number; status: string;
  category: string | null; attachment_r2_key: string | null; attachment_filename: string | null;
};

export type AccountantExport = { filename: string; contentType: string; body: Uint8Array };

const UNEXPLAINED = 'UNEXPLAINED';

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
    SELECT t.id, t.date, ba.name as account_name, t.description, t.reference, t.amount,
           ec.name as category, t.notes, t.attachment_r2_key, t.attachment_filename,
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

  const { results: invoices } = await db.prepare(`
    SELECT i.invoice_number, c.name as client_name, i.issue_date, i.due_date,
           i.subtotal, i.tax_amount, i.total, i.amount_paid, i.status
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

  const txnHeader = ['Date', 'Account', 'Description', 'Reference', 'Money in', 'Money out',
    'Category', 'Explanation', 'Matched to', 'Receipt', 'Status'];
  const txnCols = [11, 18, 40, 16, 12, 12, 26, 40, 30, 30, 13];
  const txnRow = (t: TxnRow): Cell[] => {
    const cat = categoryFor(t);
    return [
      { date: t.date }, t.account_name ?? '', t.description, t.reference ?? '',
      t.amount > 0 ? { money: t.amount } : null,
      t.amount < 0 ? { money: -t.amount } : null,
      cat === UNEXPLAINED ? '' : cat,
      t.notes ?? '', t.match_label ?? '',
      receiptName.get(t.id) ?? '',
      cat === UNEXPLAINED ? UNEXPLAINED : 'Explained',
    ];
  };

  const unexplained = txns.filter((t) => categoryFor(t) === UNEXPLAINED);

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
      { bold: true, cells: ['Bank lines by category', 'Money in', 'Money out', 'Lines'] },
      ...categoryRows,
      { bold: true, cells: ['Total', { money: totalIn }, { money: totalOut }, txns.length] },
      [],
      { bold: true, cells: ['Invoices & bills raised in period', 'Net', 'VAT', 'Gross'] },
      [`Sales invoices (${liveInvoices.length})`,
        { money: sum(liveInvoices, (i) => i.subtotal) },
        { money: sum(liveInvoices, (i) => i.tax_amount) },
        { money: sum(liveInvoices, (i) => i.total) }],
      [`Supplier bills (${bills.length})`,
        { money: sum(bills, (b) => b.subtotal) },
        { money: sum(bills, (b) => b.tax_amount) },
        { money: sum(bills, (b) => b.total) }],
    ],
  };

  const sheets: Sheet[] = [
    summary,
    { name: 'Bank transactions', header: txnHeader, columns: txnCols, rows: txns.map(txnRow) },
  ];
  if (unexplained.length) {
    sheets.push({ name: 'Unexplained', header: txnHeader, columns: txnCols, rows: unexplained.map(txnRow) });
  }
  sheets.push({
    name: 'Sales invoices',
    header: ['Invoice', 'Client', 'Issued', 'Due', 'Net', 'VAT', 'Gross', 'Paid', 'Outstanding', 'Status'],
    columns: [15, 28, 11, 11, 12, 12, 12, 12, 12, 10],
    rows: invoices.map((i) => [
      i.invoice_number, i.client_name, { date: i.issue_date }, { date: i.due_date },
      { money: i.subtotal }, { money: i.tax_amount }, { money: i.total },
      { money: i.amount_paid }, { money: i.status === 'void' ? 0 : i.total - i.amount_paid }, i.status,
    ]),
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
