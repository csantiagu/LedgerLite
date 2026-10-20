'use client';

import { useState, useRef, useEffect } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { AppShell } from '@/components/layout/AppShell';
import { RoleGuard } from '@/components/RoleGuard';
import { api, API_BASE } from '@/lib/api';
import { useAuthStore } from '@/lib/auth';
import { formatDate } from '@/lib/formatters';

const SettingsSchema = z.object({
  company_name:          z.string().max(200).optional().or(z.literal('')),
  company_reg_number:    z.string().max(50).optional().or(z.literal('')),
  vat_number:            z.string().max(50).optional().or(z.literal('')),
  address:               z.string().max(500).optional().or(z.literal('')),
  email:                 z.string().max(200).optional().or(z.literal('')),
  phone:                 z.string().max(50).optional().or(z.literal('')),
  bank_account_name:     z.string().max(200).optional().or(z.literal('')),
  bank_sort_code:        z.string().max(20).optional().or(z.literal('')),
  bank_account_number:   z.string().max(20).optional().or(z.literal('')),
  bank_name:             z.string().max(200).optional().or(z.literal('')),
  invoice_prefix:        z.string().min(1).max(20).optional().or(z.literal('')),
  invoice_next_sequence: z.coerce.number().int().min(1).optional(),
});

type SettingsForm = z.infer<typeof SettingsSchema>;

interface CompanyRow extends SettingsForm {
  logo_filename?: string | null;
  logo_r2_key?: string | null;
  migration_completed_at?: string | null;
}

export default function CompanySettingsPage() {
  return (
    <AppShell>
      <RoleGuard allowedRoles={['owner']}>
        <CompanySettingsContent />
      </RoleGuard>
    </AppShell>
  );
}

function CompanySettingsContent() {
  const qc = useQueryClient();
  const token = useAuthStore((s) => s.accessToken);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [logoFile, setLogoFile] = useState<File | null>(null);
  const [logoPreview, setLogoPreview] = useState<string | null>(null);
  const [logoError, setLogoError] = useState('');
  const [saved, setSaved] = useState(false);
  const [storedLogoUrl, setStoredLogoUrl] = useState<string | null>(null);

  const { data: settings, isLoading } = useQuery<CompanyRow>({
    queryKey: ['company-settings'],
    queryFn: () => api('/api/v1/settings/company'),
  });

  const {
    register,
    handleSubmit,
    reset,
    formState: { errors, isDirty },
  } = useForm<SettingsForm>({
    resolver: zodResolver(SettingsSchema),
    defaultValues: {},
  });

  // Populate form when data loads
  // An <img> can't send the access token, so fetch the logo and show it from a blob: URL
  const logoKey = settings?.logo_r2_key;
  useEffect(() => {
    if (!logoKey || !token) return;
    let url: string | null = null;
    let cancelled = false;
    fetch(`${API_BASE}/api/v1/settings/company/logo`, {
      headers: { Authorization: `Bearer ${token}` },
      credentials: 'include',
    })
      .then(r => (r.ok ? r.blob() : null))
      .then(blob => {
        if (!blob || cancelled) return;
        url = URL.createObjectURL(blob);
        setStoredLogoUrl(url);
      })
      .catch(() => {});
    return () => { cancelled = true; if (url) URL.revokeObjectURL(url); };
  }, [logoKey, token]);

  useEffect(() => {
    if (settings) {
      reset({
        company_name:          settings.company_name ?? '',
        company_reg_number:    settings.company_reg_number ?? '',
        vat_number:            settings.vat_number ?? '',
        address:               settings.address ?? '',
        email:                 settings.email ?? '',
        phone:                 settings.phone ?? '',
        bank_account_name:     settings.bank_account_name ?? '',
        bank_sort_code:        settings.bank_sort_code ?? '',
        bank_account_number:   settings.bank_account_number ?? '',
        bank_name:             settings.bank_name ?? '',
        invoice_prefix:        settings.invoice_prefix ?? 'INV',
        invoice_next_sequence: settings.invoice_next_sequence ?? 1,
      });
    }
  }, [settings, reset]);

  const save = useMutation({
    mutationFn: (data: SettingsForm) =>
      api('/api/v1/settings/company', {
        method: 'PATCH',
        body: JSON.stringify(data),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['company-settings'] });
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    },
  });

  const uploadLogo = async () => {
    if (!logoFile || !token) return;
    setLogoError('');
    const fd = new FormData();
    fd.append('file', logoFile);
    const res = await fetch(
      `${API_BASE}/api/v1/settings/company/logo`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'X-Requested-With': 'XMLHttpRequest',
        },
        credentials: 'include',
        body: fd,
      }
    );
    if (!res.ok) {
      const j = await res.json().catch(() => ({ error: 'Upload failed' }));
      setLogoError(j.error ?? 'Upload failed');
      return;
    }
    qc.invalidateQueries({ queryKey: ['company-settings'] });
    setLogoFile(null);
    setLogoPreview(null);
    setSaved(true);
    setTimeout(() => setSaved(false), 3000);
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0] ?? null;
    if (!file) return;
    setLogoError('');
    const allowed = ['image/png', 'image/jpeg', 'image/webp'];
    if (!allowed.includes(file.type)) {
      setLogoError('PNG, JPG or WebP only');
      return;
    }
    if (file.size > 2 * 1024 * 1024) {
      setLogoError('Max 2 MB');
      return;
    }
    setLogoFile(file);
    const reader = new FileReader();
    reader.onload = (ev) => setLogoPreview(ev.target?.result as string);
    reader.readAsDataURL(file);
  };

  const onSubmit = handleSubmit(async (data) => {
    await save.mutateAsync(data);
    if (logoFile) await uploadLogo();
  });

  if (isLoading) {
    return (
      <div className="max-w-2xl">
        <div className="h-8 bg-slate-200 rounded animate-pulse w-48 mb-6" />
        <div className="card space-y-4">
          {[...Array(6)].map((_, i) => (
            <div key={i} className="h-10 bg-slate-100 rounded animate-pulse" />
          ))}
        </div>
      </div>
    );
  }

  const logoUrl = storedLogoUrl;

  return (
    <div className="max-w-2xl space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-slate-900">Company settings</h1>
        <p className="mt-1 text-sm text-slate-500">
          Used on invoices and year-end reports.
        </p>
      </div>

      <form onSubmit={onSubmit} className="space-y-6">
        {/* Logo */}
        <div className="card space-y-4">
          <h2 className="text-sm font-semibold text-slate-700">Logo</h2>
          <div className="flex items-start gap-4">
            {/* Preview */}
            <div className="w-24 h-24 border-2 border-dashed border-slate-200 rounded-lg flex items-center justify-center bg-slate-50 overflow-hidden shrink-0">
              {logoPreview ? (
                                <img src={logoPreview} alt="Logo preview" className="w-full h-full object-contain" />
              ) : logoUrl ? (
                                <img
                  src={logoUrl}
                  alt="Company logo"
                  className="w-full h-full object-contain"
                />
              ) : (
                <span className="text-xs text-slate-400 text-center px-2">No logo</span>
              )}
            </div>
            <div className="space-y-2 flex-1">
              <input
                ref={fileInputRef}
                type="file"
                accept="image/png,image/jpeg,image/webp"
                className="hidden"
                onChange={handleFileChange}
              />
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                className="btn-secondary text-sm"
              >
                {logoFile ? logoFile.name : 'Choose file…'}
              </button>
              <p className="text-xs text-slate-400">PNG, JPG or WebP · max 2 MB</p>
              {settings?.logo_filename && !logoFile && (
                <p className="text-xs text-slate-500">Current: {settings.logo_filename}</p>
              )}
              {logoError && <p className="text-xs text-red-600" role="alert">{logoError}</p>}
            </div>
          </div>
        </div>

        {/* Company identity */}
        <div className="card space-y-4">
          <h2 className="text-sm font-semibold text-slate-700">Company identity</h2>

          <div>
            <label className="field-label" htmlFor="company_name">Company name</label>
            <input id="company_name" {...register('company_name')} className="input" placeholder="Acme Consulting Ltd" />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="field-label" htmlFor="company_reg_number">Company registration number</label>
              <input id="company_reg_number" {...register('company_reg_number')} className="input" placeholder="12345678" />
            </div>
            <div>
              <label className="field-label" htmlFor="vat_number">VAT number</label>
              <input id="vat_number" {...register('vat_number')} className="input" placeholder="GB123456789" />
            </div>
          </div>

          <div>
            <label className="field-label" htmlFor="address">Address</label>
            <textarea
              id="address"
              {...register('address')}
              className="input"
              rows={3}
              placeholder={'123 Business Street\nLondon\nEC1A 1BB'}
            />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="field-label" htmlFor="email">Email</label>
              <input id="email" type="email" {...register('email')} className="input" placeholder="accounts@company.co.uk" />
            </div>
            <div>
              <label className="field-label" htmlFor="phone">Phone</label>
              <input id="phone" {...register('phone')} className="input" placeholder="+44 20 1234 5678" />
            </div>
          </div>
        </div>

        {/* Bank details */}
        <div className="card space-y-4">
          <h2 className="text-sm font-semibold text-slate-700">Bank details</h2>
          <p className="text-xs text-slate-500">Printed on invoices so clients know where to send payment.</p>

          <div>
            <label className="field-label" htmlFor="bank_name">Bank name</label>
            <input id="bank_name" {...register('bank_name')} className="input" placeholder="Barclays" />
          </div>

          <div>
            <label className="field-label" htmlFor="bank_account_name">Account name</label>
            <input id="bank_account_name" {...register('bank_account_name')} className="input" placeholder="Acme Consulting Ltd" />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="field-label" htmlFor="bank_sort_code">Sort code</label>
              <input id="bank_sort_code" {...register('bank_sort_code')} className="input" placeholder="20-00-00" />
            </div>
            <div>
              <label className="field-label" htmlFor="bank_account_number">Account number</label>
              <input id="bank_account_number" {...register('bank_account_number')} className="input" placeholder="12345678" />
            </div>
          </div>
        </div>

        {/* Invoice settings */}
        <div className="card space-y-4">
          <h2 className="text-sm font-semibold text-slate-700">Invoice numbering</h2>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="field-label" htmlFor="invoice_prefix">Prefix</label>
              <input id="invoice_prefix" {...register('invoice_prefix')} className="input" placeholder="INV" />
              {errors.invoice_prefix && (
                <p className="field-error">{errors.invoice_prefix.message}</p>
              )}
              <p className="text-xs text-slate-400 mt-1">e.g. INV → INV-0001. Leave empty for plain numbers (1044), as QuickBooks uses.</p>
            </div>
            <div>
              <label className="field-label" htmlFor="invoice_next_sequence">Next sequence number</label>
              <input
                id="invoice_next_sequence"
                type="number"
                min={1}
                {...register('invoice_next_sequence', { valueAsNumber: true })}
                className="input"
                placeholder="1"
              />
              {errors.invoice_next_sequence && (
                <p className="field-error">{errors.invoice_next_sequence.message}</p>
              )}
              <p className="text-xs text-slate-400 mt-1">Next invoice will use this number</p>
            </div>
          </div>
        </div>

        {/* Actions */}
        <div className="flex items-center gap-3">
          <button
            type="submit"
            disabled={save.isPending || (!isDirty && !logoFile)}
            className="btn-primary"
          >
            {save.isPending ? 'Saving…' : 'Save settings'}
          </button>

          {saved && (
            <span className="flex items-center gap-1.5 text-sm text-green-600">
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="h-4 w-4" aria-hidden="true">
                <path fillRule="evenodd" d="M16.704 4.153a.75.75 0 0 1 .143 1.052l-8 10.5a.75.75 0 0 1-1.127.075l-4.5-4.5a.75.75 0 0 1 1.06-1.06l3.894 3.893 7.48-9.817a.75.75 0 0 1 1.05-.143Z" clipRule="evenodd" />
              </svg>
              Saved
            </span>
          )}

          {save.isError && (
            <span className="text-sm text-red-600">Save failed — try again</span>
          )}
        </div>
      </form>

      <MigrationCard completedAt={settings?.migration_completed_at ?? null} />
    </div>
  );
}

/**
 * While the QuickBooks migration is open, Find match on a bank receipt also offers paid invoices
 * imported from QuickBooks, so old receipts can be linked to their payment. Marking it complete
 * leaves only open invoices and bills; it can be reopened to link a late statement.
 */
function MigrationCard({ completedAt }: { completedAt: string | null }) {
  const qc = useQueryClient();
  const complete = !!completedAt;
  const toggle = useMutation({
    mutationFn: (next: boolean) =>
      api('/api/v1/settings/company/migration', { method: 'PUT', body: JSON.stringify({ complete: next }) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['company-settings'] }),
  });
  const onClick = () => {
    const next = !complete;
    const message = next
      ? 'Mark the QuickBooks migration complete? Find match will then only offer open invoices and bills.'
      : 'Reopen the QuickBooks migration? Find match will offer paid QuickBooks invoices again for linking.';
    if (window.confirm(message)) toggle.mutate(next);
  };

  return (
    <div className="card space-y-3">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-sm font-semibold text-slate-700">QuickBooks migration</h2>
          <p className="mt-1 text-xs text-slate-500">
            {completedAt
              ? `Marked complete on ${formatDate(completedAt)}. Find match only offers open invoices and bills.`
              : 'In progress. Find match on a bank receipt also offers paid invoices imported from QuickBooks, so old receipts can be linked to their payment.'}
          </p>
        </div>
        <span className={`badge shrink-0 ${complete ? 'badge-green' : 'badge-yellow'}`}>
          {complete ? 'Complete' : 'In progress'}
        </span>
      </div>
      <div className="flex items-center gap-3">
        <button type="button" onClick={onClick} disabled={toggle.isPending}
          className={complete ? 'btn-secondary text-sm' : 'btn-primary text-sm'}>
          {toggle.isPending ? 'Saving…' : complete ? 'Reopen migration' : 'Mark migration complete'}
        </button>
        {toggle.isError && <span className="text-sm text-red-600" role="alert">{(toggle.error as Error).message}</span>}
      </div>
    </div>
  );
}
