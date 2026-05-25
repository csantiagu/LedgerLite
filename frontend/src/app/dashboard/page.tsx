'use client';

import type { Metadata } from 'next';
import { useQuery } from '@tanstack/react-query';
import { AppShell } from '@/components/layout/AppShell';
import { api } from '@/lib/api';
import { formatPence } from '@/lib/formatters';
import Link from 'next/link';

type DashboardData = {
  outstanding_pence: number;
  overdue_pence: number;
  unpaid_bills_pence: number;
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
  label, value, sub, color, href,
}: {
  label: string; value: string; sub: string; color: string; href?: string;
}) {
  const inner = (
    <div className="card hover:shadow-md transition-shadow">
      <p className="text-xs font-medium uppercase tracking-wide text-slate-500">{label}</p>
      <p className={`mt-2 text-3xl font-bold tabular-nums ${color}`}>{value}</p>
      <p className="mt-1 text-xs text-slate-400">{sub}</p>
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

  const kpis = [
    {
      label: 'Outstanding invoices',
      value: isLoading ? '…' : formatPence(data?.outstanding_pence ?? 0),
      sub: 'awaiting payment',
      color: 'text-blue-600',
      href: '/invoices',
    },
    {
      label: 'Overdue',
      value: isLoading ? '…' : formatPence(data?.overdue_pence ?? 0),
      sub: 'past due date',
      color: 'text-red-600',
      href: '/invoices',
    },
    {
      label: 'Unpaid bills',
      value: isLoading ? '…' : formatPence(data?.unpaid_bills_pence ?? 0),
      sub: 'to be settled',
      color: 'text-amber-600',
    },
    {
      label: 'YTD revenue',
      value: isLoading ? '…' : formatPence(data?.ytd_revenue_pence ?? 0),
      sub: 'this tax year',
      color: 'text-green-600',
    },
  ];

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-bold text-slate-900">Dashboard</h1>
        <p className="mt-1 text-sm text-slate-500">Your financial overview at a glance.</p>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {kpis.map(({ label, value, sub, color, href }) => (
          <KpiCard key={label} label={label} value={value} sub={sub} color={color} href={href} />
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
