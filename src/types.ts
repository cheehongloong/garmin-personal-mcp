import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";

/**
 * Application properties encrypted inside OAuth tokens by workers-oauth-provider.
 * Intentionally minimal: never store upstream GitHub access tokens or Garmin keys here.
 */
export interface AuthProps {
  githubLogin: string;
  githubId: number;
}

export interface Env {
  OAUTH_KV: KVNamespace;
  OAUTH_PROVIDER: OAuthHelpers;

  // Worker secrets (`wrangler secret put`)
  GARMIN_PERSONAL_API_KEY: string;
  GITHUB_CLIENT_ID: string;
  GITHUB_CLIENT_SECRET: string;
  COOKIE_ENCRYPTION_KEY?: string;

  // Workers Rate Limiting binding (`ratelimits` in wrangler.jsonc); optional
  AUTH_RATE_LIMITER?: RateLimit;

  // Worker vars (`wrangler.jsonc`)
  ALLOWED_GITHUB_LOGIN?: string;
  ALLOWED_GITHUB_ID?: string;
  ALLOWED_REDIRECT_HOSTS?: string;
  TIMEZONE?: string;
  GARMIN_BASE_URL?: string;
  MCP_RESOURCE?: string;
}
