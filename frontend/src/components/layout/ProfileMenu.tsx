'use client';

import { useEffect, useId, useRef, useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { initialsFor, tokenEmail, useAuthStore } from '@/lib/auth';
import { logout } from '@/lib/api';
import { ThemeToggle } from '@/components/ThemeToggle';
import { NavIcon } from './NavIcon';
import { isActive, visibleFor, type NavItem } from './nav';

// One-time setup and account pages, kept out of the day-to-day sidebar
const setupItems: NavItem[] = [
  { href: '/settings/company', label: 'Company', icon: 'company', ownerOnly: true },
  { href: '/settings/categories', label: 'Categories', icon: 'categories', ownerOnly: true },
  { href: '/settings/rules', label: 'Rules', icon: 'rules', ownerOnly: true },
  { href: '/settings/bank-accounts', label: 'Bank accounts', icon: 'bank-accounts', ownerOnly: true },
  { href: '/settings/users', label: 'Users', icon: 'users', ownerOnly: true },
];

const accountItems: NavItem[] = [
  { href: '/settings/security', label: 'Security', icon: 'security' },
];

/**
 * Disclosure menu (a button that shows a panel of links): Tab moves through it as normal,
 * arrow keys move between items, Escape or a click outside closes it.
 */
export function ProfileMenu() {
  const [open, setOpen] = useState(false);
  const pathname = usePathname();
  const router = useRouter();
  const role = useAuthStore(s => s.role);
  const email = useAuthStore(s => tokenEmail(s.accessToken));
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelId = useId();

  const setup = visibleFor(role, setupItems);
  const account = visibleFor(role, accountItems);
  const onMenuPage = [...setup, ...account].some(item => isActive(pathname, item));

  useEffect(() => {
    if (!open) return;
    function onPointerDown(e: PointerEvent) {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    }
    function onKeyDown(e: KeyboardEvent) {
      if (e.key !== 'Escape') return;
      setOpen(false);
      buttonRef.current?.focus();
    }
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  function items() {
    return Array.from(rootRef.current?.querySelectorAll<HTMLElement>('.menu-panel a, .menu-panel button') ?? []);
  }

  function focusItem(index: 'first' | 'last' | number) {
    const list = items();
    if (!list.length) return;
    const i = index === 'first' ? 0 : index === 'last' ? list.length - 1 : (index + list.length) % list.length;
    list[i].focus();
  }

  function onButtonKeyDown(e: React.KeyboardEvent) {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    const target = e.key === 'ArrowDown' ? 'first' : 'last';
    if (open) focusItem(target);
    else {
      setOpen(true);
      requestAnimationFrame(() => focusItem(target));
    }
  }

  function onPanelKeyDown(e: React.KeyboardEvent) {
    const current = items().indexOf(document.activeElement as HTMLElement);
    if (e.key === 'ArrowDown') { e.preventDefault(); focusItem(current + 1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); focusItem(current - 1); }
    else if (e.key === 'Home') { e.preventDefault(); focusItem('first'); }
    else if (e.key === 'End') { e.preventDefault(); focusItem('last'); }
  }

  // Tabbing out of the menu closes it
  function onBlur(e: React.FocusEvent) {
    if (open && e.relatedTarget && !rootRef.current?.contains(e.relatedTarget as Node)) setOpen(false);
  }

  async function handleLogout() {
    setOpen(false);
    await logout();
    router.replace('/login');
  }

  const initials = initialsFor(email);
  const roleLabel = role === 'accountant' ? 'Accountant' : 'Owner';

  const renderLink = (item: NavItem) => {
    const active = isActive(pathname, item);
    return (
      <li key={item.href}>
        <Link
          href={item.href}
          aria-current={active ? 'page' : undefined}
          className={`menu-link ${active ? 'is-active' : ''}`}
          onClick={() => setOpen(false)}
        >
          <NavIcon name={item.icon} />
          {item.label}
        </Link>
      </li>
    );
  };

  return (
    <div ref={rootRef} className="profile-menu" onBlur={onBlur}>
      <button
        ref={buttonRef}
        type="button"
        className={`profile-button ${onMenuPage ? 'is-active' : ''}`}
        aria-expanded={open}
        aria-controls={panelId}
        aria-label={`Account and settings${email ? ` for ${email}` : ''}`}
        onClick={() => setOpen(o => !o)}
        onKeyDown={onButtonKeyDown}
      >
        <span className="avatar" aria-hidden="true">{initials}</span>
        <span className="profile-name">{email ?? roleLabel}</span>
        <NavIcon name="chevron" className="profile-chevron" />
      </button>

      <div id={panelId} className="menu-panel" hidden={!open} onKeyDown={onPanelKeyDown}>
        <div className="menu-identity">
          <span className="avatar avatar-lg" aria-hidden="true">{initials}</span>
          <div className="min-w-0">
            <p className="truncate font-semibold text-[color:var(--ink)]">{email ?? 'Signed in'}</p>
            <p className="text-xs text-[color:var(--muted)]">{roleLabel}</p>
          </div>
        </div>

        {setup.length > 0 && (
          <nav aria-label="Setup">
            <p className="menu-label" aria-hidden="true">Setup</p>
            <ul>{setup.map(renderLink)}</ul>
          </nav>
        )}

        <nav aria-label="Account">
          <p className="menu-label" aria-hidden="true">Account</p>
          <ul>{account.map(renderLink)}</ul>
        </nav>

        <div className="menu-section">
          <p className="menu-label" aria-hidden="true">Palette</p>
          <ThemeToggle className="menu-theme" />
        </div>

        <div className="menu-foot">
          <button type="button" className="menu-link" onClick={handleLogout}>
            <NavIcon name="signout" />
            Sign out
          </button>
        </div>
      </div>
    </div>
  );
}
