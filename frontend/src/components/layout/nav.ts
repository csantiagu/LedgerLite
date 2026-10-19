import type { IconName } from './NavIcon';

export type Role = 'owner' | 'accountant' | null;

export interface NavItem {
  href: string;
  label: string;
  icon: IconName;
  /** Other path prefixes that count as this page (e.g. detail pages outside /settings) */
  match?: string[];
  ownerOnly?: boolean;
  accountantOnly?: boolean;
}

export function visibleFor(role: Role, items: NavItem[]): NavItem[] {
  return items.filter(item => {
    if (item.ownerOnly && role !== 'owner') return false;
    if (item.accountantOnly && role !== 'accountant') return false;
    return true;
  });
}

export function isActive(pathname: string, item: NavItem): boolean {
  return [item.href, ...(item.match ?? [])].some(
    prefix => pathname === prefix || pathname.startsWith(`${prefix}/`)
  );
}
