// Rules the bill and vendor pages share. Money is pence.

/** Category names whose bills must have the supplier invoice attached */
const REQUIRES_ATTACHMENT_CATEGORIES = ['professional services', 'sub-contract', 'subcontract'];

/** Whether any chosen category needs the supplier invoice attached. */
export function attachmentRequired(categories: { id: string; name: string }[], chosenIds: (string | undefined)[]): boolean {
  return categories.some(c =>
    chosenIds.includes(c.id) && REQUIRES_ATTACHMENT_CATEGORIES.includes(c.name.trim().toLowerCase()),
  );
}

type BillSummary = { status: string; total: number; amount_paid: number };

/** What a vendor is owed across its open bills, and what it has been paid on bills that aren't void. */
export function vendorTotals(bills: BillSummary[]): { owed: number; openCount: number; paid: number } {
  const open = bills.filter(b => b.status === 'pending' || b.status === 'partial');
  return {
    owed: open.reduce((s, b) => s + b.total - b.amount_paid, 0),
    openCount: open.length,
    paid: bills.filter(b => b.status !== 'void').reduce((s, b) => s + b.amount_paid, 0),
  };
}

/**
 * Whether the owner can void this bill. The API refuses while it has payments or a pending or
 * posted bank match, so the button is hidden then.
 */
export function canVoidBill(bill: { status: string; payments: unknown[]; bank_matches: number }, isOwner: boolean): boolean {
  return isOwner && bill.status !== 'void' && bill.payments.length === 0 && bill.bank_matches === 0;
}
