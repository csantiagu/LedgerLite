import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

export default defineConfig(async () => {
  const migrations = await readD1Migrations('./migrations');
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: './wrangler.toml' },
        miniflare: {
          bindings: {
            TEST_MIGRATIONS: migrations,
            JWT_SECRET: 'test-jwt-secret-at-least-32-characters-long',
            API_KEY_SALT: 'test-salt-at-least-16-chars',
            ENCRYPTION_KEY: 'test-encryption-key-at-least-32-characters',
            ENVIRONMENT: 'test',
            ALLOWED_ORIGIN: 'http://localhost:3001',
            SETUP_TOKEN: 'test-setup-token-123',
          },
        },
      }),
    ],
    test: {
      include: ['test/**/*.test.ts'],
      setupFiles: ['./test/setup.ts'],
    },
  };
});
