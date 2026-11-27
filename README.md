# garmin-personal-mcp

A private, self-hosted remote [Model Context Protocol (MCP)](https://modelcontextprotocol.io) server that lets Claude (on web and mobile) read **your own** Garmin Connect data via Garmin's official Personal API.

> **Disclaimer:** Not affiliated with or endorsed by Garmin. Garmin and Garmin Connect are trademarks of Garmin Ltd. or its subsidiaries.

---

## Not technical? Read here — setup is easy (and free)

You **don't need to know how to code**, edit config files, or manage a server.

All you need are:
1. A free **GitHub** account
2. A free **Cloudflare** account
3. Your **Garmin Connect** account

If you use an AI coding assistant (**Claude Code**, **Antigravity**, **Cursor**, **Codex**, etc.), it can handle almost the entire setup for you in about 5 minutes — just paste this prompt:

```text
Clone https://github.com/cheehongloong/garmin-personal-mcp and follow AGENTS.md to deploy my personal Garmin MCP server to Cloudflare Workers. Handle all terminal steps yourself and guide me one click at a time whenever I need to click something in the browser.
```

You will only need to do **4 quick browser clicks** yourself (logging into Cloudflare, clicking "Create Key" in Garmin Connect, clicking "Register application" in GitHub, and pasting your final URL into `claude.ai`). Your assistant takes care of everything else.

---

## Why self-host instead of using a hosted app?

1. **Your Garmin Personal API key stays yours:** Your Garmin Personal API key unlocks read access to your sleep, heart rate, HRV, stress, and GPS workout history. When you self-host on your own free Cloudflare account, **no third-party developer, startup, or shared server ever touches your API key or your health data**.
2. **Official Garmin Personal API (no password scraping):** Garmin's Personal API is built specifically for individuals reading *their own* data — not for multi-user SaaS apps. Unlike unofficial libraries that ask for your Garmin password and break whenever Garmin updates its login screen, this uses Garmin's official API key.
3. **Locked to one account, runs for free:** Access is gated by your own GitHub login (`ALLOWED_GITHUB_LOGIN`) — anyone else trying to sign in gets rejected immediately — and everything runs comfortably on Cloudflare's Free tier.
4. **Privacy-first by default:** Zero analytics, zero telemetry, and zero logging of tokens or health payloads. Before responses reach Claude, the server automatically strips your name, Garmin owner/profile IDs, profile photo links, device IDs, and exact start/end GPS coordinates, trims unused fields and raw per-minute arrays, adds an explicit `units` map + ready-made pace strings, and normalizes unworn sleep nights and Garmin's `-1` no-data stress sentinels to `{ date, recorded: false }`.

![Synthetic example of Claude answering a training recovery question using garmin-personal-mcp](docs/recovery-example.svg)

---

## Prerequisites

1. **A Cloudflare account** — the Free tier is sufficient (Workers + Workers KV).
2. **A GitHub account** — used to authenticate yourself during OAuth sign-in.
3. **A Garmin Connect Personal API key:**
   1. Sign in to [connect.garmin.com](https://connect.garmin.com).
   2. Open your **Profile & Account** menu → **Account Settings**.
   3. Open the **Personal API Key** section and click **Create Key**.
   4. Accept the terms, pick an expiration period, and click **Create**.
   5. Copy the key immediately — Garmin only displays it once.

---

## Deploy

### Option A: Hands-off setup with an AI agent (Recommended for non-technical users)

Paste the prompt in [Not technical? Read here](#not-technical-read-here--setup-is-easy-and-free) above into Claude Code, Antigravity, Cursor, or Codex. It follows [AGENTS.md](AGENTS.md) step-by-step and verifies your live server automatically.

### Option B: One-click Deploy to Cloudflare

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/cheehongloong/garmin-personal-mcp)

1. Click the button above to clone the repo into your GitHub account, provision the `OAUTH_KV` Workers KV namespace, and deploy your Worker (`https://garmin-personal-mcp.<your-subdomain>.workers.dev`).
2. Continue to [Create a GitHub OAuth App](#create-a-github-oauth-app) and [Configure secrets and vars](#configure-secrets-and-vars) below.

### Option C: Manual deploy with Wrangler

Requires **Node.js 24+** and **Yarn 4** (`corepack enable`).

```sh
git clone https://github.com/cheehongloong/garmin-personal-mcp.git
cd garmin-personal-mcp
corepack enable
yarn install
yarn wrangler login
```

Create a KV namespace for OAuth state and Garmin bearer-token caching:

```sh
yarn wrangler kv namespace create OAUTH_KV
```

Copy `wrangler.jsonc` to a gitignored `wrangler.local.jsonc` (or update your fork's `wrangler.jsonc`) with:
- Your new `OAUTH_KV` namespace `id`
- `ALLOWED_GITHUB_LOGIN`: your exact GitHub username (the Worker fails closed if empty)
- `TIMEZONE`: your IANA timezone (e.g. `"America/New_York"`, `"Europe/London"`, `"Asia/Tokyo"`) so "today" and 7-day defaults match your local calendar

Deploy:

```sh
yarn wrangler deploy -c wrangler.local.jsonc
```

Note the deployed Worker URL printed by Wrangler, e.g. `https://garmin-personal-mcp.<your-subdomain>.workers.dev`.

---

## Create a GitHub OAuth App

1. Go to **GitHub Settings → Developer settings → OAuth Apps → New OAuth App** ([github.com/settings/developers](https://github.com/settings/developers)).
2. Fill in the exact URLs for your Worker:
   - **Application name:** `garmin-personal-mcp` (or anything you like)
   - **Homepage URL:** `https://<worker-name>.<your-subdomain>.workers.dev`
   - **Authorization callback URL:** `https://<worker-name>.<your-subdomain>.workers.dev/callback`
3. Click **Register application**, then click **Generate a new client secret**.
4. Copy the **Client ID** and **Client Secret**.

*(For local development with `yarn dev`, create a separate OAuth App with Homepage URL `http://localhost:8787` and Authorization callback URL `http://localhost:8787/callback`.)*

---

## Configure secrets and vars

### Secrets

Set these in the Cloudflare Dashboard (**Workers & Pages → `<your-worker>` → Settings → Variables and Secrets**) or with Wrangler (note: pass the **secret name**, and paste the value when prompted):

```sh
yarn wrangler secret put GARMIN_PERSONAL_API_KEY -c wrangler.local.jsonc
yarn wrangler secret put GITHUB_CLIENT_ID -c wrangler.local.jsonc
yarn wrangler secret put GITHUB_CLIENT_SECRET -c wrangler.local.jsonc

# Generate a 32-byte random hex key for remembering consent across browser sessions:
openssl rand -hex 32
yarn wrangler secret put COOKIE_ENCRYPTION_KEY -c wrangler.local.jsonc
```

### Vars (`wrangler.local.jsonc` / `wrangler.jsonc` or Cloudflare Dashboard)

| Variable | Required | Default | Description |
|---|---|---|---|
| `ALLOWED_GITHUB_LOGIN` | **Yes** | `""` | Exact single GitHub username allowed to authorize. **Fails closed (`503`/`403`) if unset or invalid.** |
| `TIMEZONE` | No | `"UTC"` | IANA timezone used for "today" and default 7-day ranges (Workers run in UTC). |
| `GARMIN_BASE_URL` | No | `https://personal.connectapi.garmin.com` | Official Garmin Personal API base URL. |
| `MCP_RESOURCE` | No | Derived from request origin | Optional override for the canonical RFC 9728 MCP resource URL (defaults to `https://<host>/mcp`). |

If you used the **Deploy to Cloudflare** button, set `ALLOWED_GITHUB_LOGIN` and `TIMEZONE` under **Settings → Variables and Secrets** (or commit them in your forked repo's `wrangler.jsonc`) and redeploy.

---

## Add to claude.ai (web & mobile)

### On web (`claude.ai`)

1. Open [claude.ai](https://claude.ai) → **Settings → Connectors** (or **Customize → Connectors**).
2. Click **Add custom connector**.
3. Enter your remote MCP URL:
   ```text
   https://<worker-name>.<your-subdomain>.workers.dev/mcp
   ```
4. Leave the OAuth client fields on automatic registration (Dynamic Client Registration and Client ID Metadata Documents are both enabled).
5. Click **Connect** → review the consent screen → click **Continue with GitHub** and sign in with your allowlisted GitHub account.

### On mobile (Claude iOS / Android app)

Custom connectors added on `claude.ai` sync automatically to the Claude mobile app on the same account. Open a new chat on your phone, ensure the connector is enabled in the chat's tools/connectors menu, and ask about your training or recovery.

*(Because this server implements standard MCP Streamable HTTP + OAuth 2.1 + PKCE + DCR + CIMD, it also works with other compatible remote MCP clients such as MCP Inspector or Gemini Custom Apps where available.)*

---

## Available tools

All 14 tools are strictly **read-only**. Range tools default to the last 7 days ending today in `TIMEZONE`. Dates use `YYYY-MM-DD`.

| Tool | Description |
|---|---|
| `list_activities` | List activities newest first (`limit` 1–100, `start`, optional `start_date`, `end_date`, `activity_type`, `activity_sub_type`). Includes a `units` map and ready-made pace/speed. |
| `get_activity` | Full summary for one activity by `activity_id` (distance, time, ready-made pace, HR, cadence, power, training effect, split summaries) with a `units` map. |
| `get_activity_splits` | Laps/splits and workout steps for one activity. |
| `get_sleep` | Detailed sleep for one night (stages, score, duration). Returns `{date, recorded: false}` if unworn. Defaults to today. |
| `get_sleep_range` | Daily sleep summaries across a date range (default last 7 days). Unworn nights return `{date, recorded: false}`. |
| `get_hrv` | Daily HRV summaries across a date range (default last 7 days). |
| `get_body_battery` | Daily Body Battery reports (charged, drained, daily high/low/start/end, feedback events; default last 7 days). |
| `get_stress` | Daily stress stats across a date range (default last 7 days). Negative `-1` no-data sentinels are normalized. |
| `get_daily_summaries` | Daily steps, calories, resting HR, and intensity minutes (default last 7 days). |
| `get_heart_rate_day` | Daily resting/min/max heart rate plus compact hourly min/avg/max buckets (default today). |
| `get_heart_rate_zones` | Your configured Garmin heart rate zones. |
| `get_fitness_age` | Garmin fitness age for a date (default today). |
| `get_profile` | Non-identifying profile preferences (units, time format, sleep schedule, training days). |
| `recovery_snapshot` | Parallel fetch of sleep summaries, HRV, Body Battery, and stress for the last `days` (default 7). |

### Example prompts

- *"Check my recovery snapshot for the last 7 days — should I do intervals today or take an easy run?"*
- *"List my last 10 running activities and compare my pace and average HR on my longest run."*
- *"Pull the splits from my latest workout and show how evenly I paced each lap."*
- *"How has my resting heart rate and sleep duration trended over the last 14 days?"*

---

## Maintenance: rotating keys, revoking access, and deleting

### Rotate your Garmin Personal API key

1. Delete the old key and create a new one in Garmin Connect (**Account Settings → Personal API Key**).
2. Update the Worker secret:
   ```sh
   yarn wrangler secret put GARMIN_PERSONAL_API_KEY -c wrangler.local.jsonc
   ```
3. Cached Garmin bearer tokens in KV are bound to a hash of the API key and invalidate automatically on the next request. To clear the cached entry immediately:
   ```sh
   yarn wrangler kv key delete --binding OAUTH_KV --remote garmin:bearer_token -c wrangler.local.jsonc
   ```

### Revoke MCP access

1. In `claude.ai` → **Settings → Connectors**, disconnect or remove the custom connector.
2. To revoke all active OAuth tokens and grants server-side, delete the `grant:*` / `token:*` / `client:*` entries in your `OAUTH_KV` namespace (or delete and recreate the KV namespace).
3. In GitHub **Settings → Applications → Authorized OAuth Apps**, revoke your `garmin-personal-mcp` OAuth App.

### Delete the deployment

```sh
yarn wrangler delete -c wrangler.local.jsonc
```

Then delete the `OAUTH_KV` namespace in the Cloudflare Dashboard (**Storage & Databases → KV**), delete your GitHub OAuth App, and optionally delete your Garmin Personal API key.

---

## Local development

```sh
cp .dev.vars.example .dev.vars
# Fill in your dev GitHub OAuth App credentials, COOKIE_ENCRYPTION_KEY,
# ALLOWED_GITHUB_LOGIN, TIMEZONE, and GARMIN_PERSONAL_API_KEY.

yarn dev
```

Run checks:

```sh
yarn typecheck
yarn lint
yarn test
```

Connect [MCP Inspector](https://github.com/modelcontextprotocol/inspector) to `http://localhost:8787/mcp` (Streamable HTTP) to test OAuth and tools locally.

---

## Limitations

- **Read-only:** Garmin's Personal API does not support creating workouts, modifying activities, or writing data.
- **Single user:** Built strictly for one owner per deployment (`ALLOWED_GITHUB_LOGIN`). Do not expose a shared multi-user instance on a Personal API key.
- **No activity weather tool:** `get_activity_weather` (`/activity-service/activity/{id}/weather`) was tested against the Garmin Personal API and consistently returned `404 NOT_FOUND` even on outdoor GPS runs, so it is omitted.
- **Garmin rate limits & key expiry:** Subject to Garmin Personal API rate limits and the key expiration period you chose when creating the key. Bearer tokens (valid up to 24h) are cached in Workers KV and reused while >1 hour remains, minimizing token endpoint traffic.

## License

[MIT](LICENSE)
