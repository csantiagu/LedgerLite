'use client';

import type { Metadata } from 'next';
import { useQuery } from '@tanstack/react-query';
import { PeriodPrompt } from '@/components/PeriodLock';
import { BackupPrompt } from '@/components/BackupPrompt';
import { AppShell } from '@/components/layout/AppShell';
import { api } from '@/lib/api';
import { formatPence } from '@/lib/formatters';
import Link from 'next/link';

type DashboardData = {
  outstanding_pence: number;
  overdue_pence: number;
  unpaid_bills_pence: number;
  refunds_due_pence: number;
  ytd_revenue_pence: number;
};

export default function DashboardPage() {
  return (
    <AppShell>
      <DashboardContent />
    </AppShell>
  );
}

function KpiCard({
  label, value, sub, tone, href,
}: {
  label: string; value: string; sub: string; tone?: 'signal'; href?: string;
}) {
  const inner = (
    <div className="card">
      <p className="eyebrow">{label}</p>
      <p className={`figure mt-3 text-3xl ${tone === 'signal' ? 'text-red-700' : 'text-slate-900'}`}>{value}</p>
      <p className="mt-1 text-xs text-slate-500">{sub}</p>
    </div>
  );
  return href ? <Link href={href}>{inner}</Link> : inner;
}

function DashboardContent() {
  const { data, isLoading } = useQuery<DashboardData>({
    queryKey: ['dashboard'],
    queryFn: () => api<DashboardData>('/api/v1/reports/dashboard'),
    staleTime: 30_000,
  });

  const kpis: { label: string; value: string; sub: string; tone?: 'signal'; href?: string }[] = [
    {
      label: 'Outstanding invoices',
      value: isLoading ? '…' : formatPence(data?.outstanding_pence ?? 0),
      sub: 'awaiting payment',
      href: '/invoices',
    },
    {
      label: 'Overdue',
      value: isLoading ? '…' : formatPence(data?.overdue_pence ?? 0),
      sub: 'past due date',
      tone: 'signal' as const,
      href: '/invoices',
    },
    {
      label: 'Unpaid bills',
      value: isLoading ? '…' : formatPence(data?.unpaid_bills_pence ?? 0),
      sub: 'to be settled',
    },
    {
      label: 'Refunds to pay',
      value: isLoading ? '…' : formatPence(data?.refunds_due_pence ?? 0),
      sub: 'credit not yet refunded',
      tone: (data?.refunds_due_pence ?? 0) > 0 ? 'signal' as const : undefined,
      href: '/invoices',
    },
    {
      label: 'YTD revenue',
      value: isLoading ? '…' : formatPence(data?.ytd_revenue_pence ?? 0),
      sub: 'received this year, net of VAT',
    },
  ];

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-bold text-slate-900">Dashboard</h1>
        <p className="mt-1 text-sm text-slate-500">Your financial overview at a glance.</p>
      </div>

      <PeriodPrompt />
      <BackupPrompt />

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-5">
        {kpis.map(({ label, value, sub, tone, href }) => (
          <KpiCard key={label} label={label} value={value} sub={sub} tone={tone} href={href} />
        ))}
      </div>

      <div className="card">
        <h2 className="text-base font-semibold text-slate-900 mb-4">Quick actions</h2>
        <div className="flex flex-wrap gap-3">
          <Link href="/invoices/new" className="btn-primary">
            New invoice
          </Link>
          <Link href="/settings/clients" className="btn-secondary">
            Add client
          </Link>
        </div>
      </div>
    </div>
  );
}
