'use client';

import { useRef, useState } from 'react';
import { API_BASE } from '@/lib/api';

export type Txn = {
  id: string;
  bank_account_id: string;
  date: string;
  description: string;
  reference?: string | null;
  amount: number;
  expense_category_id: string | null;
  category_name?: string | null;
  vat_rate?: number | null;        // VAT included: 0 = none, 0.2 = 20%; null = not chosen
  is_reconciled: number;
  reviewed_at?: string | null;
  flagged: number;
  notes: string | null;
  accountant_notes: string | null;
  attachment_r2_key: string | null;
  attachment_filename: string | null;
  categorised_by_rule_id: string | null;
  match_id?: string | null;
  match_status?: 'suggested' | 'pending' | 'posted' | null;
  match_kind?: 'payment' | 'link' | null;
  match_type?: 'invoice' | 'bill' | null;
  match_target_id?: string | null;
  match_allocated?: number | null;
  match_label?: string | null;
  allocated_total?: number;
  /** Extra on this money-out line that the supplier still has to return */
  overpayment_amount?: number;
};

export type Page<T> = { rows: T[]; total: number; page: number; pageSize: number };

export type Category = { id: string; name: string; default_vat_rate?: number | null };

const authHeaders = (token: string) => ({ Authorization: `Bearer ${token}`, 'X-Requested-With': 'XMLHttpRequest' });

/** Opens a line's receipt in a new tab, from a blob: URL on our own origin. */
export async function openReceipt(token: string | null, transactionId: string) {
  if (!token) return;
  const res = await fetch(`${API_BASE}/api/v1/transactions/${transactionId}/attachments`, {
    headers: authHeaders(token),
    credentials: 'include',
  });
  if (!res.ok) return;
  const url = URL.createObjectURL(await res.blob());
  window.open(url, '_blank', 'noopener,noreferrer');
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

async function uploadReceipt(token: string, transactionId: string, file: File) {
  const form = new FormData();
  form.append('file', file);
  const res = await fetch(`${API_BASE}/api/v1/transactions/${transactionId}/attachments`, {
    method: 'POST',
    headers: authHeaders(token),
    credentials: 'include',
    body: form,
  });
  if (!res.ok) {
    const payload = await res.json().catch(() => null) as { error?: string } | null;
    throw new Error(payload?.error ?? 'Upload failed');
  }
}

/** Attach or replace the supplier invoice / receipt on a line. */
export function ReceiptField({
  txn, token, onSaved,
}: {
  txn: Pick<Txn, 'id' | 'attachment_r2_key' | 'attachment_filename'>;
  token: string | null;
  onSaved: () => void;
}) {
  const [uploading, setUploading] = useState(false);
  const [err, setErr] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);

  const upload = async (file: File) => {
    if (!token) return;
    setUploading(true);
    setErr('');
    try {
      await uploadReceipt(token, txn.id, file);
      onSaved();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const input = (
    <input ref={fileRef} type="file" accept=".pdf,.png,.jpg,.jpeg,.webp" className="sr-only" disabled={uploading}
      onChange={e => { const f = e.target.files?.[0]; if (f) upload(f); }} />
  );

  return (
    <div>
      {txn.attachment_r2_key ? (
        <div className="flex items-center gap-2 p-2.5 rounded-lg border border-slate-200 bg-slate-50/80 text-sm">
          <span className="flex-1 truncate text-slate-700">{txn.attachment_filename ?? 'Attached'}</span>
          <button type="button" onClick={() => openReceipt(token, txn.id)} className="text-blue-600 hover:text-blue-800 text-xs shrink-0">View</button>
          <label className="text-xs text-slate-500 hover:text-slate-700 cursor-pointer shrink-0">
            {uploading ? 'Uploading…' : 'Replace'}
            {input}
          </label>
        </div>
      ) : (
        <label className={`flex items-center gap-2 p-2.5 rounded-lg border-2 border-dashed cursor-pointer transition-colors ${
          uploading ? 'border-blue-300 bg-blue-50' : 'border-slate-300 hover:border-blue-400 hover:bg-blue-50'
        }`}>
          <span className="text-xs font-medium text-slate-600">
            {uploading ? 'Uploading…' : 'Attach supplier invoice (PDF / image)'}
          </span>
          {input}
        </label>
      )}
      {err && <p className="text-xs text-red-600 mt-1" role="alert">{err}</p>}
    </div>
  );
}

export { Pager } from '@/components/Pager';

export const amountClass = (amount: number) =>
  `font-medium whitespace-nowrap tabular-nums ${amount < 0 ? 'text-red-600' : 'text-green-600'}`;

/** Shrinks the 44px .input / .btn-* controls for dense tables and toolbars. */
export const compactControl = 'min-h-8 rounded-lg px-2 py-1 text-xs';
