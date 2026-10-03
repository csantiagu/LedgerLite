// Reads an invoice list exported from QuickBooks Online (CSV or Excel), finds the header row
// (QuickBooks puts the company name and report title above it, and a TOTAL row below), and
// turns each invoice row into what POST /api/v1/invoice-imports expects. Money is parsed from
// text into integer pence without floating point.

import { unzipSync, strFromU8 } from 'fflate';

export type Field =
  | 'invoiceNumber' | 'customer' | 'issueDate' | 'dueDate' | 'total'
  | 'subtotal' | 'taxAmount' | 'openBalance' | 'paymentDate' | 'memo' | 'type';

export const FIELDS: { field: Field; label: string; required?: boolean }[] = [
  { field: 'invoiceNumber', label: 'Invoice number', required: true },
  { field: 'customer',      label: 'Customer', required: true },
  { field: 'issueDate',     label: 'Invoice date', required: true },
  { field: 'total',         label: 'Total (incl. VAT)', required: true },
  { field: 'dueDate',       label: 'Due date' },
  { field: 'subtotal',      label: 'Net (excl. VAT)' },
  { field: 'taxAmount',     label: 'VAT' },
  { field: 'openBalance',   label: 'Open balance (still owed)' },
  { field: 'paymentDate',   label: 'Payment date' },
  { field: 'memo',          label: 'Memo / description' },
  { field: 'type',          label: 'Transaction type' },
];

// Column headings QuickBooks Online uses (and common variants), lower-cased
const ALIASES: Record<Field, string[]> = {
  invoiceNumber: ['no.', 'no', 'num', 'number', 'invoice no', 'invoice no.', 'invoice number', 'invoice #', 'ref no.', 'ref no'],
  customer:      ['customer', 'customer name', 'customer full name', 'name', 'client'],
  issueDate:     ['date', 'invoice date', 'transaction date', 'txn date'],
  dueDate:       ['due date', 'due'],
  total:         ['amount', 'total', 'total amount', 'invoice amount', 'amount (gbp)', 'total (gbp)'],
  subtotal:      ['net', 'net amount', 'subtotal', 'amount excl. vat', 'amount (excl. vat)', 'taxable amount'],
  taxAmount:     ['vat', 'vat amount', 'tax', 'tax amount', 'sales tax'],
  openBalance:   ['open balance', 'balance', 'balance due', 'amount due', 'open bal'],
  paymentDate:   ['payment date', 'date paid', 'paid date', 'last payment date'],
  memo:          ['memo', 'memo/description', 'description', 'message', 'message on invoice'],
  type:          ['transaction type', 'type'],
};

const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ');

// ── Reading files ─────────────────────────────────────────────────────────────

export async function readTable(file: File): Promise<string[][]> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const isZip = bytes[0] === 0x50 && bytes[1] === 0x4b; // .xlsx files are zip archives
  return isZip ? readXlsx(bytes) : parseCsv(new TextDecoder().decode(bytes));
}

export function parseCsv(text: string): string[][] {
  const src = text.replace(/^﻿/, '');
  const firstLine = src.split(/\r?\n/, 1)[0] ?? '';
  const delimiter = [',', ';', '\t'].reduce((best, d) =>
    firstLine.split(d).length > firstLine.split(best).length ? d : best, ',');

  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === delimiter) { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += ch;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

function readXlsx(bytes: Uint8Array): string[][] {
  const files = unzipSync(bytes, { filter: f => f.name.startsWith('xl/') });
  const xml = (name: string) => files[name] && new DOMParser().parseFromString(strFromU8(files[name]), 'application/xml');

  const shared = xml('xl/sharedStrings.xml');
  const strings = shared
    ? Array.from(shared.getElementsByTagName('si'), si => Array.from(si.getElementsByTagName('t'), t => t.textContent ?? '').join(''))
    : [];

  // The first sheet listed in the workbook
  const workbook = xml('xl/workbook.xml');
  const rels = xml('xl/_rels/workbook.xml.rels');
  const firstSheet = workbook?.getElementsByTagName('sheet')[0];
  const relId = firstSheet?.getAttribute('r:id');
  const target = rels && relId
    ? Array.from(rels.getElementsByTagName('Relationship')).find(r => r.getAttribute('Id') === relId)?.getAttribute('Target')
    : null;
  const sheetPath = target ? `xl/${target.replace(/^\/?xl\//, '')}` : 'xl/worksheets/sheet1.xml';
  const sheet = xml(sheetPath);
  if (!sheet) throw new Error('Could not read the first sheet of this Excel file');

  // Empty rows aren't stored at all, so place each row by its own number (r="7") to keep line
  // numbers matching what the user sees in Excel
  const rows: string[][] = [];
  for (const r of Array.from(sheet.getElementsByTagName('row'))) {
    const rowNumber = Number(r.getAttribute('r')) || rows.length + 1;
    while (rows.length < rowNumber - 1) rows.push([]);
    const out: string[] = [];
    for (const c of Array.from(r.getElementsByTagName('c'))) {
      const ref = c.getAttribute('r') ?? '';
      const letters = ref.replace(/\d+$/, '');
      const col = letters ? [...letters].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1 : out.length;
      const type = c.getAttribute('t');
      const v = c.getElementsByTagName('v')[0]?.textContent ?? '';
      out[col] = type === 's' ? strings[Number(v)] ?? ''
        : type === 'inlineStr' ? Array.from(c.getElementsByTagName('t'), t => t.textContent ?? '').join('')
        : v;
    }
    rows.push(Array.from(out, x => x ?? ''));
  }
  return rows;
}

// ── Finding and mapping columns ───────────────────────────────────────────────

export type Mapping = Partial<Record<Field, number>>;

/** The header row: the first row that names both an invoice number and a customer column. */
export function findHeader(table: string[][]): { headerRow: number; mapping: Mapping } | null {
  for (let i = 0; i < Math.min(table.length, 30); i++) {
    const cells = table[i].map(norm);
    const mapping: Mapping = {};
    for (const { field } of FIELDS) {
      const idx = cells.findIndex(c => ALIASES[field].includes(c));
      if (idx >= 0) mapping[field] = idx;
    }
    if (mapping.invoiceNumber !== undefined && mapping.customer !== undefined) return { headerRow: i, mapping };
  }
  return null;
}

// ── Values ────────────────────────────────────────────────────────────────────

/** "£1,234.50", "1234.5", "(12.00)" or an Excel number → pence; null when empty. */
export function parsePence(raw: string | undefined): number | null {
  const s = (raw ?? '').trim().replace(/[£,\s]/g, '').replace(/^GBP/i, '');
  if (!s || s === '-') return null;
  const negative = /^\(.*\)$/.test(s) || s.startsWith('-');
  const digits = s.replace(/^[(-]+|\)$/g, '');
  // Excel can store 1234.5 as 1234.4999999999; round the third decimal place
  const m = /^(\d+)(?:\.(\d+))?$/.exec(digits);
  if (!m) return NaN;
  const pounds = Number(m[1]);
  const frac = (m[2] ?? '').padEnd(3, '0');
  const pence = pounds * 100 + Number(frac.slice(0, 2)) + (Number(frac[2]) >= 5 ? 1 : 0);
  return negative ? -pence : pence;
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const iso = (y: number, m: number, d: number) => {
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d
    ? `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}` : null;
};

/** UK dates (dd/mm/yyyy), ISO dates, "10 Apr 2025" and Excel serial numbers → YYYY-MM-DD. */
export function parseDate(raw: string | undefined): string | null {
  const s = (raw ?? '').trim();
  if (!s) return null;
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s);
  if (m) return iso(+m[1], +m[2], +m[3]);
  m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2}|\d{4})$/.exec(s);
  if (m) return iso(m[3].length === 2 ? 2000 + +m[3] : +m[3], +m[2], +m[1]);
  m = /^(\d{1,2})[\s-]([A-Za-z]{3})[A-Za-z]*[\s-](\d{4})$/.exec(s);
  if (m && MONTHS.includes(m[2].toLowerCase())) return iso(+m[3], MONTHS.indexOf(m[2].toLowerCase()) + 1, +m[1]);
  if (/^\d{5}(\.\d+)?$/.test(s)) {
    // Excel serial date (days since 1899-12-30)
    const d = new Date(Date.UTC(1899, 11, 30) + Math.floor(Number(s)) * 86_400_000);
    return d.toISOString().slice(0, 10);
  }
  return null;
}

// ── Building import rows ──────────────────────────────────────────────────────

export interface ImportRow {
  invoiceNumber: string; customer: string; issueDate: string; dueDate: string | null;
  total: number; subtotal: number | null; taxAmount: number | null; openBalance: number;
  paymentDate: string | null; memo: string | null;
}

export interface Prepared {
  rows: ImportRow[];
  /** Spreadsheet line numbers (1-based) of the rows sent, for showing results */
  lines: number[];
  excluded: { line: number; reason: string }[];
}

/**
 * Builds the rows to send. Blank and TOTAL rows are dropped silently; rows that aren't invoices
 * (payments, credit notes in a transaction list) or can't be read are listed in `excluded`.
 * Without an open balance column, `allPaid` must be true: every invoice is treated as paid.
 */
export function prepareRows(table: string[][], headerRow: number, mapping: Mapping, allPaid: boolean): Prepared {
  const out: Prepared = { rows: [], lines: [], excluded: [] };
  const get = (row: string[], f: Field) => (mapping[f] === undefined ? '' : (row[mapping[f]!] ?? '').trim());

  table.slice(headerRow + 1).forEach((row, i) => {
    const line = headerRow + 2 + i;
    const number = get(row, 'invoiceNumber');
    const customer = get(row, 'customer');
    if (!number && !customer) return;                       // blank or section row
    if (/^total/i.test(number) || /^total/i.test(customer) || /^total/i.test(row[0] ?? '')) return;
    const type = get(row, 'type');
    if (type && !/invoice/i.test(type)) return out.excluded.push({ line, reason: `Not an invoice (${type})` });

    const total = parsePence(get(row, 'total'));
    const issueDate = parseDate(get(row, 'issueDate'));
    if (total === null || Number.isNaN(total)) return out.excluded.push({ line, reason: 'Total is not a number' });
    if (!issueDate) return out.excluded.push({ line, reason: 'Invoice date is not a date' });

    const num = (f: Field) => { const v = parsePence(get(row, f)); return v === null || Number.isNaN(v) ? null : v; };
    const open = mapping.openBalance !== undefined ? num('openBalance') ?? 0 : allPaid ? 0 : null;
    if (open === null) return out.excluded.push({ line, reason: 'No open balance' });

    out.rows.push({
      invoiceNumber: number, customer, issueDate,
      dueDate: parseDate(get(row, 'dueDate')),
      total, subtotal: num('subtotal'), taxAmount: num('taxAmount'), openBalance: open,
      paymentDate: parseDate(get(row, 'paymentDate')),
      memo: get(row, 'memo') || null,
    });
    out.lines.push(line);
  });
  return out;
}

/** The imported invoice a PDF belongs to, by finding its number in the file name. */
export function matchPdfToInvoice(fileName: string, numbers: string[]): string | null {
  const base = fileName.replace(/\.pdf$/i, '');
  const hits = numbers.filter(n => {
    const escaped = n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(^|[^A-Za-z0-9])${escaped}([^A-Za-z0-9]|$)`, 'i').test(base);
  });
  return hits.sort((a, b) => b.length - a.length)[0] ?? null;
}
