const paths = {
  dashboard: (
    <>
      <rect x="3.5" y="3.5" width="7" height="8" rx="1.6" />
      <rect x="13.5" y="3.5" width="7" height="5" rx="1.6" />
      <rect x="13.5" y="11.5" width="7" height="9" rx="1.6" />
      <rect x="3.5" y="14.5" width="7" height="6" rx="1.6" />
    </>
  ),
  invoices: (
    <>
      <path d="M14 3.5H7.5a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h9a2 2 0 0 0 2-2V8z" />
      <path d="M14 3.5V8h4.5M9 12.5h6M9 16h4" />
    </>
  ),
  bills: (
    <>
      <path d="M6 3.5h12v17l-2.4-1.5-2.4 1.5-2.4-1.5-2.4 1.5L6 20.5z" />
      <path d="M9 8.5h6M9 12h6M9 15.5h3" />
    </>
  ),
  bank: (
    <>
      <path d="M3.5 9.5 12 4.5l8.5 5z" />
      <path d="M6 10v7M10 10v7M14 10v7M18 10v7M3.5 19.5h17" />
    </>
  ),
  review: (
    <>
      <path d="M5.5 21V4h11l-1.8 4.25L16.5 12.5h-11" />
    </>
  ),
  clients: (
    <>
      <circle cx="9" cy="8" r="3.5" />
      <path d="M2.5 20a6.5 6.5 0 0 1 13 0M16 4.75a3.5 3.5 0 0 1 0 6.5M18.5 14.5a6.5 6.5 0 0 1 3 5.5" />
    </>
  ),
  vendors: (
    <>
      <path d="M4.5 4h15l1.5 5h-18z" />
      <path d="M5 9v11h14V9M10 20v-5h4v5" />
    </>
  ),
  reports: (
    <>
      <path d="M3.5 20h17M7 16.5V11M12 16.5V6M17 16.5v-8" />
    </>
  ),
  export: (
    <>
      <path d="M12 3.5v11M7.5 10l4.5 4.5 4.5-4.5" />
      <path d="M4 15.5v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3" />
    </>
  ),
  backup: (
    <>
      <ellipse cx="12" cy="6" rx="7" ry="2.5" />
      <path d="M5 6v6c0 1.4 3.1 2.5 7 2.5s7-1.1 7-2.5V6M5 12v6c0 1.4 3.1 2.5 7 2.5s7-1.1 7-2.5v-6" />
    </>
  ),
  lock: (
    <>
      <rect x="5" y="10.5" width="14" height="10" rx="1.8" />
      <path d="M8.5 10.5V7.5a3.5 3.5 0 0 1 7 0v3M12 14.5v2.5" />
    </>
  ),
  audit: (
    <>
      <rect x="5" y="4" width="14" height="16.5" rx="1.8" />
      <path d="M9 4V3h6v1M8.5 9h7M8.5 12.5h4" />
      <circle cx="15" cy="16" r="2.6" />
      <path d="M15 14.8V16l.8.6" />
    </>
  ),
  company: (
    <>
      <rect x="5" y="3.5" width="14" height="17" rx="1.8" />
      <path d="M9 7.5h2M13 7.5h2M9 11h2M13 11h2M10 20.5v-4h4v4" />
    </>
  ),
  categories: (
    <>
      <path d="M3.5 12V5a1.5 1.5 0 0 1 1.5-1.5h7l8.5 8.5-8.5 8.5z" />
      <circle cx="8" cy="8" r="1.4" />
    </>
  ),
  rules: (
    <>
      <path d="M4 6.5h9M17 6.5h3M4 12h3M11 12h9M4 17.5h11" />
      <circle cx="15" cy="6.5" r="2" />
      <circle cx="9" cy="12" r="2" />
      <circle cx="17" cy="17.5" r="2" />
    </>
  ),
  'bank-accounts': (
    <>
      <rect x="3" y="5.5" width="18" height="13" rx="2" />
      <path d="M3 10h18M7 14.5h3" />
    </>
  ),
  users: (
    <>
      <circle cx="12" cy="8" r="4" />
      <path d="M4.5 20.5a7.5 7.5 0 0 1 15 0" />
    </>
  ),
  security: (
    <>
      <path d="M12 3.5 5 6.25v5.5c0 4.25 2.9 7.75 7 8.75 4.1-1 7-4.5 7-8.75v-5.5z" />
      <path d="m9.25 12 2 2 3.75-3.75" />
    </>
  ),
  palette: (
    <>
      <path d="M12 3.5a8.5 8.5 0 1 0 0 17c1.1 0 1.75-.75 1.75-1.6 0-1.15-.95-1.4-.95-2.5 0-.9.7-1.4 1.6-1.4h1.85A4.25 4.25 0 0 0 20.5 10.75C20.5 6.7 16.7 3.5 12 3.5z" />
      <circle cx="7.75" cy="11" r="1" />
      <circle cx="10.5" cy="7.25" r="1" />
      <circle cx="15" cy="7.75" r="1" />
    </>
  ),
  signout: (
    <>
      <path d="M14.5 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3" />
      <path d="M10 8l-4 4 4 4M6 12h9.5" />
    </>
  ),
  menu: <path d="M4 7h16M4 12h16M4 17h16" />,
  close: <path d="M6 6l12 12M18 6 6 18" />,
  chevron: <path d="m7 10 5 5 5-5" />,
};

export type IconName = keyof typeof paths;

export function NavIcon({ name, className = 'nav-icon' }: { name: IconName; className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {paths[name]}
    </svg>
  );
}
