# Contributing to garmin-personal-mcp

Contributions that improve reliability, security, documentation, or official Garmin Personal API coverage are welcome.

## Scope & Non-Goals

Before opening a pull request, please keep these boundaries in mind:

- **Single-user, self-hosted only:** Garmin's Personal API is for accessing your own data, not for operating a multi-user SaaS.
- **Official Personal API only:** Do not add unofficial/reverse-engineered Garmin endpoints or libraries (such as `garth` or `python-garminconnect`).
- **Read-only:** The Garmin Personal API does not support write actions.
- **No telemetry or health-data logging:** Never log Garmin tokens, API keys, or health response bodies.
- **No personal data in commits:** All tests, fixtures, and documentation examples must use synthetic data.

## Local Development

### Prerequisites

- Node.js 24+ (LTS recommended)
- Yarn 4 via Corepack (`corepack enable`)

### Setup & Checks

```sh
yarn install
cp .dev.vars.example .dev.vars
```

Run all local checks before opening a PR:

```sh
yarn typecheck
yarn lint
yarn test
yarn wrangler deploy --dry-run
```

## Pull Request Guidelines

- Keep commits small and focused with clear messages.
- Add or update Vitest unit tests with mocked `fetch` for any behavior change (CI never makes live Garmin calls).
- Never commit `.dev.vars`, `.wrangler/`, real Cloudflare IDs/URLs, or real Garmin payloads.
