'use client';

import { useEffect, useRef } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { useAuthStore } from '@/lib/auth';
import { api } from '@/lib/api';
import { NavIcon } from './NavIcon';
import { isActive, visibleFor, type NavItem } from './nav';

// Day-to-day pages. One-time setup and account pages live in the profile menu (ProfileMenu.tsx).
const groups: { label: string; items: NavItem[] }[] = [
  {
    label: 'Books',
    items: [
      { href: '/dashboard', label: 'Dashboard', icon: 'dashboard' },
      { href: '/invoices', label: 'Invoices', icon: 'invoices', ownerOnly: true },
      { href: '/transactions', label: 'Bank', icon: 'bank' },
      { href: '/review', label: 'Review', icon: 'review', accountantOnly: true },
    ],
  },
  {
    label: 'Records',
    items: [
      { href: '/settings/clients', label: 'Clients', icon: 'clients', match: ['/clients'], ownerOnly: true },
      { href: '/settings/vendors', label: 'Vendors', icon: 'vendors', match: ['/vendors'], ownerOnly: true },
    ],
  },
  {
    label: 'Close',
    items: [
      { href: '/reports', label: 'Reports', icon: 'reports' },
      { href: '/export', label: 'Export for accountant', icon: 'export' },
    ],
  },
];

export const MOBILE_NAV_QUERY = '(max-width: 860px)';

interface Props {
  /** Drawer state at phone width; ignored on wider screens, where the sidebar is always shown */
  open: boolean;
  onClose: () => void;
}

export function Sidebar({ open, onClose }: Props) {
  const pathname = usePathname();
  const role = useAuthStore(s => s.role);
  const asideRef = useRef<HTMLElement>(null);

  const { data: reviewCounts } = useQuery<Record<string, number>>({
    queryKey: ['review-counts'],
    queryFn: () => api<Record<string, number>>('/api/v1/transactions/review-counts'),
  });
  const forReview = Object.values(reviewCounts ?? {}).reduce((sum, n) => sum + n, 0);

  // Opening the drawer moves focus into it
  useEffect(() => {
    if (!open || !window.matchMedia(MOBILE_NAV_QUERY).matches) return;
    asideRef.current?.querySelector<HTMLElement>('.nav-link')?.focus();
  }, [open]);

  // Keep Tab inside the open drawer
  function trapFocus(e: React.KeyboardEvent) {
    if (e.key !== 'Tab' || !open || !window.matchMedia(MOBILE_NAV_QUERY).matches) return;
    const focusable = asideRef.current?.querySelectorAll<HTMLElement>('a[href], button:not([disabled])');
    if (!focusable?.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }

  return (
    <aside
      ref={asideRef}
      id="app-sidebar"
      className={`app-sidebar ${open ? 'is-open' : ''}`}
      aria-label="Sidebar"
      onKeyDown={trapFocus}
    >
      <div className="sidebar-head">
        <Link href="/dashboard" className="brand-lockup" onClick={onClose}>
          <img src="/mark.png" alt="" width={34} height={34} className="brand-tile" />
          <span className="brand-mark text-[1.5rem]">LedgerLite</span>
        </Link>
        <button type="button" className="icon-button sidebar-close" onClick={onClose} aria-label="Close menu">
          <NavIcon name="close" className="h-5 w-5" />
        </button>
      </div>

      <nav className="nav-scroll" aria-label="Main navigation">
        {groups.map(group => {
          const items = visibleFor(role, group.items);
          if (!items.length) return null;
          const headingId = `nav-group-${group.label.toLowerCase()}`;
          return (
            <div key={group.label}>
              <p id={headingId} className="nav-label">{group.label}</p>
              <ul className="nav-list" aria-labelledby={headingId}>
                {items.map(item => {
                  const active = isActive(pathname, item);
                  const badge = item.href === '/transactions' && forReview > 0 ? forReview : null;
                  return (
                    <li key={item.href}>
                      <Link
                        href={item.href}
                        aria-current={active ? 'page' : undefined}
                        className={`nav-link ${active ? 'is-active' : ''}`}
                        onClick={onClose}
                      >
                        <NavIcon name={item.icon} />
                        <span className="min-w-0 flex-1 truncate">{item.label}</span>
                        {badge !== null && (
                          <span className="nav-count">
                            {badge > 99 ? '99+' : badge}
                            <span className="sr-only"> waiting for review</span>
                          </span>
                        )}
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </div>
          );
        })}
      </nav>
    </aside>
  );
}
