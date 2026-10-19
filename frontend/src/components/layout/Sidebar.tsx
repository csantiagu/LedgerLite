'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useAuthStore } from '@/lib/auth';
import { logout } from '@/lib/api';
import { ThemeToggle } from '@/components/ThemeToggle';

interface NavItem {
  href: string;
  label: string;
  ownerOnly?: boolean;
  accountantOnly?: boolean;
}

const groups: { label: string; items: NavItem[] }[] = [
  {
    label: 'Books',
    items: [
      { href: '/dashboard', label: 'Dashboard' },
      { href: '/invoices', label: 'Invoices', ownerOnly: true },
      { href: '/transactions', label: 'Bank' },
      { href: '/review', label: 'Review', accountantOnly: true },
    ],
  },
  {
    label: 'Records',
    items: [
      { href: '/settings/clients', label: 'Clients', ownerOnly: true },
      { href: '/settings/vendors', label: 'Vendors', ownerOnly: true },
      { href: '/settings/categories', label: 'Categories', ownerOnly: true },
      { href: '/settings/rules', label: 'Rules', ownerOnly: true },
      { href: '/settings/bank-accounts', label: 'Bank accounts', ownerOnly: true },
    ],
  },
  {
    label: 'Close',
    items: [
      { href: '/reports', label: 'Reports' },
      { href: '/export', label: 'Export for accountant' },
    ],
  },
];

const footerItems: NavItem[] = [
  { href: '/settings/company', label: 'Company', ownerOnly: true },
  { href: '/settings/users', label: 'Settings', ownerOnly: true },
  { href: '/settings/security', label: 'Security' },
];

export function Sidebar() {
  const pathname = usePathname();
  const router = useRouter();
  const role = useAuthStore(s => s.role);

  function visible(items: NavItem[]) {
    return items.filter(item => {
      if (item.ownerOnly && role !== 'owner') return false;
      if (item.accountantOnly && role !== 'accountant') return false;
      return true;
    });
  }

  async function handleLogout() {
    await logout();
    router.replace('/login');
  }

  const NavLink = ({ item }: { item: NavItem }) => {
    const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
    return (
      <Link
        href={item.href}
        aria-current={active ? 'page' : undefined}
        className={`nav-link ${active ? 'is-active' : ''}`}
      >
        {item.label}
      </Link>
    );
  };

  return (
    <aside className="app-sidebar">
      <Link href="/dashboard" className="brand-mark px-2 text-[1.65rem]">
        LedgerLite
      </Link>

      <nav className="nav-scroll" aria-label="Main navigation">
        {groups.map(group => {
          const items = visible(group.items);
          if (!items.length) return null;
          return (
            <div key={group.label}>
              <p className="nav-label">{group.label}</p>
              <div className="space-y-0.5">
                {items.map(item => <NavLink key={item.href} item={item} />)}
              </div>
            </div>
          );
        })}
      </nav>

      <div className="nav-foot">
        {visible(footerItems).map(item => <NavLink key={item.href} item={item} />)}
        <ThemeToggle />
        <button type="button" onClick={handleLogout} className="nav-link">
          Sign out
        </button>
      </div>
    </aside>
  );
}
