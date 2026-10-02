// Pure rules for matching bank transactions to invoices/bills.
// All amounts are integer pence. Allocations are always positive; the sign lives on the transaction.

export type MatchType = 'invoice' | 'bill';

export const OPEN_INVOICE_STATUSES = ['sent', 'partial', 'overdue'] as const;
export const OPEN_BILL_STATUSES = ['pending', 'partial'] as const;

export function isOpenTarget(type: MatchType, status: string): boolean {
  const open: readonly string[] = type === 'invoice' ? OPEN_INVOICE_STATUSES : OPEN_BILL_STATUSES;
  return open.includes(status);
}

export type AllocationInput = {
  type: MatchType;
  txnAmount: number;              // signed: +money in, -money out
  allocatedAmount: number;        // positive
  otherTxnAllocations: number;    // this transaction's pending/posted allocations to *other* targets
  targetStatus: string;
  targetOutstanding: number;      // total - amount_paid
  otherPendingOnTarget: number;   // pending allocations from *other* transactions to this target
};

/** Returns an error message, or null when the allocation is acceptable. */
export function checkAllocation(a: AllocationInput): string | null {
  if (!Number.isInteger(a.allocatedAmount) || a.allocatedAmount <= 0) {
    return 'Allocated amount must be a positive whole number of pence';
  }
  if (a.type === 'invoice' && a.txnAmount <= 0) {
    return 'Only money coming in can be matched to a sales invoice';
  }
  if (a.type === 'bill' && a.txnAmount >= 0) {
    return 'Only money going out can be matched to a supplier bill';
  }
  if (!isOpenTarget(a.type, a.targetStatus)) {
    return `This ${a.type} is ${a.targetStatus} and cannot take payments`;
  }
  if (a.allocatedAmount + a.otherTxnAllocations > Math.abs(a.txnAmount)) {
    return 'Allocation exceeds the unallocated amount of the bank transaction';
  }
  if (a.allocatedAmount + a.otherPendingOnTarget > a.targetOutstanding) {
    return `Allocation exceeds the outstanding balance of the ${a.type}`;
  }
  return null;
}

export type PostCandidate = {
  status: string;
  invoice_id: string | null;
  bill_id: string | null;
  allocated_amount: number;
  txn_amount: number;
  expense_category_id: string | null;
};

export type PostPlan =
  | { ok: true; type: MatchType; targetId: string; total: number }
  | { ok: false; status: 400 | 409 | 422; error: string };

/** Validates a set of matches that are about to be posted together as one payment. */
export function planPost(matches: PostCandidate[]): PostPlan {
  if (matches.length === 0) return { ok: false, status: 400, error: 'No matches to post' };
  if (matches.some((m) => m.status === 'posted')) {
    return { ok: false, status: 409, error: 'Some matches are already posted' };
  }
  const invoiceIds = new Set(matches.map((m) => m.invoice_id).filter((v): v is string => !!v));
  const billIds = new Set(matches.map((m) => m.bill_id).filter((v): v is string => !!v));
  if (invoiceIds.size + billIds.size !== 1) {
    return { ok: false, status: 400, error: 'All matches in one post must reference the same invoice or bill' };
  }
  const type: MatchType = invoiceIds.size ? 'invoice' : 'bill';
  if (matches.some((m) => (type === 'invoice' ? m.txn_amount <= 0 : m.txn_amount >= 0))) {
    return { ok: false, status: 422, error: 'Transaction direction does not match the invoice/bill' };
  }
  if (type === 'bill' && matches.some((m) => !m.expense_category_id)) {
    // Bill payments without a category are rejected so the P&L never has unclassified spend
    return { ok: false, status: 422, error: 'Select a category on the transaction before posting' };
  }
  return {
    ok: true,
    type,
    targetId: [...(type === 'invoice' ? invoiceIds : billIds)][0],
    total: matches.reduce((sum, m) => sum + m.allocated_amount, 0),
  };
}

/** Deterministic payment id for a set of matches: posting the same set twice collides on the primary key. */
export async function paymentIdFor(matchIds: string[]): Promise<string> {
  const data = new TextEncoder().encode([...matchIds].sort().join('|'));
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', data));
  return Array.from(hash.slice(0, 16), (b) => b.toString(16).padStart(2, '0')).join('');
}
