import { PDFDocument, rgb, StandardFonts } from 'pdf-lib';

interface InvoiceItem {
  description: string;
  quantity: number;
  unit_price: number;
  tax_rate: number;
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

export async function generateInvoicePdf(invoice: InvoiceData): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([595, 842]); // A4
  const { width, height } = page.getSize();

  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const regular = await doc.embedFont(StandardFonts.Helvetica);

  const blue = rgb(0.145, 0.388, 0.922);
  const dark = rgb(0.059, 0.090, 0.165);
  const muted = rgb(0.392, 0.455, 0.545);
  const border = rgb(0.886, 0.906, 0.941);

  const margin = 56;
  let y = height - margin;

  page.drawText('LedgerLite', { x: margin, y, font: bold, size: 22, color: blue });
  page.drawText('INVOICE', { x: width - margin - 80, y, font: bold, size: 20, color: dark });

  y -= 28;
  page.drawText(invoice.invoice_number, { x: width - margin - 120, y, font: regular, size: 11, color: muted });

  y -= 40;
  page.drawLine({ start: { x: margin, y }, end: { x: width - margin, y }, thickness: 1, color: border });

  y -= 24;
  page.drawText('Bill to', { x: margin, y, font: bold, size: 9, color: muted });
  page.drawText('Issue date', { x: 300, y, font: bold, size: 9, color: muted });
  page.drawText('Due date', { x: 420, y, font: bold, size: 9, color: muted });

  y -= 16;
  page.drawText(invoice.client_name, { x: margin, y, font: bold, size: 11, color: dark });
  page.drawText(fmtDate(invoice.issue_date), { x: 300, y, font: regular, size: 11, color: dark });
  page.drawText(fmtDate(invoice.due_date), { x: 420, y, font: regular, size: 11, color: dark });

  if (invoice.client_address) {
    y -= 14;
    for (const line of invoice.client_address.split('\n')) {
      page.drawText(line, { x: margin, y, font: regular, size: 10, color: muted });
      y -= 13;
    }
  }

  y -= 24;
  page.drawLine({ start: { x: margin, y }, end: { x: width - margin, y }, thickness: 1, color: border });

  y -= 20;
  const col = { desc: margin, qty: 320, price: 390, vat: 455, amount: 510 };
  page.drawText('Description', { x: col.desc, y, font: bold, size: 9, color: muted });
  page.drawText('Qty', { x: col.qty, y, font: bold, size: 9, color: muted });
  page.drawText('Unit price', { x: col.price, y, font: bold, size: 9, color: muted });
  page.drawText('VAT', { x: col.vat, y, font: bold, size: 9, color: muted });
  page.drawText('Amount', { x: col.amount, y, font: bold, size: 9, color: muted });

  y -= 10;
  page.drawLine({ start: { x: margin, y }, end: { x: width - margin, y }, thickness: 0.5, color: border });

  for (const item of invoice.items) {
    y -= 20;
    const lineTotal = Math.round(item.quantity * item.unit_price);
    page.drawText(item.description.slice(0, 55), { x: col.desc, y, font: regular, size: 10, color: dark });
    page.drawText(String(item.quantity), { x: col.qty, y, font: regular, size: 10, color: dark });
    page.drawText(gbp(item.unit_price), { x: col.price, y, font: regular, size: 10, color: dark });
    page.drawText(`${Math.round(item.tax_rate * 100)}%`, { x: col.vat, y, font: regular, size: 10, color: dark });
    page.drawText(gbp(lineTotal), { x: col.amount, y, font: regular, size: 10, color: dark });

    y -= 4;
    page.drawLine({ start: { x: margin, y }, end: { x: width - margin, y }, thickness: 0.25, color: border });
  }

  y -= 20;
  const totCol = 380;
  page.drawText('Subtotal', { x: totCol, y, font: regular, size: 10, color: muted });
  page.drawText(gbp(invoice.subtotal), { x: col.amount, y, font: regular, size: 10, color: dark });

  y -= 16;
  page.drawText('VAT', { x: totCol, y, font: regular, size: 10, color: muted });
  page.drawText(gbp(invoice.tax_amount), { x: col.amount, y, font: regular, size: 10, color: dark });

  y -= 10;
  page.drawLine({ start: { x: totCol, y }, end: { x: width - margin, y }, thickness: 1, color: border });

  y -= 18;
  page.drawText('Total due', { x: totCol, y, font: bold, size: 12, color: dark });
  page.drawText(gbp(invoice.total), { x: col.amount, y, font: bold, size: 12, color: blue });

  if (invoice.notes) {
    y -= 40;
    page.drawText('Notes', { x: margin, y, font: bold, size: 9, color: muted });
    y -= 14;
    page.drawText(invoice.notes.slice(0, 120), { x: margin, y, font: regular, size: 10, color: dark });
  }

  page.drawText('Generated by LedgerLite', { x: margin, y: 32, font: regular, size: 8, color: muted });

  return doc.save();
}

export async function generateProfitLossPdf(data: ProfitLossSummary): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([595, 842]);
  const { height } = page.getSize();
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const regular = await doc.embedFont(StandardFonts.Helvetica);
  const blue = rgb(0.145, 0.388, 0.922);
  const dark = rgb(0.059, 0.090, 0.165);
  const muted = rgb(0.392, 0.455, 0.545);
  const margin = 56;
  let y = height - margin;

  page.drawText('LedgerLite', { x: margin, y, font: bold, size: 22, color: blue });
  y -= 34;
  page.drawText(data.title, { x: margin, y, font: bold, size: 18, color: dark });
  y -= 20;
  page.drawText(`${fmtDate(data.from)} to ${fmtDate(data.to)}`, { x: margin, y, font: regular, size: 11, color: muted });

  y -= 44;
  page.drawText('Total income', { x: margin, y, font: regular, size: 12, color: muted });
  page.drawText(gbp(data.income), { x: 420, y, font: bold, size: 12, color: dark });
  y -= 26;
  page.drawText('Total expenses', { x: margin, y, font: regular, size: 12, color: muted });
  page.drawText(gbp(data.expenses), { x: 420, y, font: bold, size: 12, color: dark });
  y -= 26;
  page.drawText('Net profit', { x: margin, y, font: bold, size: 14, color: dark });
  page.drawText(gbp(data.net), { x: 420, y, font: bold, size: 14, color: data.net >= 0 ? blue : rgb(0.862, 0.149, 0.149) });

  page.drawText('Generated by LedgerLite', { x: margin, y: 32, font: regular, size: 8, color: muted });
  return doc.save();
}
