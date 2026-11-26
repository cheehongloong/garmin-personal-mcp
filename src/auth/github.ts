import {
  AuthorizationError,
  type AuthRequest,
  authorizationErrorRedirect,
  CimdFetchError,
  type ConsentDescription,
} from "@cloudflare/workers-oauth-provider";
import type { AuthProps, Env } from "../types.js";

const GITHUB_AUTHORIZE_URL = "https://github.com/login/oauth/authorize";
const GITHUB_TOKEN_URL = "https://github.com/login/oauth/access_token";
const GITHUB_USER_URL = "https://api.github.com/user";
const USER_AGENT = "garmin-personal-mcp";

/**
 * GitHub usernames: 1-39 alphanumeric chars or single internal hyphens,
 * cannot start or end with a hyphen. Strictly enforcing this ensures
 * ALLOWED_GITHUB_LOGIN is always a single valid GitHub handle (never a
 * comma-separated list, wildcard, or empty placeholder).
 */
const GITHUB_LOGIN_PATTERN = /^[a-zA-Z0-9](?:[a-zA-Z0-9]|-(?=[a-zA-Z0-9])){0,38}$/;

const MIN_COOKIE_SECRET_LENGTH = 32;
const DEFAULT_SCOPES = ["garmin:read"];

interface UpstreamStateData {
  codeVerifier: string;
}

interface GitHubTokenResponse {
  access_token?: unknown;
  error?: unknown;
  error_description?: unknown;
}

interface GitHubUserResponse {
  id?: unknown;
  login?: unknown;
}

export interface GitHubAuthHandlerOptions {
  fetchFn?: typeof fetch;
}

/**
 * Returns the normalized (lowercase) allowed GitHub username, or null if
 * ALLOWED_GITHUB_LOGIN is unset, blank, or not a single valid GitHub login.
 */
export function resolveAllowedGitHubLogin(env: Pick<Env, "ALLOWED_GITHUB_LOGIN">): string | null {
  const raw = env.ALLOWED_GITHUB_LOGIN?.trim();
  if (!raw || !GITHUB_LOGIN_PATTERN.test(raw)) {
    return null;
  }
  return raw.toLowerCase();
}

/**
 * Fail-closed check: returns true only when ALLOWED_GITHUB_LOGIN is configured
 * to a single valid GitHub login and matches `login` case-insensitively.
 */
export function isAllowedGitHubLogin(
  login: string | undefined | null,
  env: Pick<Env, "ALLOWED_GITHUB_LOGIN">,
): boolean {
  const allowed = resolveAllowedGitHubLogin(env);
  if (!allowed || !login) {
    return false;
  }
  const normalized = login.trim().toLowerCase();
  return normalized.length > 0 && normalized === allowed;
}

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => {
    switch (char) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      case "'":
        return "&#39;";
      default:
        return char;
    }
  });
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function generatePkceVerifier(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return base64UrlEncode(bytes);
}

async function computePkceChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return base64UrlEncode(new Uint8Array(digest));
}

function getRememberOption(
  env: Pick<Env, "COOKIE_ENCRYPTION_KEY">,
): { secret: string } | undefined {
  const secret = env.COOKIE_ENCRYPTION_KEY?.trim();
  if (!secret || secret.length < MIN_COOKIE_SECRET_LENGTH) {
    return undefined;
  }
  return { secret };
}

function validateAuthConfig(env: Env): string | null {
  if (!resolveAllowedGitHubLogin(env)) {
    return "This server is not configured: ALLOWED_GITHUB_LOGIN must be set to a single GitHub username.";
  }
  if (!env.GITHUB_CLIENT_ID?.trim() || !env.GITHUB_CLIENT_SECRET?.trim()) {
    return "This server is not configured: GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET must be set.";
  }
  return null;
}

function renderPage(title: string, bodyHtml: string): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <style>
    :root { color-scheme: light dark; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      max-width: 540px;
      margin: 48px auto;
      padding: 0 20px;
      line-height: 1.5;
    }
    .card {
      border: 1px solid rgba(127, 127, 127, 0.3);
      border-radius: 12px;
      padding: 24px;
    }
    h1 { font-size: 1.35rem; margin-top: 0; }
    .warn {
      border-left: 4px solid #d97706;
      padding: 10px 14px;
      background: rgba(217, 119, 6, 0.1);
      border-radius: 4px;
      margin: 16px 0;
    }
    .muted { opacity: 0.75; font-size: 0.9rem; }
    .actions { display: flex; gap: 12px; margin-top: 20px; }
    button {
      padding: 10px 18px;
      border-radius: 8px;
      border: 1px solid rgba(127, 127, 127, 0.35);
      font-size: 0.95rem;
      cursor: pointer;
    }
    button.primary {
      background: #2563eb;
      color: #ffffff;
      border-color: #2563eb;
      font-weight: 600;
    }
    code {
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 0.9em;
    }
  </style>
</head>
<body>
  <main class="card">
    ${bodyHtml}
  </main>
</body>
</html>`;
}

function htmlResponse(html: string, status: number, extraHeaders?: Headers): Response {
  const headers = new Headers(extraHeaders);
  headers.set("Content-Type", "text/html; charset=utf-8");
  headers.set("Cache-Control", "no-store");
  headers.set("X-Frame-Options", "DENY");
  headers.set("Content-Security-Policy", "frame-ancestors 'none'");
  return new Response(html, { status, headers });
}

function renderLandingPage(): string {
  return renderPage(
    "Garmin Connect Personal MCP",
    `<h1>Garmin Connect Personal MCP</h1>
<p>This is a self-hosted, single-user remote Model Context Protocol (MCP) server for reading your own Garmin Connect data via the official Garmin Connect Personal API.</p>
<p>MCP endpoint: <code>/mcp</code></p>
<p class="muted">Not affiliated with or endorsed by Garmin. Access is restricted to the configured owner account via GitHub OAuth.</p>`,
  );
}

function renderConsentPage(details: ConsentDescription, handle: string): string {
  const clientName = escapeHtml(details.clientName);
  const redirectHost = escapeHtml(details.redirectHost);
  const clientOriginNote = details.clientDomain
    ? `Published by <strong>${escapeHtml(details.clientDomain)}</strong>.`
    : "This client registered dynamically; its display name is self-asserted.";

  const loopbackWarning = details.redirectIsLoopback
    ? `<div class="warn"><strong>Local application redirect:</strong> Access will be sent to a local app on your computer (<code>${redirectHost}</code>). Continue only if you just started signing in from it.</div>`
    : "";

  const scopes = details.scope.length > 0 ? details.scope : DEFAULT_SCOPES;
  const scopeList = scopes.map((scope) => `<li><code>${escapeHtml(scope)}</code></li>`).join("");

  return renderPage(
    `Authorize ${details.clientName}`,
    `<h1>Allow ${clientName} to access your Garmin MCP server?</h1>
<p>${clientOriginNote}</p>
<p>Access will be sent to <strong>${redirectHost}</strong>. You will verify your identity with GitHub next.</p>
${loopbackWarning}
<p>Requested permissions (read-only):</p>
<ul>${scopeList}</ul>
<form method="post" action="/authorize">
  <input type="hidden" name="handle" value="${escapeHtml(handle)}">
  <div class="actions">
    <button class="primary" type="submit" name="decision" value="approve">Continue with GitHub</button>
    <button type="submit" name="decision" value="deny">Deny</button>
  </div>
</form>`,
  );
}

function renderErrorPage(title: string, heading: string, message: string): string {
  return renderPage(
    title,
    `<h1>${escapeHtml(heading)}</h1>
<p>${escapeHtml(message)}</p>`,
  );
}

async function startGitHubUpstream(
  request: Request,
  env: Env,
  authRequest: AuthRequest,
  baseHeaders?: Headers,
): Promise<Response> {
  const codeVerifier = generatePkceVerifier();
  const codeChallenge = await computePkceChallenge(codeVerifier);
  const upstream = await env.OAUTH_PROVIDER.beginUpstream(authRequest, {
    data: { codeVerifier } satisfies UpstreamStateData,
    headers: baseHeaders,
  });

  const callbackUrl = new URL("/callback", request.url).href;
  const githubUrl = new URL(GITHUB_AUTHORIZE_URL);
  githubUrl.searchParams.set("client_id", env.GITHUB_CLIENT_ID.trim());
  githubUrl.searchParams.set("redirect_uri", callbackUrl);
  githubUrl.searchParams.set("scope", "read:user");
  githubUrl.searchParams.set("state", upstream.state);
  githubUrl.searchParams.set("code_challenge", codeChallenge);
  githubUrl.searchParams.set("code_challenge_method", "S256");

  upstream.headers.set("Location", githubUrl.href);
  return new Response(null, { status: 302, headers: upstream.headers });
}

async function exchangeGitHubCode(
  fetchFn: typeof fetch,
  params: {
    clientId: string;
    clientSecret: string;
    code: string;
    redirectUri: string;
    codeVerifier: string;
  },
): Promise<string> {
  const tokenRes = await fetchFn(GITHUB_TOKEN_URL, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      "User-Agent": USER_AGENT,
    },
    body: JSON.stringify({
      client_id: params.clientId,
      client_secret: params.clientSecret,
      code: params.code,
      redirect_uri: params.redirectUri,
      code_verifier: params.codeVerifier,
    }),
  });

  if (!tokenRes.ok) {
    throw new Error(`GitHub token exchange failed with status ${tokenRes.status}`);
  }

  const tokenData = (await tokenRes.json()) as GitHubTokenResponse;
  if (typeof tokenData.access_token !== "string" || tokenData.access_token.length === 0) {
    const reason =
      typeof tokenData.error_description === "string"
        ? tokenData.error_description
        : typeof tokenData.error === "string"
          ? tokenData.error
          : "missing access_token";
    throw new Error(`GitHub token exchange rejected: ${reason}`);
  }

  return tokenData.access_token;
}

async function fetchGitHubUser(
  fetchFn: typeof fetch,
  accessToken: string,
): Promise<{ id: number; login: string }> {
  const userRes = await fetchFn(GITHUB_USER_URL, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/vnd.github+json",
      "User-Agent": USER_AGENT,
    },
  });

  if (!userRes.ok) {
    throw new Error(`GitHub user lookup failed with status ${userRes.status}`);
  }

  const userData = (await userRes.json()) as GitHubUserResponse;
  if (
    typeof userData.id !== "number" ||
    !Number.isInteger(userData.id) ||
    typeof userData.login !== "string" ||
    userData.login.trim().length === 0
  ) {
    throw new Error("GitHub user response missing valid id or login");
  }

  return { id: userData.id, login: userData.login };
}

export function createGitHubAuthHandler(
  options: GitHubAuthHandlerOptions = {},
): ExportedHandler<Env> & { fetch: NonNullable<ExportedHandler<Env>["fetch"]> } {
  const fetchFn = options.fetchFn ?? fetch;

  return {
    async fetch(request: Request, env: Env): Promise<Response> {
      const url = new URL(request.url);

      if (url.pathname === "/" && request.method === "GET") {
        return htmlResponse(renderLandingPage(), 200);
      }

      if (url.pathname !== "/authorize" && url.pathname !== "/callback") {
        return new Response("Not Found", { status: 404 });
      }

      const configError = validateAuthConfig(env);
      if (configError) {
        return htmlResponse(
          renderErrorPage("Server Not Configured", "Authorization Disabled", configError),
          503,
        );
      }

      try {
        if (url.pathname === "/authorize" && request.method === "GET") {
          const authRequest = await env.OAUTH_PROVIDER.parseAuthRequest(request);
          const remember = getRememberOption(env);
          if (
            remember &&
            (await env.OAUTH_PROVIDER.isConsentRemembered(request, authRequest, remember))
          ) {
            return await startGitHubUpstream(request, env, authRequest);
          }

          const details = await env.OAUTH_PROVIDER.describeConsent(authRequest);
          const consent = await env.OAUTH_PROVIDER.beginConsent(authRequest);
          return htmlResponse(renderConsentPage(details, consent.handle), 200, consent.headers);
        }

        if (url.pathname === "/authorize" && request.method === "POST") {
          const form = await request.formData();
          const handle = form.get("handle");
          const decision = form.get("decision");
          if (typeof handle !== "string" || handle.length === 0) {
            return htmlResponse(
              renderErrorPage(
                "Invalid Request",
                "Invalid authorization request",
                "The consent session token was missing. Please restart sign-in from your MCP client.",
              ),
              400,
            );
          }

          if (decision !== "approve") {
            const denied = await env.OAUTH_PROVIDER.denyConsent(request, handle, {
              description: "The user denied the authorization request.",
            });
            return new Response(null, { status: 302, headers: denied.headers });
          }

          const remember = getRememberOption(env);
          const approved = await env.OAUTH_PROVIDER.approveConsent(
            request,
            handle,
            remember ? { remember } : undefined,
          );
          return await startGitHubUpstream(request, env, approved.request, approved.headers);
        }

        if (url.pathname === "/callback" && request.method === "GET") {
          const {
            request: original,
            data,
            headers,
          } = await env.OAUTH_PROVIDER.finishUpstream<UpstreamStateData>(request);

          const upstreamError = url.searchParams.get("error");
          if (upstreamError) {
            headers.set(
              "Location",
              authorizationErrorRedirect(
                original,
                "access_denied",
                "GitHub sign-in was cancelled or denied.",
              ),
            );
            return new Response(null, { status: 302, headers });
          }

          const code = url.searchParams.get("code");
          if (!code) {
            return htmlResponse(
              renderErrorPage(
                "Authorization Failed",
                "Missing GitHub authorization code",
                "GitHub did not return an authorization code. Please restart sign-in from your MCP client.",
              ),
              400,
              headers,
            );
          }

          if (!data || typeof data.codeVerifier !== "string" || data.codeVerifier.length === 0) {
            return htmlResponse(
              renderErrorPage(
                "Authorization Failed",
                "Invalid sign-in session",
                "The upstream PKCE session data was missing. Please restart sign-in from your MCP client.",
              ),
              400,
              headers,
            );
          }

          const callbackUrl = new URL("/callback", request.url).href;
          let githubUser: { id: number; login: string };
          try {
            const accessToken = await exchangeGitHubCode(fetchFn, {
              clientId: env.GITHUB_CLIENT_ID.trim(),
              clientSecret: env.GITHUB_CLIENT_SECRET.trim(),
              code,
              redirectUri: callbackUrl,
              codeVerifier: data.codeVerifier,
            });
            githubUser = await fetchGitHubUser(fetchFn, accessToken);
          } catch {
            return htmlResponse(
              renderErrorPage(
                "GitHub Authentication Failed",
                "Could not verify your GitHub account",
                "GitHub rejected the sign-in exchange or was unreachable. Please try again from your MCP client.",
              ),
              502,
              headers,
            );
          }

          if (!isAllowedGitHubLogin(githubUser.login, env)) {
            return htmlResponse(
              renderErrorPage(
                "Access Denied",
                "GitHub account not authorized",
                `Signed in as @${githubUser.login}, which is not permitted to access this private Garmin Connect MCP server. This deployment is restricted to a single owner account.`,
              ),
              403,
              headers,
            );
          }

          const grantedScope = original.scope.length > 0 ? original.scope : DEFAULT_SCOPES;
          const props: AuthProps = {
            githubLogin: githubUser.login,
            githubId: githubUser.id,
          };
          const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
            request: original,
            userId: String(githubUser.id),
            metadata: { githubLogin: githubUser.login },
            scope: grantedScope,
            props,
          });

          headers.set("Location", redirectTo);
          return new Response(null, { status: 302, headers });
        }

        return new Response("Method Not Allowed", { status: 405 });
      } catch (error) {
        if (error instanceof AuthorizationError) {
          if (error.redirectTo) {
            return Response.redirect(error.redirectTo, 302);
          }
          return htmlResponse(
            renderErrorPage(
              "Authorization Error",
              "Authorization request rejected",
              error.description,
            ),
            400,
          );
        }
        if (error instanceof CimdFetchError) {
          return htmlResponse(
            renderErrorPage(
              "Client Verification Failed",
              "Could not verify MCP client",
              "The requesting application's client metadata document could not be verified.",
            ),
            400,
          );
        }
        throw error;
      }
    },
  };
}

export const githubAuthHandler = createGitHubAuthHandler();
