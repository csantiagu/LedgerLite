// VAT quarters as the API reports them (GET /api/v1/periods), and what can be done with each.

export type PeriodLock = {
  id: string; period_start: string; period_end: string; locked_at: string; locked_by_name: string; note: string | null;
  unlocked_at: string | null; unlocked_by_name: string | null; unlock_reason: string | null;
};

export type VatBoxes = Record<'box1' | 'box2' | 'box3' | 'box4' | 'box5' | 'box6' | 'box7' | 'box8' | 'box9', number>;
export type BoxChange = { box: keyof VatBoxes; before: number; now: number };

export type PeriodQuarter = {
  start: string; end: string; label: string;
  status: 'locked' | 'ended' | 'current';
  unposted: number;
  lock: PeriodLock | null;
  /** The VAT figures when it was locked */
  snapshot: { boxes: VatBoxes; taken_at: string; scheme: string } | null;
  /** Boxes that have moved since it was locked (credit notes, voids or VAT-only invoices dated in it) */
  changedSinceLocked: BoxChange[];
};

export type Periods = {
  lockDate: string | null;
  quarterEndMonth: number;
  quarters: PeriodQuarter[];     // newest first
  history: PeriodLock[];
};

/** Whether a date is on or before the lock date, so nothing dated then can change. */
export const isLocked = (date: string | null | undefined, lockDate: string | null | undefined) =>
  !!lockDate && !!date && date.slice(0, 10) <= lockDate;

/** What the void confirmation says: voiding a reviewed quarter's invoice changes its filed VAT figures. */
export function voidConfirmText(kind: 'invoice' | 'credit_note', issueDate: string, lockDate: string | null | undefined): string {
  const what = kind === 'credit_note' ? 'credit note' : 'invoice';
  if (!isLocked(issueDate, lockDate)) return `Void this ${what}? This cannot be undone.`;
  return `This ${what} is in a VAT quarter that has been reviewed and locked. Voiding it changes that quarter's `
    + 'VAT figures after they were filed (the VAT periods page will show the difference). To correct a filed '
    + `invoice, a credit note dated today is usually better.\n\nVoid this ${what} anyway? This cannot be undone.`;
}

/** The newest quarter still locked: the only one that can be unlocked. */
export const unlockable = (p: Pick<Periods, 'quarters' | 'lockDate'>) =>
  p.lockDate ? p.quarters.find(q => q.end === p.lockDate) ?? null : null;

/** Locking this quarter also locks every open quarter before it. */
export const alsoLocks = (p: Pick<Periods, 'quarters'>, q: PeriodQuarter) =>
  p.quarters.filter(o => o.status === 'ended' && o.end < q.end);

/** The newest quarter that has ended but isn't locked: the one waiting for review. */
export const awaitingReview = (p: Pick<Periods, 'quarters'>) =>
  p.quarters.find(q => q.status === 'ended') ?? null;

/** Choices for "quarters end in": one per stagger, named by its four months. */
export const QUARTER_STAGGERS = [
  { value: 3, label: 'Mar, Jun, Sep, Dec' },
  { value: 1, label: 'Jan, Apr, Jul, Oct' },
  { value: 2, label: 'Feb, May, Aug, Nov' },
];

/** Any quarter end month (1–12) as its stagger's value (1, 2 or 3). */
export const staggerOf = (month: number) => ((month - 1) % 3) + 1;
