import { PDFDocument, rgb, StandardFonts } from 'pdf-lib';

interface InvoiceItem {
  description: string;
  quantity: number;
  unit_price: number;
  tax_rate: number;
}

export interface CompanySettings {
  company_name?: string | null;
  company_reg_number?: string | null;
  vat_number?: string | null;
  address?: string | null;
  email?: string | null;
  phone?: string | null;
  bank_account_name?: string | null;
  bank_sort_code?: string | null;
  bank_account_number?: string | null;
  bank_name?: string | null;
  logo_bytes?: ArrayBuffer | null;
  logo_content_type?: string | null;
}

interface InvoiceData {
  invoice_number: string;
  issue_date: string;
  due_date: string;
  client_name: string;
  client_address?: string;
  items: InvoiceItem[];
  subtotal: number;
  tax_amount: number;
  total: number;
  notes?: string;
  title?: string;   // banner text, 'INVOICE' unless given (a VAT-only invoice says 'VAT INVOICE')
}

interface ProfitLossSummary {
  title: string;
  from: string;
  to: string;
  income: number;
  expenses: number;
  net: number;
}

function gbp(pence: number): string {
  return new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'GBP' }).format(pence / 100);
}

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}

// Duck-typed so we don't need the import type in the signature
type FontLike = { widthOfTextAtSize(text: string, size: number): number };

function wrapText(text: string, font: FontLike, size: number, maxWidth: number): string[] {
  const words = text.split(' ');
  const lines: string[] = [];
  let current = '';
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (font.widthOfTextAtSize(candidate, size) <= maxWidth) {
      current = candidate;
    } else {
      if (current) lines.push(current);
      current = word;
    }
  }
  if (current) lines.push(current);
  return lines.length ? lines : [''];
}

// Characters the built-in fonts lack but have a fair spelling in plain Latin
const SPELLED: Record<string, string> = { '₹': 'Rs ', '\u2212': '-', '\u00ad': '' };

/**
 * The built-in PDF fonts only draw WinAnsi (Western European) characters, and pdf-lib throws on
 * anything else, which would stop an invoice being finalised. Tabs become spaces, line breaks are
 * kept only where `keepLines` (addresses, notes) and become spaces elsewhere, a few symbols are
 * spelled out, and any other character the font can't draw becomes "?".
 */
export function makePdfText(font: { getCharacterSet(): number[] }) {
  const drawable = new Set(font.getCharacterSet());
  return (text: string | null | undefined, keepLines = false): string => {
    if (!text) return '';
    const flat = text.replace(/\r\n?/g, '\n').replace(/\t/g, ' ');
    let out = '';
    for (const ch of flat) {
      if (ch === '\n') { out += keepLines ? '\n' : ' '; continue; }
      const spelled = SPELLED[ch];
      const c = spelled ?? ch;
      for (const part of c) out += drawable.has(part.codePointAt(0)!) ? part : '?';
    }
    return out;
  };
}

export async function generateInvoicePdf(
  invoice: InvoiceData,
  company: CompanySettings = {}
): Promise<Uint8Array> {
  const doc  = await PDFDocument.create();
  const page = doc.addPage([595, 842]); // A4
  const { width, height } = page.getSize();

  const bold    = await doc.embedFont(StandardFonts.HelveticaBold);
  const regular = await doc.embedFont(StandardFonts.Helvetica);

  // Everything typed by people (client, lines, notes, company details) is made drawable first
  const t = makePdfText(regular);
  invoice = {
    ...invoice,
    invoice_number: t(invoice.invoice_number),
    client_name: t(invoice.client_name),
    client_address: invoice.client_address && t(invoice.client_address, true),
    notes: invoice.notes && t(invoice.notes, true),
    title: invoice.title && t(invoice.title),
    items: invoice.items.map(item => ({ ...item, description: t(item.description) })),
  };
  company = {
    ...company,
    company_name: company.company_name && t(company.company_name),
    company_reg_number: company.company_reg_number && t(company.company_reg_number),
    vat_number: company.vat_number && t(company.vat_number),
    address: company.address && t(company.address, true),
    email: company.email && t(company.email),
    phone: company.phone && t(company.phone),
    bank_account_name: company.bank_account_name && t(company.bank_account_name),
    bank_sort_code: company.bank_sort_code && t(company.bank_sort_code),
    bank_account_number: company.bank_account_number && t(company.bank_account_number),
    bank_name: company.bank_name && t(company.bank_name),
  };

  const blue    = rgb(0.22, 0.35, 0.87);
  const dark    = rgb(0.10, 0.12, 0.18);
  const muted   = rgb(0.45, 0.50, 0.58);
  const bdr     = rgb(0.88, 0.90, 0.94);
  const white   = rgb(1, 1, 1);
  const rowAlt  = rgb(0.96, 0.97, 0.99);
  const hdrBg   = rgb(0.93, 0.94, 0.97);

  const margin   = 52;
  const rightEdge = width - margin;  // x right edge for right-aligned text
  let y = height - margin;

  // Helper: draw right-aligned text
  const drawRight = (
    text: string,
    font: FontLike,
    size: number,
    yPos: number,
    color: ReturnType<typeof rgb>,
    edge = rightEdge
  ) => {
    const tw = font.widthOfTextAtSize(text, size);
    page.drawText(text, { x: edge - tw, y: yPos, font: font as never, size, color });
  };

  // ── Header: logo left, company details right, both top-aligned ──────────
  // The banner goes below whichever is taller, so long addresses never overlap it.
  const logoMaxW = 160;
  const logoMaxH = 52;
  let leftBottom = y;

  if (company.logo_bytes) {
    try {
      const mime = company.logo_content_type ?? 'image/png';
      // SVG not supported by pdf-lib — skip gracefully
      if (mime !== 'image/svg+xml') {
        const img = mime === 'image/jpeg'
          ? await doc.embedJpg(new Uint8Array(company.logo_bytes))
          : await doc.embedPng(new Uint8Array(company.logo_bytes));
        const dims = img.scaleToFit(logoMaxW, logoMaxH);
        page.drawImage(img, { x: margin, y: y - dims.height, width: dims.width, height: dims.height });
        leftBottom = y - dims.height;
      }
    } catch {
      // fall through to text fallback
    }
  }

  if (leftBottom === y) {
    // Text fallback: company name as "logo"
    page.drawText(company.company_name ?? 'LedgerLite', {
      x: margin, y: y - 16, font: bold as never, size: 20, color: blue,
    });
    leftBottom = y - 22;
  }

  // Company details — right column
  let cy = y - 11;
  const companyName = company.company_name ?? 'LedgerLite';
  drawRight(companyName, bold, 13, cy, dark);
  cy -= 16;

  const companyLines: string[] = [];
  if (company.address) companyLines.push(...company.address.split('\n').map(l => l.trim()).filter(Boolean).slice(0, 4));
  if (company.email)   companyLines.push(company.email);
  if (company.phone)   companyLines.push(company.phone);
  if (company.company_reg_number) companyLines.push(`Co. Reg: ${company.company_reg_number}`);
  if (company.vat_number)         companyLines.push(`VAT No: ${company.vat_number}`);

  for (const line of companyLines) {
    drawRight(line, regular, 9, cy, muted);
    cy -= 12;
  }
  const rightBottom = cy + 12 - 4; // baseline of the last line, plus descenders

  // ── Blue INVOICE banner ───────────────────────────────────────────────────
  const pad = 14; // inner padding of the banner and the TOTAL DUE box
  const bannerH = 40;
  const bannerY = Math.min(leftBottom, rightBottom) - 18 - bannerH;
  page.drawRectangle({ x: margin, y: bannerY, width: rightEdge - margin, height: bannerH, color: blue });

  const invSize = 17;
  page.drawText(invoice.title ?? 'INVOICE', {
    x: margin + pad,
    y: bannerY + (bannerH - invSize) / 2 + 3,
    font: bold as never, size: invSize, color: white,
  });

  // Invoice number and date, stacked on the right
  drawRight(invoice.invoice_number, bold, 13, bannerY + 21, white, rightEdge - pad);
  drawRight(`DATE: ${fmtDate(invoice.issue_date)}`, regular, 9, bannerY + 8, rgb(0.78, 0.86, 1), rightEdge - pad);

  y = bannerY - 28;

  // ── Bill to / Due date ────────────────────────────────────────────────────
  page.drawText('BILL TO',   { x: margin,  y, font: bold as never,    size: 9, color: muted });
  page.drawText('DUE DATE',  { x: 400,     y, font: bold as never,    size: 9, color: muted });

  y -= 17;
  page.drawText(invoice.client_name, { x: margin, y, font: bold as never, size: 12, color: dark });
  page.drawText(fmtDate(invoice.due_date), { x: 400, y, font: regular as never, size: 12, color: dark });

  if (invoice.client_address) {
    for (const line of invoice.client_address.split('\n').slice(0, 3)) {
      y -= 13;
      page.drawText(line.trim(), { x: margin, y, font: regular as never, size: 9, color: muted });
    }
  }

  y -= 28;
  page.drawLine({ start: { x: margin, y }, end: { x: rightEdge, y }, thickness: 0.5, color: bdr });

  // ── Table header ──────────────────────────────────────────────────────────
  y -= 20;
  const hdrH = 22;
  page.drawRectangle({ x: margin, y: y - 6, width: rightEdge - margin, height: hdrH, color: hdrBg });

  // Numeric columns are right-aligned; headers line up with their values
  const cell = 8; // inner padding of table cells
  const C = {
    desc:   margin + cell,
    qty:    350,                // right edges from here on
    price:  428,
    vat:    466,
    amount: rightEdge - cell,
  };

  page.drawText('DESCRIPTION', { x: C.desc, y: y + 3, font: bold as never, size: 8, color: muted });
  drawRight('QTY',        bold, 8, y + 3, muted, C.qty);
  drawRight('UNIT PRICE', bold, 8, y + 3, muted, C.price);
  drawRight('VAT',        bold, 8, y + 3, muted, C.vat);
  drawRight('AMOUNT',     bold, 8, y + 3, muted, C.amount);

  y -= hdrH - 6;

  // ── Line items ────────────────────────────────────────────────────────────
  let shade = false;
  for (const item of invoice.items) {
    const lineTotal = Math.round(item.quantity * item.unit_price);
    const descLines = wrapText(item.description, regular, 9, C.qty - 40 - C.desc);
    const rowH = Math.max(20, descLines.length * 12 + 8);

    if (shade) {
      page.drawRectangle({ x: margin, y: y - rowH + 14, width: rightEdge - margin, height: rowH, color: rowAlt });
    }

    // Description (left-aligned, wraps)
    let descY = y;
    for (const dl of descLines) {
      page.drawText(dl, { x: C.desc, y: descY, font: regular as never, size: 9, color: dark });
      descY -= 12;
    }

    // Right-align numeric columns
    const qtyStr = String(item.quantity);
    const priceStr = gbp(item.unit_price);
    const vatStr = `${Math.round(item.tax_rate * 100)}%`;
    const amtStr = gbp(lineTotal);

    drawRight(qtyStr,   regular, 9, y, dark, C.qty);
    drawRight(priceStr, regular, 9, y, dark, C.price);
    drawRight(vatStr,   regular, 9, y, dark, C.vat);
    drawRight(amtStr,   regular, 9, y, dark, C.amount);

    y -= rowH;
    page.drawLine({ start: { x: margin, y }, end: { x: rightEdge, y }, thickness: 0.25, color: bdr });
    shade = !shade;
  }

  // ── Totals block ──────────────────────────────────────────────────────────
  y -= 14;
  const totLabelX = 340; // the TOTAL DUE box starts `cell` to the left of this

  page.drawText('Subtotal', { x: totLabelX, y, font: regular as never, size: 10, color: muted });
  drawRight(gbp(invoice.subtotal), regular, 10, y, dark, C.amount);

  y -= 16;
  page.drawText('VAT', { x: totLabelX, y, font: regular as never, size: 10, color: muted });
  drawRight(gbp(invoice.tax_amount), regular, 10, y, dark, C.amount);

  y -= 8;
  page.drawLine({ start: { x: totLabelX, y }, end: { x: rightEdge, y }, thickness: 0.75, color: bdr });

  // Total Due — blue box
  y -= 20;
  const tdH = 30;
  const tdY = y - 8;
  page.drawRectangle({ x: totLabelX - cell, y: tdY, width: rightEdge - totLabelX + cell, height: tdH, color: blue });

  // Vertically centred text in the box
  const tdTextY = tdY + (tdH - 10) / 2;
  page.drawText('TOTAL DUE', { x: totLabelX, y: tdTextY, font: bold as never, size: 10, color: white });
  drawRight(gbp(invoice.total), bold, 13, tdTextY - 1, white, C.amount);

  y = tdY - 20;

  // ── Notes ─────────────────────────────────────────────────────────────────
  if (invoice.notes) {
    y -= 16;
    page.drawText('Notes', { x: margin, y, font: bold as never, size: 9, color: muted });
    y -= 13;
    // Each line the note was typed on starts a new line here too
    const noteLines = invoice.notes.split('\n').flatMap(para => wrapText(para, regular, 9, rightEdge - margin));
    for (const nl of noteLines.slice(0, 6)) {
      page.drawText(nl, { x: margin, y, font: regular as never, size: 9, color: dark });
      y -= 12;
    }
  }

  // ── Bank / payment details ─────────────────────────────────────────────────
  const hasBankDetails =
    company.bank_account_name || company.bank_sort_code ||
    company.bank_account_number || company.bank_name;

  if (hasBankDetails) {
    y -= 20;
    page.drawLine({ start: { x: margin, y }, end: { x: rightEdge, y }, thickness: 0.5, color: bdr });
    y -= 14;
    page.drawText('PAYMENT DETAILS', { x: margin, y, font: bold as never, size: 8, color: muted });
    y -= 13;

    const parts: string[] = [];
    if (company.bank_name)           parts.push(company.bank_name);
    if (company.bank_account_name)   parts.push(`Account name: ${company.bank_account_name}`);
    if (company.bank_sort_code)      parts.push(`Sort code: ${company.bank_sort_code}`);
    if (company.bank_account_number) parts.push(`Account: ${company.bank_account_number}`);

    for (const bl of wrapText(parts.join('   ·   '), regular, 9, rightEdge - margin)) {
      page.drawText(bl, { x: margin, y, font: regular as never, size: 9, color: dark });
      y -= 12;
    }
  }

  // ── Footer ─────────────────────────────────────────────────────────────────
  page.drawText('Thank you for your business', {
    x: margin, y: 28, font: regular as never, size: 8, color: muted,
  });

  return doc.save();
}

export async function generateProfitLossPdf(
  data: ProfitLossSummary,
  company: CompanySettings = {}
): Promise<Uint8Array> {
  const doc  = await PDFDocument.create();
  const page = doc.addPage([595, 842]);
  const { width, height } = page.getSize();
  const bold    = await doc.embedFont(StandardFonts.HelveticaBold);
  const regular = await doc.embedFont(StandardFonts.Helvetica);
  const blue  = rgb(0.22, 0.35, 0.87);
  const dark  = rgb(0.10, 0.12, 0.18);
  const muted = rgb(0.45, 0.50, 0.58);
  const margin = 52;
  const rightEdge = width - margin;
  let y = height - margin;

  const cName = company.company_name ?? 'LedgerLite';
  page.drawText(cName, { x: margin, y, font: bold as never, size: 22, color: blue });
  y -= 34;
  page.drawText(makePdfText(bold)(data.title), { x: margin, y, font: bold as never, size: 18, color: dark });
  y -= 20;
  page.drawText(`${fmtDate(data.from)} to ${fmtDate(data.to)}`, {
    x: margin, y, font: regular as never, size: 11, color: muted,
  });

  y -= 44;
  const valX = rightEdge;
  page.drawText('Total income', { x: margin, y, font: regular as never, size: 12, color: muted });
  const incStr = gbp(data.income);
  page.drawText(incStr, { x: valX - bold.widthOfTextAtSize(incStr, 12), y, font: bold as never, size: 12, color: dark });

  y -= 26;
  page.drawText('Total expenses', { x: margin, y, font: regular as never, size: 12, color: muted });
  const expStr = gbp(data.expenses);
  page.drawText(expStr, { x: valX - bold.widthOfTextAtSize(expStr, 12), y, font: bold as never, size: 12, color: dark });

  y -= 26;
  page.drawText('Net profit', { x: margin, y, font: bold as never, size: 14, color: dark });
  const netStr = gbp(data.net);
  const netColor = data.net >= 0 ? blue : rgb(0.86, 0.15, 0.15);
  page.drawText(netStr, { x: valX - bold.widthOfTextAtSize(netStr, 14), y, font: bold as never, size: 14, color: netColor });

  page.drawText('Generated by LedgerLite', { x: margin, y: 32, font: regular as never, size: 8, color: muted });
  return doc.save();
}
