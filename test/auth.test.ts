import {
  AuthorizationError,
  type AuthRequest,
  CimdFetchError,
  type ConsentDescription,
  type OAuthHelpers,
} from "@cloudflare/workers-oauth-provider";
import { describe, expect, it, vi } from "vitest";
import {
  createGitHubAuthHandler,
  escapeHtml,
  isAllowedGitHubLogin,
  resolveAllowedGitHubLogin,
} from "../src/auth/github.js";
import { mcpApiHandler, resolveCanonicalResource } from "../src/index.js";
import type { AuthProps, Env } from "../src/types.js";

function makeAuthRequest(overrides: Partial<AuthRequest> = {}): AuthRequest {
  return {
    responseType: "code",
    clientId: "client-123",
    redirectUri: "https://claude.ai/api/mcp/auth_callback",
    scope: ["garmin:read"],
    state: "client-state-xyz",
    resource: "https://garmin-mcp.example.workers.dev/mcp",
    issuer: "https://garmin-mcp.example.workers.dev",
    ...overrides,
  };
}

function makeConsentDescription(overrides: Partial<ConsentDescription> = {}): ConsentDescription {
  return {
    clientId: "client-123",
    clientName: "Claude",
    redirectUri: "https://claude.ai/api/mcp/auth_callback",
    redirectHost: "claude.ai",
    redirectIsLoopback: false,
    scope: ["garmin:read"],
    ...overrides,
  };
}

function makeMockOAuthHelpers(overrides: Partial<OAuthHelpers> = {}): OAuthHelpers {
  const authRequest = makeAuthRequest();
  return {
    parseAuthRequest: vi.fn().mockResolvedValue(authRequest),
    lookupClient: vi.fn().mockResolvedValue(null),
    completeAuthorization: vi.fn().mockResolvedValue({
      redirectTo: "https://claude.ai/api/mcp/auth_callback?code=issued-code&state=client-state-xyz",
    }),
    describeConsent: vi.fn().mockResolvedValue(makeConsentDescription()),
    isConsentRemembered: vi.fn().mockResolvedValue(false),
    beginConsent: vi.fn().mockResolvedValue({
      handle: "consent-handle-abc",
      headers: new Headers({
        "Set-Cookie": "__Host-oauth-consent-1=hash; Path=/; Secure; HttpOnly; SameSite=Lax",
      }),
    }),
    approveConsent: vi.fn().mockResolvedValue({
      request: authRequest,
      headers: new Headers({ "Cache-Control": "no-store" }),
    }),
    denyConsent: vi.fn().mockResolvedValue({
      request: authRequest,
      redirectTo:
        "https://claude.ai/api/mcp/auth_callback?error=access_denied&state=client-state-xyz",
      headers: new Headers({
        Location:
          "https://claude.ai/api/mcp/auth_callback?error=access_denied&state=client-state-xyz",
      }),
    }),
    beginUpstream: vi.fn().mockResolvedValue({
      state: "upstream-state-999",
      headers: new Headers({
        "Set-Cookie": "__Host-oauth-upstream-1=hash; Path=/; Secure; HttpOnly; SameSite=Lax",
      }),
    }),
    finishUpstream: vi.fn().mockResolvedValue({
      request: authRequest,
      data: { codeVerifier: "pkce-verifier-value" },
      headers: new Headers({
        "Set-Cookie": "__Host-oauth-upstream-1=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0",
      }),
    }),
    createClient: vi.fn(),
    listClients: vi.fn(),
    updateClient: vi.fn(),
    deleteClient: vi.fn(),
    listUserGrants: vi.fn(),
    revokeGrant: vi.fn(),
    unwrapToken: vi.fn(),
    exchangeToken: vi.fn(),
    purgeExpiredData: vi.fn(),
    ...overrides,
  } as unknown as OAuthHelpers;
}

function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    OAUTH_KV: {} as KVNamespace,
    OAUTH_PROVIDER: makeMockOAuthHelpers(),
    GARMIN_PERSONAL_API_KEY: "test-garmin-key",
    GITHUB_CLIENT_ID: "gh-client-id",
    GITHUB_CLIENT_SECRET: "gh-client-secret",
    COOKIE_ENCRYPTION_KEY: "0123456789abcdef0123456789abcdef",
    ALLOWED_GITHUB_LOGIN: "runner-owner",
    TIMEZONE: "UTC",
    GARMIN_BASE_URL: "https://personal.connectapi.garmin.com",
    ...overrides,
  };
}

function makeExecutionContext(props?: Partial<AuthProps>): ExecutionContext {
  return {
    waitUntil: vi.fn(),
    passThroughOnException: vi.fn(),
    props,
  } as unknown as ExecutionContext;
}

describe("allowlist helpers", () => {
  it("fails closed when ALLOWED_GITHUB_LOGIN is unset, blank, or invalid", () => {
    expect(resolveAllowedGitHubLogin({})).toBeNull();
    expect(resolveAllowedGitHubLogin({ ALLOWED_GITHUB_LOGIN: "" })).toBeNull();
    expect(resolveAllowedGitHubLogin({ ALLOWED_GITHUB_LOGIN: "   " })).toBeNull();
    expect(resolveAllowedGitHubLogin({ ALLOWED_GITHUB_LOGIN: "*" })).toBeNull();
    expect(resolveAllowedGitHubLogin({ ALLOWED_GITHUB_LOGIN: "alice,bob" })).toBeNull();
    expect(resolveAllowedGitHubLogin({ ALLOWED_GITHUB_LOGIN: "-bad" })).toBeNull();
    expect(resolveAllowedGitHubLogin({ ALLOWED_GITHUB_LOGIN: "bad-" })).toBeNull();
    expect(resolveAllowedGitHubLogin({ ALLOWED_GITHUB_LOGIN: "bad--name" })).toBeNull();

    expect(isAllowedGitHubLogin("alice", {})).toBe(false);
    expect(isAllowedGitHubLogin("alice", { ALLOWED_GITHUB_LOGIN: "" })).toBe(false);
    expect(isAllowedGitHubLogin("alice", { ALLOWED_GITHUB_LOGIN: "alice,bob" })).toBe(false);
  });

  it("matches single valid GitHub logins case-insensitively", () => {
    expect(resolveAllowedGitHubLogin({ ALLOWED_GITHUB_LOGIN: " Runner-Owner " })).toBe(
      "runner-owner",
    );
    expect(isAllowedGitHubLogin("Runner-Owner", { ALLOWED_GITHUB_LOGIN: "runner-owner" })).toBe(
      true,
    );
    expect(isAllowedGitHubLogin("RUNNER-OWNER", { ALLOWED_GITHUB_LOGIN: "runner-owner" })).toBe(
      true,
    );
    expect(isAllowedGitHubLogin("someone-else", { ALLOWED_GITHUB_LOGIN: "runner-owner" })).toBe(
      false,
    );
    expect(isAllowedGitHubLogin("", { ALLOWED_GITHUB_LOGIN: "runner-owner" })).toBe(false);
  });

  it("escapes HTML special characters", () => {
    expect(escapeHtml(`<script>alert("x&'y'")</script>`)).toBe(
      "&lt;script&gt;alert(&quot;x&amp;&#39;y&#39;&quot;)&lt;/script&gt;",
    );
  });
});

describe("GitHub OAuth handler", () => {
  it("serves landing page on GET / with non-affiliation notice", async () => {
    const handler = createGitHubAuthHandler();
    const res = await handler.fetch(
      new Request("https://garmin-mcp.example.workers.dev/"),
      makeEnv(),
      makeExecutionContext(),
    );

    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Not affiliated with or endorsed by Garmin");
    expect(html).toContain("/mcp");
  });

  it("fails closed with 503 on /authorize and /callback when ALLOWED_GITHUB_LOGIN is unset", async () => {
    const handler = createGitHubAuthHandler();
    const env = makeEnv({ ALLOWED_GITHUB_LOGIN: "" });

    const authRes = await handler.fetch(
      new Request("https://garmin-mcp.example.workers.dev/authorize?client_id=test"),
      env,
      makeExecutionContext(),
    );
    expect(authRes.status).toBe(503);
    expect(await authRes.text()).toContain("ALLOWED_GITHUB_LOGIN");
    expect(env.OAUTH_PROVIDER.parseAuthRequest).not.toHaveBeenCalled();

    const callbackRes = await handler.fetch(
      new Request("https://garmin-mcp.example.workers.dev/callback?code=abc&state=xyz"),
      env,
      makeExecutionContext(),
    );
    expect(callbackRes.status).toBe(503);
    expect(env.OAUTH_PROVIDER.finishUpstream).not.toHaveBeenCalled();
  });

  it("fails closed with 503 when GitHub OAuth credentials are missing", async () => {
    const handler = createGitHubAuthHandler();
    const env = makeEnv({ GITHUB_CLIENT_SECRET: "" });

    const res = await handler.fetch(
      new Request("https://garmin-mcp.example.workers.dev/authorize?client_id=test"),
      env,
      makeExecutionContext(),
    );
    expect(res.status).toBe(503);
    expect(await res.text()).toContain("GITHUB_CLIENT_ID");
  });

  it("renders escaped consent page with anti-framing headers and loopback warning", async () => {
    const oauth = makeMockOAuthHelpers({
      describeConsent: vi.fn().mockResolvedValue(
        makeConsentDescription({
          clientName: `<img src=x onerror="alert(1)">`,
          redirectHost: "localhost",
          redirectIsLoopback: true,
        }),
      ),
    });
    const handler = createGitHubAuthHandler();
    const res = await handler.fetch(
      new Request("https://garmin-mcp.example.workers.dev/authorize?client_id=client-123"),
      makeEnv({ OAUTH_PROVIDER: oauth }),
      makeExecutionContext(),
    );

    expect(res.status).toBe(200);
    expect(res.headers.get("X-Frame-Options")).toBe("DENY");
    expect(res.headers.get("Content-Security-Policy")).toBe("frame-ancestors 'none'");
    expect(res.headers.get("Cache-Control")).toBe("no-store");

    const html = await res.text();
    expect(html).not.toContain(`<img src=x onerror="alert(1)">`);
    expect(html).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
    expect(html).toContain("Local application redirect");
    expect(html).toContain('name="handle" value="consent-handle-abc"');
  });

  it("skips consent page and redirects to GitHub with PKCE when consent is remembered", async () => {
    const oauth = makeMockOAuthHelpers({
      isConsentRemembered: vi.fn().mockResolvedValue(true),
    });
    const handler = createGitHubAuthHandler();
    const res = await handler.fetch(
      new Request("https://garmin-mcp.example.workers.dev/authorize?client_id=client-123"),
      makeEnv({ OAUTH_PROVIDER: oauth }),
      makeExecutionContext(),
    );

    expect(res.status).toBe(302);
    expect(oauth.beginConsent).not.toHaveBeenCalled();
    expect(oauth.beginUpstream).toHaveBeenCalledTimes(1);

    const location = new URL(res.headers.get("Location") ?? "");
    expect(location.origin).toBe("https://github.com");
    expect(location.pathname).toBe("/login/oauth/authorize");
    expect(location.searchParams.get("client_id")).toBe("gh-client-id");
    expect(location.searchParams.get("redirect_uri")).toBe(
      "https://garmin-mcp.example.workers.dev/callback",
    );
    expect(location.searchParams.get("scope")).toBe("read:user");
    expect(location.searchParams.get("state")).toBe("upstream-state-999");
    expect(location.searchParams.get("code_challenge_method")).toBe("S256");
    expect(location.searchParams.get("code_challenge")).toBeTruthy();
  });

  it("handles consent approval on POST /authorize and redirects to GitHub with PKCE", async () => {
    const oauth = makeMockOAuthHelpers();
    const handler = createGitHubAuthHandler();
    const form = new URLSearchParams({
      handle: "consent-handle-abc",
      decision: "approve",
    });

    const res = await handler.fetch(
      new Request("https://garmin-mcp.example.workers.dev/authorize", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: form.toString(),
      }),
      makeEnv({ OAUTH_PROVIDER: oauth }),
      makeExecutionContext(),
    );

    expect(res.status).toBe(302);
    expect(oauth.approveConsent).toHaveBeenCalledWith(expect.any(Request), "consent-handle-abc", {
      remember: { secret: "0123456789abcdef0123456789abcdef" },
    });
    expect(oauth.beginUpstream).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        data: expect.objectContaining({ codeVerifier: expect.any(String) }),
      }),
    );

    const location = new URL(res.headers.get("Location") ?? "");
    expect(location.origin).toBe("https://github.com");
    expect(location.searchParams.get("code_challenge_method")).toBe("S256");
  });

  it("handles consent denial on POST /authorize", async () => {
    const oauth = makeMockOAuthHelpers();
    const handler = createGitHubAuthHandler();
    const form = new URLSearchParams({
      handle: "consent-handle-abc",
      decision: "deny",
    });

    const res = await handler.fetch(
      new Request("https://garmin-mcp.example.workers.dev/authorize", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: form.toString(),
      }),
      makeEnv({ OAUTH_PROVIDER: oauth }),
      makeExecutionContext(),
    );

    expect(res.status).toBe(302);
    expect(oauth.denyConsent).toHaveBeenCalledTimes(1);
    expect(res.headers.get("Location")).toContain("error=access_denied");
  });

  it("authorizes the allowlisted GitHub user on GET /callback without storing GitHub tokens", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ access_token: "gho_ephemeral_token" }))
      .mockResolvedValueOnce(Response.json({ id: 424242, login: "Runner-Owner" }));

    const oauth = makeMockOAuthHelpers();
    const handler = createGitHubAuthHandler({ fetchFn: fetchMock });

    const res = await handler.fetch(
      new Request(
        "https://garmin-mcp.example.workers.dev/callback?code=gh-code&state=upstream-state-999",
      ),
      makeEnv({ OAUTH_PROVIDER: oauth, ALLOWED_GITHUB_LOGIN: "runner-owner" }),
      makeExecutionContext(),
    );

    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe(
      "https://claude.ai/api/mcp/auth_callback?code=issued-code&state=client-state-xyz",
    );

    // Verify PKCE code_verifier was sent to GitHub
    const tokenCallInit = fetchMock.mock.calls[0]?.[1];
    const tokenBody = JSON.parse(String(tokenCallInit?.body)) as Record<string, string>;
    expect(tokenBody.code).toBe("gh-code");
    expect(tokenBody.code_verifier).toBe("pkce-verifier-value");
    expect(tokenBody.redirect_uri).toBe("https://garmin-mcp.example.workers.dev/callback");

    // Verify completeAuthorization stored minimal props and NO GitHub token
    expect(oauth.completeAuthorization).toHaveBeenCalledWith({
      request: expect.anything(),
      userId: "424242",
      metadata: { githubLogin: "Runner-Owner" },
      scope: ["garmin:read"],
      props: { githubLogin: "Runner-Owner", githubId: 424242 },
    });
  });

  it("rejects a non-allowlisted GitHub account with 403 and never discloses ALLOWED_GITHUB_LOGIN", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ access_token: "gho_other_user" }))
      .mockResolvedValueOnce(Response.json({ id: 999999, login: "other-user" }));

    const oauth = makeMockOAuthHelpers();
    const handler = createGitHubAuthHandler({ fetchFn: fetchMock });

    const res = await handler.fetch(
      new Request(
        "https://garmin-mcp.example.workers.dev/callback?code=gh-code&state=upstream-state-999",
      ),
      makeEnv({ OAUTH_PROVIDER: oauth, ALLOWED_GITHUB_LOGIN: "secret-owner-handle" }),
      makeExecutionContext(),
    );

    expect(res.status).toBe(403);
    expect(oauth.completeAuthorization).not.toHaveBeenCalled();
    expect(res.headers.get("Set-Cookie")).toContain("Max-Age=0");

    const html = await res.text();
    expect(html).toContain("@other-user");
    expect(html).toContain("not permitted");
    expect(html).not.toContain("secret-owner-handle");
  });

  it("redirects with access_denied when GitHub returns an error query param", async () => {
    const oauth = makeMockOAuthHelpers();
    const handler = createGitHubAuthHandler();

    const res = await handler.fetch(
      new Request(
        "https://garmin-mcp.example.workers.dev/callback?error=access_denied&state=upstream-state-999",
      ),
      makeEnv({ OAUTH_PROVIDER: oauth }),
      makeExecutionContext(),
    );

    expect(res.status).toBe(302);
    const location = new URL(res.headers.get("Location") ?? "");
    expect(location.origin).toBe("https://claude.ai");
    expect(location.searchParams.get("error")).toBe("access_denied");
    expect(location.searchParams.get("state")).toBe("client-state-xyz");
  });

  it("handles AuthorizationError safely (redirects only when redirectTo is set)", async () => {
    const oauthRedirect = makeMockOAuthHelpers({
      parseAuthRequest: vi.fn().mockRejectedValue(
        new AuthorizationError("invalid_scope", {
          description: "Unsupported scope",
          redirectUri: "https://claude.ai/api/mcp/auth_callback",
          state: "client-state-xyz",
        }),
      ),
    });
    const handler = createGitHubAuthHandler();

    const redirectRes = await handler.fetch(
      new Request("https://garmin-mcp.example.workers.dev/authorize?client_id=client-123"),
      makeEnv({ OAUTH_PROVIDER: oauthRedirect }),
      makeExecutionContext(),
    );
    expect(redirectRes.status).toBe(302);
    expect(redirectRes.headers.get("Location")).toContain("error=invalid_scope");

    const oauthLocal = makeMockOAuthHelpers({
      parseAuthRequest: vi.fn().mockRejectedValue(
        new AuthorizationError("invalid_request", {
          description: "Unknown client_id",
        }),
      ),
    });
    const localRes = await handler.fetch(
      new Request("https://garmin-mcp.example.workers.dev/authorize?client_id=unknown"),
      makeEnv({ OAUTH_PROVIDER: oauthLocal }),
      makeExecutionContext(),
    );
    expect(localRes.status).toBe(400);
    expect(await localRes.text()).toContain("Unknown client_id");
  });

  it("renders local 400 when CimdFetchError occurs", async () => {
    const oauth = makeMockOAuthHelpers({
      parseAuthRequest: vi
        .fn()
        .mockRejectedValue(
          new CimdFetchError("https://bad.example/client.json", new Error("Timeout")),
        ),
    });
    const handler = createGitHubAuthHandler();

    const res = await handler.fetch(
      new Request(
        "https://garmin-mcp.example.workers.dev/authorize?client_id=https://bad.example/client.json",
      ),
      makeEnv({ OAUTH_PROVIDER: oauth }),
      makeExecutionContext(),
    );
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("Could not verify MCP client");
  });
});

describe("MCP API handler defense-in-depth and resource resolution", () => {
  it("resolves canonical resource from MCP_RESOURCE var or request origin", () => {
    expect(resolveCanonicalResource(new Request("http://localhost:8787/mcp"), {})).toBe(
      "http://localhost:8787/mcp",
    );
    expect(resolveCanonicalResource(new Request("https://demo.workers.dev/authorize"), {})).toBe(
      "https://demo.workers.dev/mcp",
    );
    expect(
      resolveCanonicalResource(new Request("https://demo.workers.dev/mcp"), {
        MCP_RESOURCE: "https://custom.example.com/mcp",
      }),
    ).toBe("https://custom.example.com/mcp");
  });

  it("fails closed on /mcp when ALLOWED_GITHUB_LOGIN is unset or mismatches token props", async () => {
    const req = new Request("http://localhost:8787/mcp", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });

    const unsetRes = await mcpApiHandler.fetch(
      req.clone(),
      makeEnv({ ALLOWED_GITHUB_LOGIN: "" }),
      makeExecutionContext({ githubLogin: "runner-owner", githubId: 42 }),
    );
    expect(unsetRes.status).toBe(403);

    const mismatchRes = await mcpApiHandler.fetch(
      req.clone(),
      makeEnv({ ALLOWED_GITHUB_LOGIN: "runner-owner" }),
      makeExecutionContext({ githubLogin: "other-user", githubId: 99 }),
    );
    expect(mismatchRes.status).toBe(403);
  });

  it("serves MCP tools/list for allowlisted user", async () => {
    const listReq = new Request("http://localhost:8787/mcp", {
      method: "POST",
      headers: {
        Host: "localhost:8787",
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        Origin: "https://claude.ai",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list",
        params: {},
      }),
    });

    const res = await mcpApiHandler.fetch(
      listReq,
      makeEnv({ ALLOWED_GITHUB_LOGIN: "runner-owner", TIMEZONE: "UTC" }),
      makeExecutionContext({ githubLogin: "Runner-Owner", githubId: 42 }),
    );

    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("list_activities");
    expect(body).toContain("recovery_snapshot");
  });
});
