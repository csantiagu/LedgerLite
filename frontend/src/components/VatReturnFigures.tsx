'use client';

import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { formatPence } from '@/lib/formatters';

type VatReturn = {
  scheme: 'standard' | 'cash';
  box1: number; box2: number; box3: number; box4: number; box5: number;
  box6: number; box7: number; box8: number; box9: number;
  parts: Array<{ source: string; vat: number; net: number; count: number }>;
  vatNotSet: number;
};

const BOXES: Array<[keyof VatReturn, string]> = [
  ['box1', 'VAT due on sales'],
  ['box2', 'VAT due on goods from the EU (Northern Ireland only)'],
  ['box3', 'Total VAT due'],
  ['box4', 'VAT reclaimed on purchases'],
  ['box5', 'Net VAT to pay (or reclaim, if negative)'],
  ['box6', 'Total sales, excluding VAT'],
  ['box7', 'Total purchases, excluding VAT'],
  ['box8', 'Goods supplied to the EU (Northern Ireland only)'],
  ['box9', 'Goods acquired from the EU (Northern Ireland only)'],
];

/** The nine VAT return boxes for a period, worked out from the books, with where they came from. */
export function VatReturnFigures({ from, to }: { from: string; to: string }) {
  const { data, isLoading, error } = useQuery({
    queryKey: ['vat-return', from, to],
    queryFn: () => api<VatReturn>(`/api/v1/reports/vat-return?from=${from}&to=${to}`),
  });
  if (isLoading) return <p className="text-sm text-slate-500">Working out the VAT return…</p>;
  if (error || !data) return <p className="text-sm text-red-700" role="alert">{(error as Error)?.message ?? 'Could not load'}</p>;

  return (
    <div className="space-y-3 text-sm">
      <table className="w-full">
        <tbody className="divide-y divide-slate-100">
          {BOXES.map(([key, label], i) => (
            <tr key={key} className={key === 'box5' ? 'font-semibold' : ''}>
              <td className="py-1 pr-2 text-slate-500 tabular-nums w-14">Box {i + 1}</td>
              <td className="py-1 pr-2 text-slate-700">{label}</td>
              <td className="py-1 text-right tabular-nums">{formatPence(data[key] as number)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="text-xs text-slate-500">
        {data.scheme === 'cash' ? 'Cash accounting: counted when money was paid.' : 'Standard accounting: counted by invoice, credit note and bill date.'}
        {' '}HMRC wants boxes 6 to 9 in whole pounds. Sales outside the scope of UK VAT are in box 6.
      </p>
      {data.vatNotSet > 0 && (
        <p className="text-xs text-amber-800">
          {data.vatNotSet} posted bank line{data.vatNotSet === 1 ? ' has' : 's have'} no VAT chosen, counted as no VAT.
        </p>
      )}
      {data.parts.length > 0 && (
        <details className="text-xs text-slate-600">
          <summary className="cursor-pointer text-slate-500">Where the figures come from</summary>
          <table className="mt-1 w-full">
            <thead>
              <tr className="text-slate-500"><th className="text-left font-normal">Source</th><th className="text-right font-normal">Items</th><th className="text-right font-normal">Net</th><th className="text-right font-normal">VAT</th></tr>
            </thead>
            <tbody>
              {data.parts.map(p => (
                <tr key={p.source}>
                  <td className="py-0.5">{p.source}</td>
                  <td className="py-0.5 text-right tabular-nums">{p.count}</td>
                  <td className="py-0.5 text-right tabular-nums">{formatPence(p.net)}</td>
                  <td className="py-0.5 text-right tabular-nums">{formatPence(p.vat)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      )}
    </div>
  );
}
