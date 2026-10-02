export type Env = {
  DB: D1Database;
  R2: R2Bucket;
  LOGIN_LIMITER: RateLimit;
  REFRESH_LIMITER: RateLimit;
  API_LIMITER: RateLimit;
  JWT_SECRET: string;
  API_KEY_SALT: string;
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
  }
}
