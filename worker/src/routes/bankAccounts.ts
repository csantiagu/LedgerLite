import { Hono } from 'hono';
import { z } from 'zod';
import type { Env } from '../types';
import type { AuthUser } from '../types';
import { requireRole } from '../middleware/rbac';
import { actorOf, auditStatement, changedFields } from '../middleware/audit';

const router = new Hono<{ Bindings: Env; Variables: { user: AuthUser } }>();

const BankAccountSchema = z.object({
  name:           z.string().min(1),
  bankName:       z.string().min(1),
  accountType:    z.enum(['current', 'savings', 'credit', 'other']).default('current'),
  lastFour:       z.string().length(4).optional().or(z.literal('').transform(() => undefined)),
  currency:       z.string().length(3).default('GBP'),
  csvFormat:      z.enum(['barclays', 'hsbc', 'lloyds', 'natwest', 'monzo', 'starling']),
  openingBalance: z.number().int().default(0), // pence, can be negative
  notes:          z.string().optional().or(z.literal('').transform(() => undefined)),
});

router.get('/', async (c) => {
  const { results } = await c.env.DB
    .prepare('SELECT * FROM bank_accounts WHERE is_active = 1 ORDER BY name')
    .all<Record<string, unknown>>();
  return c.json(results);
});

router.post('/', requireRole('owner'), async (c) => {
  const body   = await c.req.json().catch(() => null);
  const parsed = BankAccountSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);

  const user = c.get('user');
  const id   = crypto.randomUUID();

  await c.env.DB.batch([
    c.env.DB.prepare(`
      INSERT INTO bank_accounts (id, name, bank_name, account_type, last_four, currency, csv_format, opening_balance, notes, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      id, parsed.data.name, parsed.data.bankName, parsed.data.accountType,
      parsed.data.lastFour ?? null, parsed.data.currency,
      parsed.data.csvFormat, parsed.data.openingBalance,
      parsed.data.notes ?? null, user.id
    ),
    auditStatement(c.env.DB, actorOf(c), {
      action: 'bank_account.created', resourceType: 'bank_account', resourceId: id,
      newValues: parsed.data, summary: `Added bank account ${parsed.data.name}`,
    }),
  ]);

  return c.json({ id }, 201);
});

router.patch('/:id', requireRole('owner'), async (c) => {
  const id   = c.req.param('id');
  const body = await c.req.json().catch(() => null);
  const parsed = z.object({
    name:           z.string().min(1).optional(),
    notes:          z.string().optional(),
    lastFour:       z.string().length(4).optional(),
    openingBalance: z.number().int().optional(),
    isActive:       z.boolean().optional(),
  }).safeParse(body);
  if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);

  const existing = await c.env.DB.prepare(
    'SELECT name, notes, last_four, opening_balance, is_active FROM bank_accounts WHERE id = ?'
  ).bind(id).first<{ name: string; notes: string | null; last_four: string | null; opening_balance: number; is_active: number }>();
  if (!existing) return c.json({ error: 'Not found' }, 404);
  const diff = changedFields(
    {
      name: existing.name, notes: existing.notes, lastFour: existing.last_four,
      openingBalance: existing.opening_balance, isActive: !!existing.is_active,
    },
    parsed.data,
  );

  await c.env.DB.batch([
    c.env.DB.prepare(`
      UPDATE bank_accounts SET
        name            = COALESCE(?, name),
        notes           = COALESCE(?, notes),
        last_four       = COALESCE(?, last_four),
        opening_balance = COALESCE(?, opening_balance),
        is_active       = COALESCE(?, is_active)
      WHERE id = ?
    `).bind(
      parsed.data.name            ?? null,
      parsed.data.notes           ?? null,
      parsed.data.lastFour        ?? null,
      parsed.data.openingBalance  ?? null,
      parsed.data.isActive !== undefined ? (parsed.data.isActive ? 1 : 0) : null,
      id
    ),
    ...(diff ? [auditStatement(c.env.DB, actorOf(c), {
      action: 'bank_account.updated', resourceType: 'bank_account', resourceId: id, ...diff,
      summary: `Edited bank account ${existing.name}`,
    })] : []),
  ]);

  return c.json({ ok: true });
});

// POST /:id/detect-opening-balance — compute from earliest imported transaction with a balance value
router.post('/:id/detect-opening-balance', requireRole('owner'), async (c) => {
  const accountId = c.req.param('id');

  const first = await c.env.DB.prepare(`
    SELECT amount, balance FROM transactions
    WHERE bank_account_id = ? AND balance IS NOT NULL
    ORDER BY date ASC, created_at ASC
    LIMIT 1
  `).bind(accountId).first<{ amount: number; balance: number }>();

  if (!first) return c.json({ error: 'No transactions with balance data found' }, 404);

  const openingBalance = first.balance - first.amount;
  const account = await c.env.DB.prepare('SELECT opening_balance FROM bank_accounts WHERE id = ?')
    .bind(accountId).first<{ opening_balance: number }>();
  if (!account) return c.json({ error: 'Not found' }, 404);

  await c.env.DB.batch([
    c.env.DB.prepare(
      'UPDATE bank_accounts SET opening_balance = ? WHERE id = ?'
    ).bind(openingBalance, accountId),
    ...(account.opening_balance !== openingBalance ? [auditStatement(c.env.DB, actorOf(c), {
      action: 'bank_account.updated', resourceType: 'bank_account', resourceId: accountId,
      oldValues: { openingBalance: account.opening_balance }, newValues: { openingBalance },
      summary: 'Opening balance worked out from the imported balances',
    })] : []),
  ]);

  return c.json({ opening_balance: openingBalance });
});

router.get('/:id/balance', async (c) => {
  const accountId = c.req.param('id');
  const [txnResult, account] = await c.env.DB.batch([
    c.env.DB.prepare(`
      SELECT
        SUM(CASE WHEN amount > 0 THEN amount ELSE 0 END) as total_credits,
        SUM(CASE WHEN amount < 0 THEN amount ELSE 0 END) as total_debits,
        SUM(amount)                                       as net,
        COUNT(*)                                          as transaction_count,
        MIN(date)                                         as earliest_date,
        MAX(date)                                         as latest_date,
        (SELECT balance FROM transactions
         WHERE bank_account_id = ? AND balance IS NOT NULL
         ORDER BY date DESC, created_at DESC LIMIT 1)    as last_known_balance
      FROM transactions
      WHERE bank_account_id = ?
    `).bind(accountId, accountId),
    c.env.DB.prepare('SELECT opening_balance FROM bank_accounts WHERE id = ?').bind(accountId),
  ]);
  const txn = txnResult.results[0] as Record<string, unknown> | undefined;
  const openingBalance = (account.results[0] as { opening_balance: number } | undefined)?.opening_balance ?? 0;
  const net = (txn?.net as number) ?? 0;
  return c.json({
    ...txn,
    opening_balance: openingBalance,
    computed_balance: openingBalance + net,
  });
});

export { router as bankAccountRoutes };
