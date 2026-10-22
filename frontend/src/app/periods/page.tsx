'use client';

import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { AppShell } from '@/components/layout/AppShell';
import { usePeriods } from '@/components/PeriodLock';
import { VatReturnFigures } from '@/components/VatReturnFigures';
import { api } from '@/lib/api';
import { useAuthStore } from '@/lib/auth';
import { formatDate, formatDateTime, formatPence } from '@/lib/formatters';
import { alsoLocks, unlockable, type PeriodQuarter, type Periods } from '@/lib/periods';

export default function PeriodsPage() {
  return (
    <AppShell>
      <PeriodsContent />
    </AppShell>
  );
}

const STATUS: Record<PeriodQuarter['status'], { label: string; badge: string }> = {
  locked:  { label: 'Locked', badge: 'badge-green' },
  ended:   { label: 'Ended, not locked', badge: 'badge-yellow' },
  current: { label: 'Current quarter', badge: 'badge-blue' },
};

function PeriodsContent() {
  const qc = useQueryClient();
  const role = useAuthStore(s => s.role);
  const { data, isLoading, error } = usePeriods();
  const [locking, setLocking] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [unlocking, setUnlocking] = useState(false);
  const [showingReturn, setShowingReturn] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [message, setMessage] = useState<{ text: string; error?: boolean } | null>(null);

  const done = (text: string) => {
    setMessage({ text });
    setLocking(null); setNote(''); setUnlocking(false); setReason('');
    qc.invalidateQueries({ queryKey: ['periods'] });
  };
  const lock = useMutation({
    mutationFn: (periodEnd: string) =>
      api('/api/v1/periods/lock', { method: 'POST', body: JSON.stringify({ periodEnd, note: note || undefined }) }),
    onSuccess: (_r, periodEnd) => done(`Locked everything up to ${formatDate(periodEnd)}.`),
    onError: (err: Error) => setMessage({ text: err.message, error: true }),
  });
  const unlock = useMutation({
    mutationFn: () => api<{ lockDate: string | null }>('/api/v1/periods/unlock', { method: 'POST', body: JSON.stringify({ reason }) }),
    onSuccess: r => done(r.lockDate ? `Unlocked. Everything up to ${formatDate(r.lockDate)} stays locked.` : 'Unlocked. No period is locked now.'),
    onError: (err: Error) => setMessage({ text: err.message, error: true }),
  });

  if (isLoading) return <div className="card h-48 animate-pulse bg-slate-50" />;
  if (error || !data) return <p className="text-sm text-red-700" role="alert">{(error as Error)?.message ?? 'Could not load periods'}</p>;
  const latestLocked = unlockable(data);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-slate-900">VAT periods</h1>
        <p className="mt-1 text-sm text-slate-500">
          Once the accountant has reviewed a quarter, lock it. Bank lines, bills, payments and new sales
          invoices dated in it, or before it, can&rsquo;t be changed by accident. A credit note, a void, or a
          VAT-only invoice still can: that is how a quarter already sent to HMRC is corrected, including
          VAT charged back to your registration date. Only the owner can unlock a quarter, and has to say why.
          {data.lockDate ? <> Locked up to <strong>{formatDate(data.lockDate)}</strong>.</> : ' Nothing is locked yet.'}
        </p>
      </div>

      {message && (
        <p className={`text-sm ${message.error ? 'text-red-700' : 'text-slate-700'}`} role={message.error ? 'alert' : 'status'}>{message.text}</p>
      )}

      <div className="card p-0 overflow-hidden">
        <ul className="divide-y divide-slate-100">
          {data.quarters.map(q => (
            <li key={q.end} className="px-4 py-3 space-y-2">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="min-w-0">
                  <p className="font-medium text-slate-900">
                    {q.label}
                    <span className={`badge ${STATUS[q.status].badge} ml-2 align-middle`}>{STATUS[q.status].label}</span>
                    {q.changedSinceLocked.length > 0 && (
                      <span className="badge badge-yellow ml-2 align-middle"
                        title={q.changedSinceLocked.map(ch => `Box ${ch.box.slice(3)}: ${formatPence(ch.before)} → ${formatPence(ch.now)}`).join('\n')}>
                        Changed since locked
                      </span>
                    )}
                  </p>
                  <p className="text-xs text-slate-500">
                    {formatDate(q.start)} – {formatDate(q.end)}
                    {q.lock && ` · locked ${formatDateTime(q.lock.locked_at)} by ${q.lock.locked_by_name}`}
                    {q.lock?.note && ` · “${q.lock.note}”`}
                  </p>
                  {q.status !== 'current' && (
                    <button type="button" className="mt-1 text-xs text-blue-600 hover:text-blue-800"
                      aria-expanded={showingReturn === q.end}
                      onClick={() => setShowingReturn(v => (v === q.end ? null : q.end))}>
                      {showingReturn === q.end ? 'Hide VAT return figures' : 'VAT return figures'}
                    </button>
                  )}
                  {q.changedSinceLocked.length > 0 && (
                    <p className="text-xs text-amber-800">
                      {q.changedSinceLocked.map(ch => `Box ${ch.box.slice(3)} ${formatPence(ch.before)} → ${formatPence(ch.now)}`).join(' · ')}
                    </p>
                  )}
                  {q.unposted > 0 && (
                    <p className="text-xs text-amber-800">
                      {q.unposted} bank line{q.unposted === 1 ? '' : 's'} still in{' '}
                      <Link href="/transactions" className="underline">For Review</Link>
                    </p>
                  )}
                </div>
                <QuarterActions
                  q={q} data={data} role={role}
                  isLatestLocked={latestLocked?.end === q.end}
                  onLock={() => { setMessage(null); setUnlocking(false); setLocking(q.end); }}
                  onUnlock={() => { setMessage(null); setLocking(null); setUnlocking(true); }}
                />
              </div>

              {showingReturn === q.end && (
                <div className="rounded-lg border border-slate-200 p-3">
                  <VatReturnFigures from={q.start} to={q.end} />
                </div>
              )}

              {locking === q.end && (
                <div className="rounded-lg border border-slate-200 bg-slate-50 p-3 space-y-2 text-sm">
                  <p>
                    Lock {q.label}?
                    {alsoLocks(data, q).length > 0 && ` This also locks ${alsoLocks(data, q).map(o => o.label).join(', ')}.`}
                    {' '}Nothing dated on or before {formatDate(q.end)} can be changed afterwards.
                  </p>
                  <label htmlFor="lock-note" className="field-label">Note (optional)</label>
                  <input id="lock-note" className="input" value={note} onChange={e => setNote(e.target.value)}
                    placeholder="e.g. VAT return filed 7 Aug" maxLength={1000} />
                  <div className="flex gap-2">
                    <button type="button" className="btn-primary text-sm" disabled={lock.isPending} onClick={() => lock.mutate(q.end)}>
                      {lock.isPending ? 'Locking…' : `Lock ${q.label}`}
                    </button>
                    <button type="button" className="btn-secondary text-sm" onClick={() => setLocking(null)}>Cancel</button>
                  </div>
                </div>
              )}

              {unlocking && latestLocked?.end === q.end && (
                <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 space-y-2 text-sm text-amber-900">
                  <p>Unlock {q.label}? Its figures can be changed again until it&rsquo;s locked once more. The accountant sees why in the audit trail.</p>
                  <label htmlFor="unlock-reason" className="field-label">Reason</label>
                  <input id="unlock-reason" className="input" value={reason} onChange={e => setReason(e.target.value)}
                    placeholder="e.g. Supplier credit note arrived late" maxLength={1000} />
                  <div className="flex gap-2">
                    <button type="button" className="btn-danger text-sm" disabled={unlock.isPending || reason.trim().length < 3}
                      onClick={() => unlock.mutate()}>
                      {unlock.isPending ? 'Unlocking…' : `Unlock ${q.label}`}
                    </button>
                    <button type="button" className="btn-secondary text-sm" onClick={() => setUnlocking(false)}>Cancel</button>
                  </div>
                </div>
              )}
            </li>
          ))}
        </ul>
      </div>

      {data.history.some(h => h.unlocked_at) && (
        <div className="card">
          <h2 className="text-base font-semibold text-slate-900 mb-2">Unlocked quarters</h2>
          <ul className="divide-y divide-slate-100 text-sm">
            {data.history.filter(h => h.unlocked_at).map(h => (
              <li key={h.id} className="py-2">
                <p className="text-slate-800">Up to {formatDate(h.period_end)}: unlocked {formatDateTime(h.unlocked_at!)} by {h.unlocked_by_name}</p>
                <p className="text-xs text-slate-500">Reason: {h.unlock_reason} · had been locked {formatDateTime(h.locked_at)} by {h.locked_by_name}</p>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function QuarterActions({ q, data, role, isLatestLocked, onLock, onUnlock }: {
  q: PeriodQuarter; data: Periods; role: string | null; isLatestLocked: boolean; onLock: () => void; onUnlock: () => void;
}) {
  if (q.status === 'ended' && (role === 'owner' || role === 'accountant')) {
    const waiting = alsoLocks(data, q).reduce((n, o) => n + o.unposted, q.unposted);
    const earlier = waiting - q.unposted;
    return (
      <span className="flex items-center gap-2">
        {earlier > 0 && (
          <span className="text-xs text-slate-500">
            Post the {earlier} line{earlier === 1 ? '' : 's'} waiting in earlier quarters first
          </span>
        )}
        <button type="button" className="btn-secondary text-sm" disabled={waiting > 0} onClick={onLock}
          title={waiting ? 'Post the bank lines still in For Review first' : undefined}>
          Lock…
        </button>
      </span>
    );
  }
  if (q.status === 'locked' && isLatestLocked && role === 'owner') {
    return <button type="button" className="btn-secondary text-sm" onClick={onUnlock}>Unlock…</button>;
  }
  return null;
}
