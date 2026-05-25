# LedgerLite — Design System MASTER

## Product
UK accounting SaaS. Professional, trustworthy. Target: small firm owner + accountant.

## Style
Enterprise SaaS — clean, minimal, data-dense. Sidebar layout. Light mode primary.

**DO NOT** use: vibrant/block-based, dark background, playful/youth aesthetics.

## Color Tokens

| Token | Value | Usage |
|-------|-------|-------|
| `--color-primary` | `#2563EB` | Primary actions, active nav, links |
| `--color-primary-hover` | `#1D4ED8` | Hover on primary |
| `--color-primary-light` | `#EFF6FF` | Tinted backgrounds |
| `--color-surface` | `#FFFFFF` | Cards, modals |
| `--color-bg` | `#F8FAFC` | Page background |
| `--color-sidebar` | `#1E293B` | Sidebar bg (slate-800) |
| `--color-sidebar-active` | `#334155` | Active sidebar item |
| `--color-border` | `#E2E8F0` | Card, input borders |
| `--color-foreground` | `#0F172A` | Primary text |
| `--color-muted` | `#64748B` | Secondary text |
| `--color-muted-bg` | `#F1F5F9` | Disabled/muted bg |
| `--color-success` | `#16A34A` | Paid, confirmed states |
| `--color-warning` | `#D97706` | Overdue, pending |
| `--color-destructive` | `#DC2626` | Errors, void |

## Typography
- **Font:** Inter (Google Fonts, weights 300/400/500/600/700)
- **Body:** 16px / 1.5 line-height
- **Headings:** font-weight 600, line-height 1.25
- **Monospaced numbers:** use `.tabular-nums` class for all currency/date columns

## Layout
- **Shell:** Left sidebar (240px) + scrollable main content
- **Container:** `max-w-7xl mx-auto px-6 py-8`
- **Breakpoints:** 375 / 768 / 1024 / 1440
- **Spacing scale:** 4pt multiples (Tailwind default)

## Component Classes (defined in globals.css)
- `.btn-primary` — Blue filled button
- `.btn-secondary` — White outlined button
- `.btn-danger` — Red filled button
- `.input` — Standard input field
- `.input-error` — Red-bordered input
- `.field-label` — Form label above input
- `.field-error` — Red error text below input
- `.card` — White rounded card with border + shadow-sm
- `.badge`, `.badge-blue`, `.badge-green`, `.badge-yellow`, `.badge-red`, `.badge-gray`

## Status Badge Mapping
| Status | Badge class |
|--------|-------------|
| draft | badge-gray |
| sent | badge-blue |
| partial | badge-yellow |
| paid | badge-green |
| void | badge-gray |
| overdue | badge-red |
| pending | badge-yellow |

## Anti-patterns
- No emojis as icons — use Heroicons inline SVG (stroke, 1.5 weight)
- No raw hex in components — use CSS variables or Tailwind tokens
- No localStorage/sessionStorage for auth tokens
- No float arithmetic for money — always pence (integers)

## UX Rules
- Min touch target 44×44px
- Focus rings visible (`:focus-visible` — 2px ring)
- Error messages: below the relevant field, role="alert"
- Loading states: spinner inside button, skeleton for lists
- Empty states: icon + helpful copy + action
- Confirm before destructive actions (deactivate user, void invoice)
- Animation: 150-300ms ease-out, transform/opacity only
