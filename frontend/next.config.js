/** @type {import('next').NextConfig} */
const nextConfig = {
  // Plain HTML/JS in out/ for Cloudflare Pages: no Next.js server runs in production.
  // The browser calls the Worker directly at NEXT_PUBLIC_API_URL.
  output: 'export',
  // Keep Turbopack scoped to this app rather than guessing the workspace root
  turbopack: { root: __dirname },
};

module.exports = nextConfig;
