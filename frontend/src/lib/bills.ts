// Rules the bill and vendor pages share. Money is pence.

/** Category names whose bills must have the supplier invoice attached */
const REQUIRES_ATTACHMENT_CATEGORIES = ['professional services', 'sub-contract', 'subcontract'];

/** Whether any chosen category needs the supplier invoice attached. */
export function attachmentRequired(categories: { id: string; name: string }[], chosenIds: (string | undefined)[]): boolean {
  return categories.some(c =>
    chosenIds.includes(c.id) && REQUIRES_ATTACHMENT_CATEGORIES.includes(c.name.trim().toLowerCase()),
  );
}

type BillSummary = { status: string; total: number; amount_paid: number; refund_due?: number };

/**
 * Balance on a bill. While any of the bill is still unpaid, that is the balance — a refund due
 * is shown beside it, not instead of it. Once the bill is paid, the refund still due is the balance.
 */
export function billBalance(bill: { total: number; amount_paid: number; refund_due?: number }): number {
  const outstanding = bill.total - bill.amount_paid;
  if (outstanding > 0) return outstanding;
  return -(bill.refund_due ?? 0) || 0;
}

/** What a vendor is owed across its open bills, and what it has been paid on bills that aren't void. */
export function vendorTotals(bills: BillSummary[]): { owed: number; openCount: number; paid: number; refundDue: number } {
  const open = bills.filter(b => b.status === 'pending' || b.status === 'partial');
  return {
    owed: open.reduce((s, b) => s + b.total - b.amount_paid, 0),
    openCount: open.length,
    paid: bills.filter(b => b.status !== 'void').reduce((s, b) => s + b.amount_paid, 0),
    refundDue: bills.reduce((s, b) => s + (b.refund_due ?? 0), 0),
  };
}

/**
 * Whether the owner can void this bill. The API refuses while it has payments or a pending or
 * posted bank match, so the button is hidden then.
 */
export function canVoidBill(
  bill: { status: string; payments: unknown[]; bank_matches: number; refund_due?: number }, isOwner: boolean,
): boolean {
  return isOwner && bill.status !== 'void' && bill.payments.length === 0 && bill.bank_matches === 0 && !(bill.refund_due && bill.refund_due > 0);
}

/**
 * Whether the owner can edit the whole bill. The API refuses once it has payments (their amounts
 * are in the books) or is void; a bill matched to a bank line waiting in For Review can still be
 * edited, as long as its total stays at least what the match pays.
 */
export function canEditBill(
  bill: { status: string; payments: unknown[]; refund_due?: number }, isOwner: boolean,
): boolean {
  return isOwner && bill.status !== 'void' && bill.payments.length === 0 && !(bill.refund_due && bill.refund_due > 0);
}
