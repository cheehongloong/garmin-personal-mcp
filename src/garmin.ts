export const DEFAULT_GARMIN_BASE_URL = "https://personal.connectapi.garmin.com";
export const GARMIN_TOKEN_KV_KEY = "garmin:bearer_token";

const TOKEN_ENDPOINT_PATH = "/personalapitoken-service/personal-api/personal-api-key/token";
const TOKEN_MIN_REMAINING_SECONDS = 3600; // Reuse cached JWT only if >1h remains
const KV_MIN_TTL_SECONDS = 60;
const ERROR_BODY_MAX_CHARS = 300;

interface CachedBearerToken {
  token: string;
  exp: number;
  keyHash?: string;
}

export interface GarminClientOptions {
  apiKey: string;
  baseUrl?: string;
  kv?: Pick<KVNamespace, "get" | "put" | "delete">;
  fetchFn?: typeof fetch;
  nowMs?: () => number;
}

export class GarminError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GarminError";
  }
}

export class GarminHttpError extends GarminError {
  readonly status: number;
  readonly method: string;
  readonly path: string;
  readonly responseSnippet: string;

  constructor(status: number, method: string, path: string, responseText: string) {
    const trimmed = responseText.trim();
    const snippet =
      trimmed.length > 0 ? trimmed.slice(0, ERROR_BODY_MAX_CHARS) : "(empty response)";
    super(`Garmin API error ${status} on ${method} ${path}: ${snippet}`);
    this.name = "GarminHttpError";
    this.status = status;
    this.method = method;
    this.path = path;
    this.responseSnippet = snippet;
  }
}

function normalizeBaseUrl(baseUrl?: string): string {
  const raw = baseUrl?.trim() || DEFAULT_GARMIN_BASE_URL;
  return raw.replace(/\/+$/, "");
}

function decodeBase64Url(segment: string): string {
  const base64 = segment.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

/**
 * Extracts the numeric `exp` claim (Unix epoch seconds) from a raw JWT string.
 * Never includes the raw JWT in any error message.
 */
export function extractJwtExp(jwt: string): number {
  const parts = jwt.split(".");
  if (parts.length !== 3 || !parts[1]) {
    throw new GarminError("Garmin token response was not a valid JWT.");
  }
  let payload: unknown;
  try {
    payload = JSON.parse(decodeBase64Url(parts[1]));
  } catch {
    throw new GarminError("Garmin token payload could not be decoded.");
  }
  if (
    typeof payload !== "object" ||
    payload === null ||
    !("exp" in payload) ||
    typeof (payload as { exp: unknown }).exp !== "number" ||
    !Number.isFinite((payload as { exp: number }).exp)
  ) {
    throw new GarminError("Garmin token payload is missing a valid exp claim.");
  }
  return (payload as { exp: number }).exp;
}

async function computeKeyFingerprint(apiKey: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(apiKey));
  return [...new Uint8Array(digest)]
    .slice(0, 8)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function buildPathWithQuery(
  path: string,
  query?: Record<string, string | number | undefined | null>,
): string {
  if (!query) {
    return path;
  }
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null && value !== "") {
      params.set(key, String(value));
    }
  }
  const qs = params.toString();
  return qs.length > 0 ? `${path}?${qs}` : path;
}

function isValidCachedToken(value: unknown): value is CachedBearerToken {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.token === "string" &&
    candidate.token.length > 0 &&
    typeof candidate.exp === "number" &&
    Number.isFinite(candidate.exp) &&
    (candidate.keyHash === undefined || typeof candidate.keyHash === "string")
  );
}

/**
 * Pure Garmin Connect Personal API client (no MCP coupling).
 * Handles ApiKey -> JWT exchange, KV caching (>1h remaining reuse),
 * and single forced refresh + retry on HTTP 401.
 * Never logs tokens or response bodies.
 */
export class GarminClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly kv?: Pick<KVNamespace, "get" | "put" | "delete">;
  private readonly fetchFn: typeof fetch;
  private readonly nowMs: () => number;

  private inflightToken: Promise<string> | null = null;
  private keyHashPromise: Promise<string> | null = null;

  constructor(options: GarminClientOptions) {
    this.apiKey = options.apiKey.trim();
    this.baseUrl = normalizeBaseUrl(options.baseUrl);
    this.kv = options.kv;
    this.fetchFn = options.fetchFn ?? fetch;
    this.nowMs = options.nowMs ?? Date.now;
  }

  private getKeyHash(): Promise<string> {
    if (!this.keyHashPromise) {
      this.keyHashPromise = computeKeyFingerprint(this.apiKey);
    }
    return this.keyHashPromise;
  }

  private nowSeconds(): number {
    return Math.floor(this.nowMs() / 1000);
  }

  private async readCachedToken(): Promise<string | null> {
    if (!this.kv) {
      return null;
    }
    let raw: string | null;
    try {
      raw = await this.kv.get(GARMIN_TOKEN_KV_KEY);
    } catch {
      return null;
    }
    if (!raw) {
      return null;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return null;
    }
    if (!isValidCachedToken(parsed)) {
      return null;
    }
    const expectedKeyHash = await this.getKeyHash();
    if (parsed.keyHash && parsed.keyHash !== expectedKeyHash) {
      return null;
    }
    if (parsed.exp - this.nowSeconds() <= TOKEN_MIN_REMAINING_SECONDS) {
      return null;
    }
    return parsed.token;
  }

  private async writeCachedToken(token: string, exp: number): Promise<void> {
    if (!this.kv) {
      return;
    }
    const ttl = Math.floor(exp) - this.nowSeconds();
    if (ttl < KV_MIN_TTL_SECONDS) {
      return;
    }
    const keyHash = await this.getKeyHash();
    const record: CachedBearerToken = { token, exp, keyHash };
    try {
      await this.kv.put(GARMIN_TOKEN_KV_KEY, JSON.stringify(record), {
        expirationTtl: ttl,
      });
    } catch {
      // Cache write failure should not break a valid freshly minted token.
    }
  }

  private async mintBearerToken(): Promise<string> {
    if (!this.apiKey) {
      throw new GarminError(
        "GARMIN_PERSONAL_API_KEY is not configured. Set it via `wrangler secret put GARMIN_PERSONAL_API_KEY`.",
      );
    }

    let response: Response;
    try {
      response = await this.fetchFn(`${this.baseUrl}${TOKEN_ENDPOINT_PATH}`, {
        method: "POST",
        headers: {
          Authorization: `ApiKey ${this.apiKey}`,
          Accept: "*/*",
        },
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : "network error";
      throw new GarminError(`Failed to reach Garmin token endpoint: ${reason}`);
    }

    const bodyText = await response.text();
    if (!response.ok) {
      throw new GarminHttpError(response.status, "POST", TOKEN_ENDPOINT_PATH, bodyText);
    }

    const token = bodyText.trim();
    if (token.length === 0) {
      throw new GarminError("Garmin token endpoint returned an empty response.");
    }

    const exp = extractJwtExp(token);
    await this.writeCachedToken(token, exp);
    return token;
  }

  /**
   * Returns a valid Garmin bearer JWT, reusing KV cache when >1h remains.
   * Concurrent cold-cache callers coalesce onto a single token exchange.
   */
  async obtainToken(forceRefresh = false): Promise<string> {
    if (!this.apiKey) {
      throw new GarminError(
        "GARMIN_PERSONAL_API_KEY is not configured. Set it via `wrangler secret put GARMIN_PERSONAL_API_KEY`.",
      );
    }

    if (!forceRefresh) {
      const cached = await this.readCachedToken();
      if (cached) {
        return cached;
      }
      if (this.inflightToken) {
        return this.inflightToken;
      }
    }

    const pending = this.mintBearerToken().finally(() => {
      if (this.inflightToken === pending) {
        this.inflightToken = null;
      }
    });
    this.inflightToken = pending;
    return pending;
  }

  private async executeGet(fullPath: string, token: string): Promise<Response> {
    try {
      return await this.fetchFn(`${this.baseUrl}${fullPath}`, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/json",
        },
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : "network error";
      throw new GarminError(`Garmin request failed on GET ${fullPath}: ${reason}`);
    }
  }

  /**
   * Executes an authenticated GET against the Garmin Personal API.
   * Empty body returns `null`. On HTTP 401, force-refreshes token once and retries once.
   */
  async get(
    path: string,
    query?: Record<string, string | number | undefined | null>,
  ): Promise<unknown> {
    const fullPath = buildPathWithQuery(path, query);
    const token = await this.obtainToken(false);
    let response = await this.executeGet(fullPath, token);

    if (response.status === 401) {
      // Discard first response body to release resources cleanly before retrying.
      await response.text().catch(() => {});
      const freshToken = await this.obtainToken(true);
      response = await this.executeGet(fullPath, freshToken);
    }

    const bodyText = await response.text();
    if (!response.ok) {
      throw new GarminHttpError(response.status, "GET", fullPath, bodyText);
    }

    if (response.status === 204 || bodyText.trim().length === 0) {
      return null;
    }

    try {
      return JSON.parse(bodyText) as unknown;
    } catch {
      throw new GarminError(`Garmin API returned invalid JSON on GET ${fullPath}.`);
    }
  }
}

export function formatGarminError(error: unknown): string {
  if (error instanceof GarminHttpError || error instanceof GarminError) {
    return error.message;
  }
  if (error instanceof Error) {
    return `Garmin error: ${error.message}`;
  }
  return `Garmin error: ${String(error)}`;
}
