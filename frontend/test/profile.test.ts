import { describe, expect, it } from 'vitest';
import { initialsFor, tokenEmail } from '../src/lib/auth';
import { isActive, visibleFor, type NavItem } from '../src/components/layout/nav';

function b64url(text: string) {
  const bytes = new TextEncoder().encode(text);
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function token(claims: Record<string, unknown>) {
  return `${b64url('{"alg":"HS256","typ":"JWT"}')}.${b64url(JSON.stringify(claims))}.sig`;
}

describe('tokenEmail', () => {
  it('reads the email claim', () => {
    expect(tokenEmail(token({ use: 'access', email: 'owner@test.com', role: 'owner' }))).toBe('owner@test.com');
  });

  it('decodes non-ASCII emails', () => {
    expect(tokenEmail(token({ email: 'zoë@firm.co.uk' }))).toBe('zoë@firm.co.uk');
  });

  it('returns null for missing or malformed tokens', () => {
    expect(tokenEmail(null)).toBeNull();
    expect(tokenEmail('not-a-token')).toBeNull();
    expect(tokenEmail('a.%%%.c')).toBeNull();
    expect(tokenEmail(token({ sub: 'u1' }))).toBeNull();
  });
});

describe('initialsFor', () => {
  it('takes up to two initials from the local part', () => {
    expect(initialsFor('jane.doe@firm.co.uk')).toBe('JD');
    expect(initialsFor('owner@test.com')).toBe('O');
    expect(initialsFor('a_b-c@x.com')).toBe('AB');
  });

  it('falls back when there are no letters', () => {
    expect(initialsFor(null)).toBe('?');
    expect(initialsFor('123@x.com')).toBe('?');
  });
});

describe('nav', () => {
  const items: NavItem[] = [
    { href: '/dashboard', label: 'Dashboard', icon: 'dashboard' },
    { href: '/invoices', label: 'Invoices', icon: 'invoices', ownerOnly: true },
    { href: '/review', label: 'Review', icon: 'review', accountantOnly: true },
  ];

  it('filters by role', () => {
    expect(visibleFor('owner', items).map(i => i.label)).toEqual(['Dashboard', 'Invoices']);
    expect(visibleFor('accountant', items).map(i => i.label)).toEqual(['Dashboard', 'Review']);
    expect(visibleFor(null, items).map(i => i.label)).toEqual(['Dashboard']);
  });

  it('matches the page, its sub-pages and extra prefixes only', () => {
    const clients: NavItem = { href: '/settings/clients', label: 'Clients', icon: 'clients', match: ['/clients'] };
    expect(isActive('/settings/clients', clients)).toBe(true);
    expect(isActive('/clients/view', clients)).toBe(true);
    expect(isActive('/clientsx', clients)).toBe(false);
    expect(isActive('/invoices', clients)).toBe(false);
  });
});
