export type BankFormat = 'barclays' | 'hsbc' | 'lloyds' | 'natwest' | 'monzo' | 'starling';

export type ParsedTransaction = {
  date: string;
  description: string;
  amount: number;
  balance: number | null;
  reference: string | null;
};

function parseCsvRows(csv: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let inQuotes = false;
  for (let i = 0; i < csv.length; i += 1) {
    const ch = csv[i];
    const next = csv[i + 1];
    if (ch === '"') {
      if (inQuotes && next === '"') {
        cell += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }
    if (!inQuotes && ch === ',') {
      row.push(cell.trim());
      cell = '';
      continue;
    }
    if (!inQuotes && (ch === '\n' || ch === '\r')) {
      if (ch === '\r' && next === '\n') i += 1;
      row.push(cell.trim());
      cell = '';
      if (row.some((v) => v.length > 0)) rows.push(row);
      row = [];
      continue;
    }
    cell += ch;
  }
  if (cell.length > 0 || row.length > 0) {
    row.push(cell.trim());
    if (row.some((v) => v.length > 0)) rows.push(row);
  }
  return rows;
}

function normalizeDate(raw: string): string {
  const s = raw.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const dmy = s.match(/^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{2,4})$/);
  if (dmy) {
    const dd = dmy[1].padStart(2, '0');
    const mm = dmy[2].padStart(2, '0');
    const yy = dmy[3].length === 2 ? `20${dmy[3]}` : dmy[3];
    return `${yy}-${mm}-${dd}`;
  }
  const d = new Date(s);
  if (!Number.isNaN(d.getTime())) return d.toISOString().slice(0, 10);
  throw new Error(`Invalid date: ${raw}`);
}

function moneyToPence(raw: string): number {
  const cleaned = raw
    .replace(/[£,\s]/g, '')
    .replace(/^\((.*)\)$/, '-$1');
  if (!cleaned) return 0;
  const n = Number(cleaned);
  if (Number.isNaN(n)) throw new Error(`Invalid amount: ${raw}`);
  return Math.round(n * 100);
}

function findIndex(headers: string[], names: string[]): number {
  const lowered = headers.map((h) => h.toLowerCase().trim());
  for (const n of names) {
    const idx = lowered.indexOf(n.toLowerCase());
    if (idx >= 0) return idx;
  }
  return -1;
}

function pickHeaderRows(
  rows: string[][],
  requiredGroups: string[][]
): { headers: string[]; dataRows: string[][] } {
  for (let i = 0; i < rows.length; i += 1) {
    const headers = rows[i];
    let ok = true;
    for (const group of requiredGroups) {
      const idx = findIndex(headers, group);
      if (idx < 0) {
        ok = false;
        break;
      }
    }
    if (ok) return { headers, dataRows: rows.slice(i + 1) };
  }
  throw new Error('CSV headers not recognized');
}

function parseWithSignedAmount(rows: string[][], dateNames: string[], descNames: string[], amountNames: string[], balanceNames: string[], refNames: string[]): ParsedTransaction[] {
  if (rows.length < 2) return [];
  const picked = pickHeaderRows(rows, [dateNames, descNames, amountNames]);
  const headers = picked.headers;
  const dateI = findIndex(headers, dateNames);
  const descI = findIndex(headers, descNames);
  const amountI = findIndex(headers, amountNames);
  const balanceI = findIndex(headers, balanceNames);
  const refI = findIndex(headers, refNames);
  if (dateI < 0 || descI < 0 || amountI < 0) throw new Error('CSV headers not recognized');

  return picked.dataRows.map((r) => ({
    date: normalizeDate(r[dateI] || ''),
    description: (r[descI] || '').trim(),
    amount: moneyToPence(r[amountI] || '0'),
    balance: balanceI >= 0 && (r[balanceI] || '').trim() ? moneyToPence(r[balanceI]) : null,
    reference: refI >= 0 ? ((r[refI] || '').trim() || null) : null,
  })).filter((r) => r.description.length > 0);
}

function parseWithInOut(rows: string[][], dateNames: string[], descNames: string[], inNames: string[], outNames: string[], balanceNames: string[], refNames: string[]): ParsedTransaction[] {
  if (rows.length < 2) return [];
  const picked = pickHeaderRows(rows, [dateNames, descNames, inNames, outNames]);
  const headers = picked.headers;
  const dateI = findIndex(headers, dateNames);
  const descI = findIndex(headers, descNames);
  const inI = findIndex(headers, inNames);
  const outI = findIndex(headers, outNames);
  const balanceI = findIndex(headers, balanceNames);
  const refI = findIndex(headers, refNames);
  if (dateI < 0 || descI < 0 || inI < 0 || outI < 0) throw new Error('CSV headers not recognized');

  return picked.dataRows.map((r) => {
    const inPence = moneyToPence(r[inI] || '0');
    const outPence = moneyToPence(r[outI] || '0');
    return {
      date: normalizeDate(r[dateI] || ''),
      description: (r[descI] || '').trim(),
      amount: inPence - outPence,
      balance: balanceI >= 0 && (r[balanceI] || '').trim() ? moneyToPence(r[balanceI]) : null,
      reference: refI >= 0 ? ((r[refI] || '').trim() || null) : null,
    };
  }).filter((r) => r.description.length > 0);
}

export function parseBankCsv(csv: string, format: BankFormat): ParsedTransaction[] {
  const rows = parseCsvRows(csv);
  switch (format) {
    case 'monzo':
      return parseWithSignedAmount(
        rows,
        ['date', 'date (uk time)', 'local time', 'completed date'],
        ['description', 'merchant', 'name', 'counterparty'],
        ['amount', 'amount (gbp)'],
        ['balance'],
        ['notes', 'reference', 'type']
      );
    case 'starling':
      return parseWithSignedAmount(
        rows,
        ['date', 'transaction date'],
        ['narrative', 'description', 'counter party'],
        ['amount (gbp)', 'amount'],
        ['balance (gbp)', 'balance'],
        ['reference']
      );
    case 'barclays':
      return parseWithInOut(
        rows,
        ['date'],
        ['description', 'transaction'],
        ['money in', 'paid in', 'credit'],
        ['money out', 'paid out', 'debit'],
        ['balance'],
        ['reference']
      );
    case 'hsbc':
      return parseWithInOut(
        rows,
        ['transaction date', 'date'],
        ['description', 'narrative'],
        ['credit amount', 'paid in', 'credit'],
        ['debit amount', 'paid out', 'debit'],
        ['balance'],
        ['reference']
      );
    case 'lloyds':
      return parseWithInOut(
        rows,
        ['transaction date', 'date'],
        ['transaction description', 'description'],
        ['credit amount', 'paid in', 'credit'],
        ['debit amount', 'paid out', 'debit'],
        ['balance'],
        ['transaction id', 'reference']
      );
    case 'natwest':
      return parseWithSignedAmount(
        rows,
        ['date'],
        ['description', 'details'],
        ['value', 'amount'],
        ['balance'],
        ['type', 'reference', 'account name', 'account number']
      );
    default:
      throw new Error(`Unsupported format: ${format}`);
  }
}
