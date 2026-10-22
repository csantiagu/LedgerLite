'use client';

import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { formatDate } from '@/lib/formatters';
import { awaitingReview, isLocked, type Periods } from '@/lib/periods';

/** The VAT quarters and lock date, shared by every page that asks. */
export function usePeriods() {
  return useQuery({ queryKey: ['periods'], queryFn: () => api<Periods>('/api/v1/periods') });
}

/** "Reviewed quarter" next to a record dated on or before the lock date. */
export function LockedBadge({ date, className = '' }: { date: string | null | undefined; className?: string }) {
  const { data } = usePeriods();
  if (!isLocked(date, data?.lockDate)) return null;
  return (
    <span
      className={`badge badge-gray ${className}`}
      title={`Reviewed VAT quarter, locked up to ${formatDate(data!.lockDate!)}. Bank lines, bills, payments and new sales invoices dated here stay as they were. A credit note, a void or a VAT-only invoice can still be raised.`}
    >
      Reviewed quarter
    </span>
  );
}

/** Shown when a date the user is about to use sits in a reviewed quarter. It does not block them. */
export function LockedPeriodNote({ date }: { date: string }) {
  const { data } = usePeriods();
  if (!isLocked(date, data?.lockDate)) return null;
  return (
    <p className="text-sm text-amber-800">
      {formatDate(date)} is in a reviewed VAT quarter (locked up to {formatDate(data!.lockDate!)}).
      This still goes through, and it changes that quarter&rsquo;s VAT figures. Use a later date if the
      correction should wait for the next return.
    </p>
  );
}

/** Dashboard prompt when a quarter has ended and isn't locked yet. */
export function PeriodPrompt() {
  const { data } = usePeriods();
  const quarter = data && awaitingReview(data);
  if (!quarter) return null;
  return (
    <div className="card flex flex-wrap items-center justify-between gap-3 border-amber-200 bg-amber-50 text-sm text-amber-900">
      <p>
        The VAT quarter <strong>{quarter.label}</strong> has ended and isn&rsquo;t locked yet.
        {quarter.unposted > 0 && ` ${quarter.unposted} bank line${quarter.unposted === 1 ? ' is' : 's are'} still in For Review.`}
      </p>
      <Link href="/periods" className="btn-secondary text-sm">Review VAT periods</Link>
    </div>
  );
}
