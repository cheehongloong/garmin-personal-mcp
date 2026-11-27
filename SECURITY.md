# Security Policy

## Self-Hosted Responsibility Model

`garmin-personal-mcp` is an open-source, **single-user, self-hosted** Cloudflare Worker. There is no hosted or multi-tenant service operated by the maintainers.

- Each deployer runs their own Cloudflare Worker in their own Cloudflare account.
- Each deployer owns and manages their own Garmin Connect Personal API key, GitHub OAuth App credentials, Cloudflare Workers KV namespace, and health data.
- The server includes no analytics, telemetry, or logging of Garmin tokens or health data payloads.

## Security Architecture Highlights

- **Single-user allowlist (fail-closed):** Authorization and `/mcp` requests fail closed unless `ALLOWED_GITHUB_LOGIN` is set to a single valid GitHub username. Any other GitHub account is rejected with HTTP `403` before an OAuth grant is issued.
- **Minimal OAuth state:** Upstream GitHub access tokens are used only during the callback to verify the GitHub login and are never stored in KV or encrypted token props.
- **OAuth 2.1 + PKCE (`S256`):** Powered by `@cloudflare/workers-oauth-provider`, with browser-bound `__Host-` cookies and anti-framing headers (`X-Frame-Options: DENY`, `Content-Security-Policy: frame-ancestors 'none'`) on consent and upstream sign-in flows.
- **Read-only scope:** Uses only Garmin's official read-only Personal API endpoints.
- **Response PII scrubbing by default:** Tool responses strip personal identifiers (`ownerFullName`, `ownerDisplayName`, `displayName`, `ownerId`, `userProfilePK`, profile image URLs), hardware/device IDs (`deviceId`, `deviceApplicationInstallationId`, `serialNumber`), and exact start/end GPS coordinates before returning data to MCP clients.

## Reporting a Vulnerability

If you discover a security vulnerability in this repository (such as an authentication bypass, XSS in the consent/error pages, SSRF, or secret leakage):

1. **Do not open a public GitHub issue.**
2. Report it privately using **GitHub Security Advisories** (`Security` → `Advisories` → `Report a vulnerability` on this repository).
3. Include a clear description, reproduction steps, and impact assessment.

We aim to acknowledge reports within 72 hours and publish a fix and advisory promptly once confirmed.

## Rotating Compromised Credentials

If you believe your deployment credentials were exposed:

1. **Garmin Personal API key:** Delete and recreate the key in Garmin Connect (**Account Settings → Personal API Key**), then run `yarn wrangler secret put GARMIN_PERSONAL_API_KEY`. Cached bearer tokens are bound to a hash of the API key and are invalidated automatically on rotation; you can also delete `garmin:bearer_token` from `OAUTH_KV` immediately.
2. **GitHub OAuth App secret:** Generate a new client secret in GitHub Developer Settings, revoke the old secret, and run `yarn wrangler secret put GITHUB_CLIENT_SECRET`.
3. **Active MCP grants:** Delete the client or grant keys from `OAUTH_KV` (or delete and recreate the KV namespace) and remove the connector from Claude.
