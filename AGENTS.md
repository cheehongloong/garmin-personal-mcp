# AGENTS.md — AI Coding Agent Guide for `garmin-personal-mcp`

This file is written for AI coding agents (Claude Code, Antigravity, Codex, Cursor, Windsurf, OpenCode, etc.) helping a user **self-host and deploy** their own personal Garmin Connect MCP server, or contributing to this repository.

---

## Part 1: Hands-Off Setup Playbook (Deploying for a User)

When a user asks you to set up or deploy `garmin-personal-mcp` for them, follow this exact workflow. Assume the user may be non-technical: **handle every terminal step yourself** and ask them for **one clear browser action at a time** in plain language.

### Ground Rules
- **Everything runs on free tiers:** Cloudflare Workers Free + Workers KV Free + free GitHub account + Garmin Personal API. Never create paid resources without asking.
- **Keep secrets out of git and chat:**
  - Never put real Cloudflare KV IDs, Account IDs, usernames, or secrets in the tracked `wrangler.jsonc`. Always write a gitignored `wrangler.local.jsonc` and pass `-c wrangler.local.jsonc` to Wrangler.
  - Prefer guiding the user to enter `GARMIN_PERSONAL_API_KEY`, `GITHUB_CLIENT_ID`, and `GITHUB_CLIENT_SECRET` directly via `wrangler secret put <NAME>` in their terminal or via the Cloudflare Dashboard UI. If the user pastes a secret into chat anyway, upload it without echoing it back, never write it to any tracked file, and remind them they can rotate it anytime.
  - Remember: `wrangler secret put <NAME>` takes the **secret variable name** (e.g. `GITHUB_CLIENT_SECRET`), NOT the secret value — Wrangler prompts for the value on the next line.
- **Deploy first, create the GitHub OAuth App second:** You don't know the exact `*.workers.dev` URL until the Worker deploys. Deploy first so you can hand the user the exact two URLs to paste into GitHub.

### Step-by-Step Deployment

#### 1. Check Node & install dependencies
- Verify Node.js is **24+** (`node -v`).
- Enable Corepack so **Yarn 4** (`packageManager` in `package.json`) activates automatically:
  - On Node 24 LTS: `corepack enable`
  - On Node 25/26+ (Corepack is no longer bundled): `npm install -g corepack && corepack enable`
- Run `yarn install`.

#### 2. Log into Cloudflare & select the right account
- Run `yarn wrangler login` and tell the user to click **Allow** in the browser tab that opens.
- Run `yarn wrangler whoami`:
  - If **one** account is listed, confirm it with the user and note its `Account ID`.
  - If **multiple** accounts are listed (e.g. a work/org account alongside a personal account), **ask the user which personal account to use** (or let them know they can create a free isolated account in [dash.cloudflare.com](https://dash.cloudflare.com/) → top-left account switcher → **Create Account**).
  - Always pass `CLOUDFLARE_ACCOUNT_ID=<ACCOUNT_ID>` on every Wrangler command so the wrong account is never touched.

#### 3. Create the Workers KV namespace
- Run:
  ```sh
  CLOUDFLARE_ACCOUNT_ID=<ACCOUNT_ID> yarn wrangler kv namespace create OAUTH_KV
  ```
- If Wrangler prompts *"Would you like Wrangler to add it on your behalf?"*, answer **No** (`n`) so tracked `wrangler.jsonc` stays clean.
- Copy the created KV namespace `id`.

#### 4. Gather 2 non-secret settings & write gitignored `wrangler.local.jsonc`
- Ask the user to confirm:
  1. Their exact **GitHub username** (`ALLOWED_GITHUB_LOGIN`) — if `gh` CLI is logged in, you can check `gh api user --jq .login` and ask them to confirm it's their personal account.
  2. Their **IANA timezone** (`TIMEZONE`) — detect their machine's timezone (e.g. `node -e "console.log(Intl.DateTimeFormat().resolvedOptions().timeZone)"`) and confirm it with them.
- Create gitignored `wrangler.local.jsonc`:
  ```jsonc
  {
    "$schema": "node_modules/wrangler/config-schema.json",
    "name": "garmin-personal-mcp",
    "main": "src/index.ts",
    "compatibility_date": "2026-06-11",
    "compatibility_flags": ["nodejs_compat", "global_fetch_strictly_public"],
    "vars": {
      "ALLOWED_GITHUB_LOGIN": "<exact-github-username>",
      "TIMEZONE": "<IANA-timezone>",
      "GARMIN_BASE_URL": "https://personal.connectapi.garmin.com"
    },
    "kv_namespaces": [
      {
        "binding": "OAUTH_KV",
        "id": "<KV_NAMESPACE_ID>"
      }
    ]
  }
  ```
- Tip: If the user's `*.workers.dev` subdomain already contains `garmin-personal-mcp` (so the URL would look repetitive like `garmin-personal-mcp.garmin-personal-mcp-xxx.workers.dev`), offer to set `"name": "connect"` in `wrangler.local.jsonc` for a cleaner URL.

#### 5. Deploy the Worker to get its exact URL
- Run:
  ```sh
  CLOUDFLARE_ACCOUNT_ID=<ACCOUNT_ID> yarn wrangler deploy -c wrangler.local.jsonc
  ```
- **Known Cloudflare gotcha (brand-new accounts):** If the account has never registered a `*.workers.dev` subdomain, Wrangler may error and print an outdated `/workers/onboarding` URL that returns 404. Instead, send the user to:
  `https://dash.cloudflare.com/<ACCOUNT_ID>/workers-and-pages`
  Opening **Workers & Pages** initializes their free `*.workers.dev` subdomain (they can click **Change** next to **Your subdomain** to customize it). Once done, re-run `wrangler deploy`.
- Record the deployed base URL: `https://<worker>.<subdomain>.workers.dev`.

#### 6. Generate and upload `COOKIE_ENCRYPTION_KEY` automatically
- Run (never print the secret):
  ```sh
  openssl rand -hex 32 | tr -d "\n" | CLOUDFLARE_ACCOUNT_ID=<ACCOUNT_ID> yarn wrangler secret put COOKIE_ENCRYPTION_KEY -c wrangler.local.jsonc
  ```

#### 7. Guide the user to create & store their Garmin Personal API key
Tell the user (in plain language):
1. Open [connect.garmin.com](https://connect.garmin.com) and sign in.
2. Click their profile icon → **Account Settings** → **Personal API Key** → **Create Key**.
3. Accept the terms, pick an expiration (e.g. 1 year), click **Create**, and copy the key (Garmin only shows it once).
4. Save it to their Worker using either:
   - Terminal: `CLOUDFLARE_ACCOUNT_ID=<ACCOUNT_ID> yarn wrangler secret put GARMIN_PERSONAL_API_KEY -c wrangler.local.jsonc` (paste the key when prompted), **or**
   - Cloudflare Dashboard: **Workers & Pages → `<worker>` → Settings → Variables and Secrets → Add** (`Type: Secret`, Name: `GARMIN_PERSONAL_API_KEY`).

#### 8. Guide the user to create & store their GitHub OAuth App
Give the user these **exact** values pre-filled with their deployed URL:
1. Open [github.com/settings/developers](https://github.com/settings/developers) → **OAuth Apps → New OAuth App**.
2. Fill in:
   - **Application name:** `garmin-personal-mcp`
   - **Homepage URL:** `https://<worker>.<subdomain>.workers.dev`
   - **Authorization callback URL:** `https://<worker>.<subdomain>.workers.dev/callback`
3. Click **Register application**, then **Generate a new client secret**.
4. Save both secrets to the Worker:
   - `GITHUB_CLIENT_ID`
   - `GITHUB_CLIENT_SECRET`
   via `wrangler secret put` or Cloudflare Dashboard (**Settings → Variables and Secrets**).

#### 9. Verify the live deployment
Run these checks (safe, read-only, no personal data):
```sh
BASE="https://<worker>.<subdomain>.workers.dev"
curl -sS -o /dev/null -w "GET / -> %{http_code}\n" "$BASE/"
curl -sS -i "$BASE/mcp" | grep -iE "^HTTP/|^www-authenticate:"
curl -sS "$BASE/.well-known/oauth-authorization-server" | head -c 300; echo ""
curl -sS -o /dev/null -w "GET /authorize?client_id=test -> %{http_code}\n" "$BASE/authorize?client_id=test"
```
Expected results:
- `GET /` → `200`
- `GET /mcp` → `401` with `WWW-Authenticate: Bearer ... resource_metadata="https://<worker>.<subdomain>.workers.dev/.well-known/oauth-protected-resource/mcp"`
- `/.well-known/oauth-authorization-server` → `200` JSON with `registration_endpoint` and `"client_id_metadata_document_supported":true`
- `GET /authorize?client_id=test` → **`400`** (if it returns **`503`**, `ALLOWED_GITHUB_LOGIN`, `GITHUB_CLIENT_ID`, or `GITHUB_CLIENT_SECRET` is missing — verify with `yarn wrangler secret list -c wrangler.local.jsonc`!).

#### 10. Hand off the final URL for Claude (web & mobile)
Give the user their exact connector URL:
```text
https://<worker>.<subdomain>.workers.dev/mcp
```
Tell them:
1. Open [claude.ai](https://claude.ai) → **Settings → Connectors → Add custom connector**.
2. Paste the URL above, leave the OAuth fields on automatic registration, and click **Connect**.
3. Click **Continue with GitHub** and sign in with their GitHub account.
4. Try asking Claude: *"Check my Garmin recovery snapshot for the last 7 days."*
5. It automatically syncs to the Claude iOS / Android app on the same account.

---

## Part 2: Repository Conventions (for Code Changes)

- **Stack:** Cloudflare Workers, TypeScript (`strict: true`), Yarn 4 (`nodeLinker: node-modules`), `@cloudflare/workers-oauth-provider`, `agents/mcp/server` (`createMcpHandler` stateless Streamable HTTP — do not use legacy `McpAgent` or `/sse`), `@modelcontextprotocol/server`, `zod`, `vitest`, Biome.
- **Layout:**
  - `src/index.ts` — OAuthProvider + stateless MCP handler wiring
  - `src/auth/github.ts` — GitHub upstream OAuth + PKCE + fail-closed single-user allowlist
  - `src/garmin.ts` — Garmin Personal API client (JWT exchange, KV cache, single 401 retry; no MCP code)
  - `src/sanitize.ts` — PII/device scrubbing, payload trimming, sleep/stress normalization, activity units + pace
  - `src/tools.ts` — 14 read-only MCP tool definitions
  - `src/dates.ts` — IANA timezone-aware ISO date helpers
  - `test/` — Vitest unit tests with mocked `fetch` and synthetic fixtures only
- **Checks before committing:** `yarn typecheck && yarn lint && yarn test && yarn wrangler deploy --dry-run`.
- **Hard rules:** Official read-only Garmin Personal API only; no multi-user/SaaS features; no analytics, telemetry, or logging of tokens or health payloads; no personal data, IDs, URLs, or secrets in tracked files or tests.
