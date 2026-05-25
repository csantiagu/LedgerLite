import Link from 'next/link';
import type { Metadata } from 'next';

export const metadata: Metadata = { title: 'Access denied' };

export default function ForbiddenPage() {
  return (
    <div className="flex min-h-dvh items-center justify-center px-4">
      <div className="text-center">
        <p className="text-sm font-semibold uppercase tracking-wide text-blue-600">403</p>
        <h1 className="mt-2 text-3xl font-bold text-slate-900">Access denied</h1>
        <p className="mt-3 text-slate-500">You don't have permission to view this page.</p>
        <Link href="/dashboard" className="btn-primary mt-6 inline-flex">
          Back to dashboard
        </Link>
      </div>
    </div>
  );
}
