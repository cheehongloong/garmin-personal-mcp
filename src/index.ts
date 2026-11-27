import { OAuthProvider } from "@cloudflare/workers-oauth-provider";
import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import { checkClientRegistration, githubAuthHandler, isAllowedGitHubUser } from "./auth/github.js";
import { GarminClient } from "./garmin.js";
import { registerGarminTools } from "./tools.js";
import type { AuthProps, Env } from "./types.js";

const SERVER_NAME = "garmin-personal-mcp";
const SERVER_VERSION = "0.2.0";
const MAX_CACHED_PROVIDERS = 16;

/** Unauthenticated OAuth endpoints that write to KV and are worth throttling per client IP. */
const RATE_LIMITED_PATHS = new Set(["/authorize", "/callback", "/oauth/register", "/oauth/token"]);
const RATE_LIMIT_RETRY_AFTER_SECONDS = 60;

const providerCache = new Map<string, OAuthProvider<Env>>();

export function resolveCanonicalResource(request: Request, env: Pick<Env, "MCP_RESOURCE">): string {
  const configured = env.MCP_RESOURCE?.trim();
  if (configured) {
    return configured;
  }
  return `${new URL(request.url).origin}/mcp`;
}

export function createMcpServer(env: Env): McpServer {
  const server = new McpServer({
    name: SERVER_NAME,
    version: SERVER_VERSION,
  });

  const client = new GarminClient({
    apiKey: env.GARMIN_PERSONAL_API_KEY ?? "",
    baseUrl: env.GARMIN_BASE_URL,
    kv: env.OAUTH_KV,
  });

  registerGarminTools(server, {
    client,
    timeZone: env.TIMEZONE,
  });

  return server;
}

export const mcpApiHandler = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const props = (ctx as ExecutionContext<Partial<AuthProps> | undefined>).props;
    if (!isAllowedGitHubUser({ login: props?.githubLogin, id: props?.githubId }, env)) {
      return Response.json(
        {
          error: "access_denied",
          error_description: "Authenticated account is not allowed for this deployment.",
        },
        { status: 403 },
      );
    }

    // Safe to accept any browser Origin here because OAuthProvider already enforced
    // Bearer token auth (no ambient cookies) before dispatching to apiHandler.
    const handler = createMcpHandler(() => createMcpServer(env), {
      route: "/mcp",
      allowedOriginHostnames: "*",
    });
    return handler(request, env, ctx);
  },
};

export function createOAuthProvider(
  resource: string,
  env: Pick<Env, "ALLOWED_REDIRECT_HOSTS"> = {},
): OAuthProvider<Env> {
  return new OAuthProvider<Env>({
    apiRoute: "/mcp",
    apiHandler: mcpApiHandler,
    defaultHandler: githubAuthHandler,
    authorizeEndpoint: "/authorize",
    tokenEndpoint: "/oauth/token",
    clientRegistrationEndpoint: "/oauth/register",
    clientIdMetadataDocumentEnabled: true,
    clientRegistrationCallback: ({ clientMetadata }) =>
      checkClientRegistration(clientMetadata, env),
    scopesSupported: ["garmin:read"],
    requiredScopes: ["garmin:read"],
    resourceMetadata: {
      resource,
      resource_name: "Garmin Connect Personal MCP",
    },
  });
}

function getOAuthProvider(request: Request, env: Env): OAuthProvider<Env> {
  const resource = resolveCanonicalResource(request, env);
  const cacheKey = `${resource}\n${env.ALLOWED_REDIRECT_HOSTS ?? ""}`;
  const cached = providerCache.get(cacheKey);
  if (cached) {
    return cached;
  }
  if (providerCache.size >= MAX_CACHED_PROVIDERS) {
    providerCache.clear();
  }
  const provider = createOAuthProvider(resource, env);
  providerCache.set(cacheKey, provider);
  return provider;
}

/**
 * Per-IP throttle for unauthenticated OAuth endpoints (protects the Workers KV Free write quota).
 * Returns a 429 response when the limit is exceeded, otherwise `null`. Fails open if the
 * optional AUTH_RATE_LIMITER binding is missing or errors, since it is an availability control.
 */
export async function enforceAuthRateLimit(
  request: Request,
  env: Pick<Env, "AUTH_RATE_LIMITER">,
): Promise<Response | null> {
  const limiter = env.AUTH_RATE_LIMITER;
  if (!limiter || !RATE_LIMITED_PATHS.has(new URL(request.url).pathname)) {
    return null;
  }
  const clientIp = request.headers.get("CF-Connecting-IP") ?? "unknown";
  try {
    const { success } = await limiter.limit({ key: `auth:${clientIp}` });
    if (success) {
      return null;
    }
  } catch {
    return null;
  }
  return Response.json(
    {
      error: "rate_limited",
      error_description: "Too many authorization requests. Please try again in a minute.",
    },
    {
      status: 429,
      headers: {
        "Retry-After": String(RATE_LIMIT_RETRY_AFTER_SECONDS),
        "Cache-Control": "no-store",
      },
    },
  );
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const limited = await enforceAuthRateLimit(request, env);
    if (limited) {
      return limited;
    }
    return getOAuthProvider(request, env).fetch(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;
