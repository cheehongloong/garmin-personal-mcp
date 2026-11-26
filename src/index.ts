import { OAuthProvider } from "@cloudflare/workers-oauth-provider";
import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler, getMcpAuthContext } from "agents/mcp/server";
import { z } from "zod";
import { githubAuthHandler, isAllowedGitHubLogin } from "./auth/github.js";
import type { AuthProps, Env } from "./types.js";

const SERVER_NAME = "garmin-personal-mcp";
const SERVER_VERSION = "0.1.0";
const MAX_CACHED_PROVIDERS = 16;

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

  // Temporary auth verification tool until the Garmin Connect tools are added.
  server.registerTool(
    "get_auth_status",
    {
      description:
        "Verify that OAuth authentication and MCP transport are working. Returns the authenticated GitHub login and configured timezone.",
      inputSchema: z.object({}),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async () => {
      const auth = getMcpAuthContext();
      const props = auth?.props as Partial<AuthProps> | undefined;
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              status: "authenticated",
              githubLogin: props?.githubLogin ?? null,
              timezone: env.TIMEZONE?.trim() || "UTC",
            }),
          },
        ],
      };
    },
  );

  return server;
}

export const mcpApiHandler = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const props = (ctx as ExecutionContext<Partial<AuthProps> | undefined>).props;
    if (!isAllowedGitHubLogin(props?.githubLogin, env)) {
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

export function createOAuthProvider(resource: string): OAuthProvider<Env> {
  return new OAuthProvider<Env>({
    apiRoute: "/mcp",
    apiHandler: mcpApiHandler,
    defaultHandler: githubAuthHandler,
    authorizeEndpoint: "/authorize",
    tokenEndpoint: "/oauth/token",
    clientRegistrationEndpoint: "/oauth/register",
    clientIdMetadataDocumentEnabled: true,
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
  const cached = providerCache.get(resource);
  if (cached) {
    return cached;
  }
  if (providerCache.size >= MAX_CACHED_PROVIDERS) {
    providerCache.clear();
  }
  const provider = createOAuthProvider(resource);
  providerCache.set(resource, provider);
  return provider;
}

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return getOAuthProvider(request, env).fetch(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;
