import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Unit tests for the frontend's pure logic (no DOM): parsing, money and review rules
export default defineConfig({
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    // `npm run coverage`. Files listed under thresholds must stay fully covered.
    coverage: {
      provider: 'v8',
      include: ['src/lib/**/*.ts'],
      reporter: ['text', 'json'],
      thresholds: {
        'src/lib/billFromBank.ts': { 100: true },
        'src/lib/bills.ts': { 100: true },
      },
    },
  },
});
