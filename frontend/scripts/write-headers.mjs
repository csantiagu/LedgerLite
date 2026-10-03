// Writes out/_headers, which Cloudflare applies to every static file of the site (Workers static
// assets and Pages both read it). Runs after `next build`, because the Content-Security-Policy
// depends on where the API is.
import { existsSync, writeFileSync } from 'node:fs';

// Same env files Next.js reads for a production build, highest priority first; values that
// are already set (e.g. by CI or Cloudflare Pages) are not overwritten.
for (const file of ['.env.production.local', '.env.local', '.env.production', '.env']) {
  if (existsSync(file)) process.loadEnvFile(file);
}

// Unset means the API is on the site's own origin (the normal single-Worker deployment)
const api = process.env.NEXT_PUBLIC_API_URL;
const apiOrigin = api ? new URL(api).origin : null;

const csp = [
  "default-src 'self'",
  // Next.js static export bootstraps each page with inline scripts
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com",
  "img-src 'self' blob: data:",
  apiOrigin ? `connect-src 'self' ${apiOrigin}` : "connect-src 'self'",
  // Receipts and invoice PDFs open as blob: URLs, which inherit this policy; the browser's PDF
  // viewer counts as a plugin, so object-src must allow blob: (only this origin can create them)
  "frame-src blob:",
  "object-src blob:",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

const headers = `/*
  Content-Security-Policy: ${csp}
  X-Content-Type-Options: nosniff
  X-Frame-Options: DENY
  Referrer-Policy: no-referrer
  Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=()
  Strict-Transport-Security: max-age=31536000; includeSubDomains
`;

writeFileSync(new URL('../out/_headers', import.meta.url), headers);
console.log(`Wrote out/_headers (API: ${apiOrigin ?? 'same origin'})`);
