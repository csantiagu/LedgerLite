export type Env = {
  DB: D1Database;
  R2: R2Bucket;
  /** Separate bucket for nightly backups (services/backup.ts) */
  BACKUPS: R2Bucket;
  LOGIN_LIMITER: RateLimit;
  REFRESH_LIMITER: RateLimit;
  API_LIMITER: RateLimit;
  JWT_SECRET: string;
  API_KEY_SALT: string;
  /** Encrypts two-factor secrets at rest. Changing it disables everyone's 2FA. */
  ENCRYPTION_KEY: string;
  ALLOWED_ORIGIN: string;
  ENVIRONMENT: string;
  /** One-time secret needed to create the first owner. Optional only when ENVIRONMENT=local. */
  SETUP_TOKEN?: string;
};

export type UserRole = 'owner' | 'accountant';

export type AuthUser = {
  id: string;
  email: string;
  role: UserRole;
};

declare module 'hono' {
  interface ContextVariableMap {
    user: AuthUser;
    /** How the request authenticated: a browser session (JWT) or an API key */
    authMethod: 'session' | 'api_key';
    /** The API key used, when authMethod is 'api_key' (recorded in the audit log) */
    apiKeyId?: string;
  }
}
