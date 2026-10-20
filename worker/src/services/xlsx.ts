import { strToU8, zipSync } from 'fflate';
import { penceToDecimal } from './money';

// Minimal .xlsx (Office Open XML) writer: inline strings, money, dates, bold rows.
// Enough for an accountant-facing workbook without pulling in a 1MB library.

export type Cell =
  | null
  | string
  | number
  | { money: number }   // integer pence, shown as 1,234.56
  | { date: string };   // ISO yyyy-mm-dd, shown as dd/mm/yyyy

export type Row = Cell[] | { bold: true; cells: Cell[] };

export type Sheet = {
  name: string;
  columns?: number[];   // widths in characters
  header?: string[];    // bold, frozen, with autofilter
  rows: Row[];
  footer?: Row[];       // after a blank row, outside the autofilter (e.g. totals), so sorting leaves them put
};

// Style indexes into cellXfs below (0 = default)
const S_BOLD = 1, S_MONEY = 2, S_MONEY_BOLD = 3, S_DATE = 4;

const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<numFmts count="1"><numFmt numFmtId="164" formatCode="dd/mm/yyyy"/></numFmts>
<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>
<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>
<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="5">
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>
<xf numFmtId="4" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="4" fontId="1" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyFont="1"/>
<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
</cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`;

function esc(s: string): string {
  return s
    // XML 1.0 forbids most control characters
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function colName(i: number): string {
  let n = i + 1, s = '';
  while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); }
  return s;
}

// Excel serial date: days since 1899-12-30
function excelDate(iso: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return null;
  return Math.round((Date.UTC(+m[1], +m[2] - 1, +m[3]) - Date.UTC(1899, 11, 30)) / 86_400_000);
}

function cellXml(ref: string, cell: Cell, bold: boolean): string {
  if (cell === null || cell === '') return '';
  if (typeof cell === 'string') {
    return `<c r="${ref}" t="inlineStr"${bold ? ` s="${S_BOLD}"` : ''}><is><t xml:space="preserve">${esc(cell)}</t></is></c>`;
  }
  if (typeof cell === 'number') {
    return `<c r="${ref}"${bold ? ` s="${S_BOLD}"` : ''}><v>${cell}</v></c>`;
  }
  if ('money' in cell) {
    return `<c r="${ref}" s="${bold ? S_MONEY_BOLD : S_MONEY}"><v>${penceToDecimal(cell.money)}</v></c>`;
  }
  const serial = excelDate(cell.date);
  if (serial === null) return cellXml(ref, cell.date, bold);
  return `<c r="${ref}" s="${S_DATE}"><v>${serial}</v></c>`;
}

function sheetXml(sheet: Sheet): string {
  const rows: string[] = [];
  const all: Array<{ bold: boolean; cells: Cell[] }> = [];
  if (sheet.header) all.push({ bold: true, cells: sheet.header });
  for (const r of sheet.rows) all.push(Array.isArray(r) ? { bold: false, cells: r } : r);
  const filtered = all.length;
  if (sheet.footer?.length) {
    all.push({ bold: false, cells: [] });
    for (const r of sheet.footer) all.push(Array.isArray(r) ? { bold: false, cells: r } : r);
  }

  all.forEach((r, ri) => {
    const cells = r.cells.map((c, ci) => cellXml(`${colName(ci)}${ri + 1}`, c, r.bold)).join('');
    rows.push(`<row r="${ri + 1}">${cells}</row>`);
  });

  const cols = sheet.columns?.length
    ? `<cols>${sheet.columns.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('')}</cols>`
    : '';
  const freeze = sheet.header
    ? `<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>`
    : '';
  const filter = sheet.header && filtered > 1
    ? `<autoFilter ref="A1:${colName(sheet.header.length - 1)}${filtered}"/>`
    : '';

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${freeze}${cols}<sheetData>${rows.join('')}</sheetData>${filter}</worksheet>`;
}

function safeSheetName(name: string, used: Set<string>): string {
  let base = name.replace(/[\[\]:*?/\\]/g, ' ').slice(0, 31) || 'Sheet';
  let candidate = base, n = 2;
  while (used.has(candidate.toLowerCase())) {
    const suffix = ` (${n++})`;
    candidate = base.slice(0, 31 - suffix.length) + suffix;
  }
  used.add(candidate.toLowerCase());
  return candidate;
}

export function buildXlsx(sheets: Sheet[]): Uint8Array {
  const used = new Set<string>();
  const names = sheets.map((s) => safeSheetName(s.name, used));

  const files: Record<string, Uint8Array> = {
    '[Content_Types].xml': strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
${sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('\n')}
</Types>`),
    '_rels/.rels': strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`),
    'xl/workbook.xml': strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets>${names.map((n, i) => `<sheet name="${esc(n)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets>
</workbook>`),
    'xl/_rels/workbook.xml.rels': strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
${sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('\n')}
<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`),
    'xl/styles.xml': strToU8(STYLES),
  };
  sheets.forEach((s, i) => { files[`xl/worksheets/sheet${i + 1}.xml`] = strToU8(sheetXml(s)); });

  return zipSync(files, { level: 6 });
}
