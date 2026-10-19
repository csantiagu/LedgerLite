'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useAuthStore } from '@/lib/auth';
import { MOBILE_NAV_QUERY, Sidebar } from './Sidebar';
import { ProfileMenu } from './ProfileMenu';
import { NavIcon } from './NavIcon';
import { silentRefresh } from '@/lib/api';

interface Props {
  children: React.ReactNode;
}

export function AppShell({ children }: Props) {
  const accessToken = useAuthStore(s => s.accessToken);
  const router = useRouter();
  const [navOpen, setNavOpen] = useState(false);
  const menuButtonRef = useRef<HTMLButtonElement>(null);

  // On mount: if no token in memory, restore the session from the refresh cookie
  useEffect(() => {
    if (accessToken) return;
    let active = true;
    silentRefresh().then(token => {
      if (active && !token) router.replace('/login');
    });
    return () => { active = false; };
  }, [accessToken, router]);

  const closeNav = useCallback((restoreFocus = false) => {
    setNavOpen(false);
    if (restoreFocus) menuButtonRef.current?.focus();
  }, []);

  // Phone-width drawer: Escape closes it, the page behind doesn't scroll, and it closes if the window widens
  useEffect(() => {
    if (!navOpen) return;
    const phone = window.matchMedia(MOBILE_NAV_QUERY);
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') closeNav(true);
    }
    function onWiden() {
      if (!phone.matches) closeNav();
    }
    document.addEventListener('keydown', onKeyDown);
    phone.addEventListener('change', onWiden);
    document.documentElement.classList.add('nav-locked');
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      phone.removeEventListener('change', onWiden);
      document.documentElement.classList.remove('nav-locked');
    };
  }, [navOpen, closeNav]);

  if (!accessToken) {
    return (
      <div className="flex min-h-dvh items-center justify-center">
        <div className="spinner" role="status" aria-label="Loading" />
      </div>
    );
  }

  return (
    <div className="app-frame">
      <a href="#main-content" className="skip-link">Skip to content</a>
      <Sidebar open={navOpen} onClose={() => closeNav()} />
      {navOpen && <div className="nav-backdrop" onClick={() => closeNav(true)} aria-hidden="true" />}

      <div className="app-column">
        <header className="app-topbar">
          <button
            ref={menuButtonRef}
            type="button"
            className="icon-button nav-toggle"
            aria-expanded={navOpen}
            aria-controls="app-sidebar"
            aria-label="Open menu"
            onClick={() => setNavOpen(true)}
          >
            <NavIcon name="menu" className="h-5 w-5" />
          </button>
          <Link href="/dashboard" className="topbar-brand brand-lockup">
            <img src="/mark.png" alt="" width={28} height={28} className="brand-tile brand-tile-sm" />
            <span className="brand-mark text-[1.3rem]">LedgerLite</span>
          </Link>
          <ProfileMenu />
        </header>

        <main className="app-main" id="main-content" tabIndex={-1}>
          <div className="mx-auto max-w-6xl px-2 py-4 sm:px-4 sm:py-6">
            {children}
          </div>
        </main>
      </div>
    </div>
  );
}
