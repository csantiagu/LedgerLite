import { env } from 'cloudflare:workers';
import { unzipSync, strFromU8 } from 'fflate';
import { beforeAll, describe, expect, it } from 'vitest';
import app from '../../src/index';
import { issueAccessToken } from '../../src/middleware/auth';

const ctx = { waitUntil: () => {}, passThroughOnException: () => {}, props: {} } as unknown as ExecutionContext;
const uid = () => crypto.randomUUID().replace(/-/g, '');
let ownerToken = '';
let ownerId = '';

// Sheet name → its XML, in workbook order
async function exportSheets(from: string, to: string): Promise<Array<{ name: string; xml: string }>> {
  const res = await app.fetch(new Request(`http://api.test/api/v1/reports/accountant-export?from=${from}&to=${to}`, {
    headers: { Authorization: `Bearer ${ownerToken}`, 'X-Requested-With': 'XMLHttpRequest' },
  }), env, ctx);
  expect(res.status).toBe(200);
  const files = unzipSync(new Uint8Array(await res.arrayBuffer()));
  const names = [...strFromU8(files['xl/workbook.xml']).matchAll(/<sheet name="([^"]*)"/g)].map(m => m[1]);
  return names.map((name, i) => ({ name, xml: strFromU8(files[`xl/worksheets/sheet${i + 1}.xml`]) }));
}

async function account(name: string, active = 1) {
  const id = uid();
  await env.DB.prepare(`
    INSERT INTO bank_accounts (id, name, bank_name, csv_format, is_active, created_by) VALUES (?, ?, 'Test', 'monzo', ?, ?)
  `).bind(id, name, active, ownerId).run();
  return id;
}

async function line(accountId: string | null, date: string, description: string, amount: number) {
  await env.DB.prepare(`
    INSERT INTO transactions (id, bank_account_id, date, description, amount) VALUES (?, ?, ?, ?, ?)
  `).bind(uid(), accountId, date, description, amount).run();
}

let current = '';
let savings = '';

beforeAll(async () => {
  ownerId = uid();
  await env.DB.prepare(`INSERT INTO users (id, email, name, role, password_hash) VALUES (?, ?, 'O', 'owner', 'x')`)
    .bind(ownerId, `${ownerId}@test.local`).run();
  ownerToken = await issueAccessToken(ownerId, `${ownerId}@test.local`, 'owner', env.JWT_SECRET);

  current = await account('Export Current');
  savings = await account('Export Savings/Joint');   // "/" can't be in a sheet name
  const closed = await account('Export Closed', 0);
  await account('Export Old Closed', 0);              // closed, nothing in the period: no sheet

  await line(current, '2021-04-02', 'CURRENT IN', 50_000);
  await line(current, '2021-04-03', 'CURRENT OUT', -12_000);
  await line(savings, '2021-04-04', 'SAVINGS IN', 7_500);
  await line(closed, '2021-04-05', 'CLOSED OUT', -2_000);
  await line(null, '2021-04-06', 'NO ACCOUNT LINE', 300);
});

describe('accountant export', () => {
  it('gives each bank account its own sheet, with only its lines and its totals', async () => {
    const sheets = await exportSheets('2021-04-01', '2021-04-30');
    const names = sheets.map(s => s.name);
    expect(names[0]).toBe('Summary');
    expect(names).toEqual(expect.arrayContaining(['Export Current', 'Export Savings Joint', 'Export Closed', 'No bank account']));
    expect(names).not.toContain('Export Old Closed');
    expect(names).not.toContain('Bank transactions');

    const sheet = (name: string) => sheets.find(s => s.name === name)!.xml;
    const cur = sheet('Export Current');
    expect(cur).toContain('CURRENT IN');
    expect(cur).toContain('CURRENT OUT');
    expect(cur).not.toContain('SAVINGS IN');
    expect(cur).not.toContain('>Account<');            // the sheet is the account
    expect(cur).toContain('Total (2 lines)');
    expect(cur).toContain('<v>500.00</v>');
    expect(cur).toContain('<v>120.00</v>');
    // The filter covers the lines, not the totals under them
    expect(cur).toContain('<autoFilter ref="A1:M3"/>');

    expect(sheet('Export Savings Joint')).toContain('SAVINGS IN');
    expect(sheet('Export Closed')).toContain('CLOSED OUT');
    expect(sheet('No bank account')).toContain('NO ACCOUNT LINE');
  });

  it('keeps one Unexplained sheet across accounts, saying which account each line is from', async () => {
    const sheets = await exportSheets('2021-04-01', '2021-04-30');
    const unexplained = sheets.find(s => s.name === 'Unexplained')!.xml;
    expect(unexplained).toContain('>Account<');
    expect(unexplained).toContain('Export Current');
    expect(unexplained).toContain('Export Savings/Joint');
    expect(unexplained).toContain('CLOSED OUT');
  });

  it('totals every account on the summary', async () => {
    const summary = (await exportSheets('2021-04-01', '2021-04-30'))[0].xml;
    expect(summary).toContain('Bank lines by account');
    expect(summary).toContain('Export Savings/Joint');
    expect(summary).toContain('<v>75.00</v>');
  });

  it('still lists an active account with nothing in the period', async () => {
    const sheets = await exportSheets('2019-01-01', '2019-01-31');
    const cur = sheets.find(s => s.name === 'Export Current')!.xml;
    expect(cur).toContain('No transactions in this period');
    expect(cur).not.toContain('autoFilter');
  });

  it('puts each invoice PDF in the ZIP and names it on the Sales invoices sheet', async () => {
    const client = uid();
    await env.DB.prepare(`INSERT INTO clients (id, name, created_by) VALUES (?, 'Export Client', ?)`).bind(client, ownerId).run();
    const invoice = async (number: string, status: string, key: string | null) => env.DB.prepare(`
      INSERT INTO invoices (id, client_id, invoice_number, status, issue_date, due_date, subtotal, total, pdf_r2_key, created_by)
      VALUES (?, ?, ?, ?, '2021-04-10', '2099-01-01', 1000, 1000, ?, ?)
    `).bind(uid(), client, number, status, key, ownerId).run();
    await env.R2.put('test/exp-0001.pdf', '%PDF-1.4 sent');
    await env.R2.put('test/exp-draft.pdf', '%PDF-1.4 draft');
    await invoice('EXP/0001', 'sent', 'test/exp-0001.pdf');     // the "/" can't be in a file name
    await invoice('EXP-0002', 'sent', null);                     // not finalised with a PDF
    await invoice('EXP-0003', 'draft', 'test/exp-draft.pdf');   // drafts aren't exported

    const res = await app.fetch(new Request('http://api.test/api/v1/reports/accountant-export?from=2021-04-01&to=2021-04-30&receipts=1', {
      headers: { Authorization: `Bearer ${ownerToken}`, 'X-Requested-With': 'XMLHttpRequest' },
    }), env, ctx);
    expect(res.status).toBe(200);
    const files = unzipSync(new Uint8Array(await res.arrayBuffer()));
    const pdfs = Object.keys(files).filter(n => n.startsWith('invoices/'));
    expect(pdfs).toEqual(['invoices/EXP-0001.pdf']);
    expect(strFromU8(files['invoices/EXP-0001.pdf'])).toBe('%PDF-1.4 sent');

    const xlsx = unzipSync(files['accounts-2021-04-01-to-2021-04-30.xlsx']);
    const names = [...strFromU8(xlsx['xl/workbook.xml']).matchAll(/<sheet name="([^"]*)"/g)].map(m => m[1]);
    const sales = strFromU8(xlsx[`xl/worksheets/sheet${names.indexOf('Sales invoices') + 1}.xml`]);
    expect(sales).toContain('invoices/EXP-0001.pdf');
    expect(sales).not.toContain('EXP-0003');
  });
});
