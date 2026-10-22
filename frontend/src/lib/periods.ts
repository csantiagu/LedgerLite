// VAT quarters as the API reports them (GET /api/v1/periods), and what can be done with each.

export type PeriodLock = {
  id: string; period_start: string; period_end: string; locked_at: string; locked_by_name: string; note: string | null;
  unlocked_at: string | null; unlocked_by_name: string | null; unlock_reason: string | null;
};

export type PeriodQuarter = {
  start: string; end: string; label: string;
  status: 'locked' | 'ended' | 'current';
  unposted: number;
  lock: PeriodLock | null;
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
