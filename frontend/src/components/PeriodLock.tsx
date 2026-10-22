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

/** "Locked period" next to a record dated on or before the lock date. */
export function LockedBadge({ date, className = '' }: { date: string | null | undefined; className?: string }) {
  const { data } = usePeriods();
  if (!isLocked(date, data?.lockDate)) return null;
  return (
    <span
      className={`badge badge-gray ${className}`}
      title={`Everything up to ${formatDate(data!.lockDate!)} is in a reviewed, locked VAT period and can't be changed.`}
    >
      🔒 Locked period
    </span>
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
