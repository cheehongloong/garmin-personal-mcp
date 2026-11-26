import { describe, expect, it, vi } from "vitest";
import {
  extractJwtExp,
  formatGarminError,
  GARMIN_TOKEN_KV_KEY,
  GarminClient,
  GarminError,
  GarminHttpError,
} from "../src/garmin.js";

function makeFakeJwt(exp: number): string {
  const encode = (obj: unknown) =>
    btoa(JSON.stringify(obj)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `${encode({ alg: "RS256", typ: "JWT" })}.${encode({ sub: "synthetic-user", exp })}.sig`;
}

function makeMemoryKv() {
  const store = new Map<string, string>();
  const get = vi.fn(async (key: string) => store.get(key) ?? null);
  const put = vi.fn(async (key: string, value: string) => {
    store.set(key, value);
  });
  const del = vi.fn(async (key: string) => {
    store.delete(key);
  });
  return {
    store,
    kv: { get, put, delete: del } as unknown as Pick<KVNamespace, "get" | "put" | "delete">,
    get,
    put,
    del,
  };
}

describe("extractJwtExp", () => {
  it("extracts exp claim from valid JWTs", () => {
    const jwt = makeFakeJwt(1_800_000_000);
    expect(extractJwtExp(jwt)).toBe(1_800_000_000);
  });

  it("throws GarminError on malformed JWTs without leaking token content", () => {
    expect(() => extractJwtExp("not-a-jwt-secret-value")).toThrow(GarminError);
    try {
      extractJwtExp("not-a-jwt-secret-value");
    } catch (error) {
      expect(String(error)).not.toContain("not-a-jwt-secret-value");
    }

    const noExp = `${btoa("{}")}.${btoa(JSON.stringify({ sub: "x" }))}.sig`;
    expect(() => extractJwtExp(noExp)).toThrow(GarminError);
  });
});

describe("GarminClient", () => {
  const BASE_NOW_SEC = 1_770_000_000;
  const BASE_NOW_MS = BASE_NOW_SEC * 1000;

  it("exchanges API key for plain-text JWT, caches in KV, and reuses when >1h remains", async () => {
    const jwt = makeFakeJwt(BASE_NOW_SEC + 86_400);
    const { kv, put } = makeMemoryKv();

    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(`  ${jwt}\n`, { status: 200 }))
      .mockResolvedValueOnce(Response.json({ displayName: "synthetic" }))
      .mockResolvedValueOnce(Response.json({ zones: [1, 2, 3, 4, 5] }));

    const client = new GarminClient({
      apiKey: "synthetic-api-key",
      kv,
      fetchFn: fetchMock,
      nowMs: () => BASE_NOW_MS,
    });

    const profile = await client.get("/userprofile-service/userprofile/settings");
    expect(profile).toEqual({ displayName: "synthetic" });

    // Second call should reuse KV cache without hitting token endpoint again
    const zones = await client.get("/biometric-service/heartRateZones/v2");
    expect(zones).toEqual({ zones: [1, 2, 3, 4, 5] });

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "https://personal.connectapi.garmin.com/personalapitoken-service/personal-api/personal-api-key/token",
    );
    expect(fetchMock.mock.calls[0]?.[1]).toEqual({
      method: "POST",
      headers: {
        Authorization: "ApiKey synthetic-api-key",
        Accept: "*/*",
      },
    });
    expect(fetchMock.mock.calls[1]?.[1]).toEqual({
      method: "GET",
      headers: {
        Authorization: `Bearer ${jwt}`,
        Accept: "application/json",
      },
    });
    expect(put).toHaveBeenCalledWith(
      GARMIN_TOKEN_KV_KEY,
      expect.stringContaining(jwt),
      expect.objectContaining({ expirationTtl: 86_400 }),
    );
  });

  it("mints a new token when <=1h remains or when KV cache entry is deleted", async () => {
    const expiringJwt = makeFakeJwt(BASE_NOW_SEC + 3600); // exactly 1h left -> refresh
    const freshJwt = makeFakeJwt(BASE_NOW_SEC + 86_400);
    const thirdJwt = makeFakeJwt(BASE_NOW_SEC + 90_000);
    const { kv, store } = makeMemoryKv();

    store.set(
      GARMIN_TOKEN_KV_KEY,
      JSON.stringify({ token: expiringJwt, exp: BASE_NOW_SEC + 3600 }),
    );

    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(freshJwt, { status: 200 }))
      .mockResolvedValueOnce(Response.json({ ok: 1 }))
      .mockResolvedValueOnce(new Response(thirdJwt, { status: 200 }))
      .mockResolvedValueOnce(Response.json({ ok: 2 }));

    const client = new GarminClient({
      apiKey: "synthetic-api-key",
      kv,
      fetchFn: fetchMock,
      nowMs: () => BASE_NOW_MS,
    });

    await client.get("/userprofile-service/userprofile/settings");
    expect(fetchMock).toHaveBeenCalledTimes(2);

    // Delete KV entry -> next call mints fresh token
    store.delete(GARMIN_TOKEN_KV_KEY);
    await client.get("/userprofile-service/userprofile/settings");
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("ignores cached token when GARMIN_PERSONAL_API_KEY has been rotated", async () => {
    const oldJwt = makeFakeJwt(BASE_NOW_SEC + 86_400);
    const newJwt = makeFakeJwt(BASE_NOW_SEC + 86_400);
    const { kv } = makeMemoryKv();

    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(oldJwt, { status: 200 }))
      .mockResolvedValueOnce(Response.json({ v: 1 }))
      .mockResolvedValueOnce(new Response(newJwt, { status: 200 }))
      .mockResolvedValueOnce(Response.json({ v: 2 }));

    const oldClient = new GarminClient({
      apiKey: "key-v1",
      kv,
      fetchFn: fetchMock,
      nowMs: () => BASE_NOW_MS,
    });
    await oldClient.get("/userprofile-service/userprofile/settings");

    const rotatedClient = new GarminClient({
      apiKey: "key-v2",
      kv,
      fetchFn: fetchMock,
      nowMs: () => BASE_NOW_MS,
    });
    await rotatedClient.get("/userprofile-service/userprofile/settings");

    // Both clients minted tokens (key-v2 did not reuse key-v1's cached token)
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("force-refreshes once and retries once on HTTP 401", async () => {
    const staleJwt = makeFakeJwt(BASE_NOW_SEC + 86_400);
    const freshJwt = makeFakeJwt(BASE_NOW_SEC + 90_000);
    const { kv, store } = makeMemoryKv();

    store.set(GARMIN_TOKEN_KV_KEY, JSON.stringify({ token: staleJwt, exp: BASE_NOW_SEC + 86_400 }));

    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("Unauthorized", { status: 401 }))
      .mockResolvedValueOnce(new Response(freshJwt, { status: 200 }))
      .mockResolvedValueOnce(Response.json({ recovered: true }));

    const client = new GarminClient({
      apiKey: "synthetic-api-key",
      kv,
      fetchFn: fetchMock,
      nowMs: () => BASE_NOW_MS,
    });

    const data = await client.get("/activity-service/activity/12345");
    expect(data).toEqual({ recovered: true });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[2]?.[1]).toEqual({
      method: "GET",
      headers: {
        Authorization: `Bearer ${freshJwt}`,
        Accept: "application/json",
      },
    });
  });

  it("stops after a single 401 retry and formats readable error truncated to 300 chars", async () => {
    const jwt = makeFakeJwt(BASE_NOW_SEC + 86_400);
    const longBody = "x".repeat(450);
    const { kv, store } = makeMemoryKv();
    store.set(GARMIN_TOKEN_KV_KEY, JSON.stringify({ token: jwt, exp: BASE_NOW_SEC + 86_400 }));

    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("stale", { status: 401 }))
      .mockResolvedValueOnce(new Response(jwt, { status: 200 }))
      .mockResolvedValueOnce(new Response(longBody, { status: 401 }));

    const client = new GarminClient({
      apiKey: "synthetic-api-key",
      kv,
      fetchFn: fetchMock,
      nowMs: () => BASE_NOW_MS,
    });

    let caught: unknown;
    try {
      await client.get("/activity-service/activity/999");
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(GarminHttpError);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(formatGarminError(caught)).toBe(
      `Garmin API error 401 on GET /activity-service/activity/999: ${"x".repeat(300)}`,
    );
  });

  it("coalesces concurrent cold-cache requests onto a single token exchange", async () => {
    const jwt = makeFakeJwt(BASE_NOW_SEC + 86_400);
    const { kv } = makeMemoryKv();

    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url.includes("/personal-api-key/token")) {
        return new Response(jwt, { status: 200 });
      }
      return Response.json({ url });
    });

    const client = new GarminClient({
      apiKey: "synthetic-api-key",
      kv,
      fetchFn: fetchMock,
      nowMs: () => BASE_NOW_MS,
    });

    await Promise.all([
      client.get("/sleep-service/sleep/dailySleepSummariesByDate", {
        startDate: "2026-03-01",
        endDate: "2026-03-07",
      }),
      client.get("/hrv-service/hrv/daily/2026-03-01/2026-03-07"),
      client.get("/wellness-service/wellness/bodyBattery/reports/daily", {
        startDate: "2026-03-01",
        endDate: "2026-03-07",
      }),
      client.get("/usersummary-service/stats/stress/daily/2026-03-01/2026-03-07"),
    ]);

    const tokenCalls = fetchMock.mock.calls.filter((call) =>
      String(call[0]).includes("/personal-api-key/token"),
    );
    expect(tokenCalls).toHaveLength(1);
  });

  it("returns null on empty response body and never logs tokens or payloads", async () => {
    const jwt = makeFakeJwt(BASE_NOW_SEC + 86_400);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(jwt, { status: 200 }))
      .mockResolvedValueOnce(new Response("", { status: 200 }));

    const client = new GarminClient({
      apiKey: "synthetic-api-key",
      fetchFn: fetchMock,
      nowMs: () => BASE_NOW_MS,
    });

    const result = await client.get("/sleep-service/sleep/dailySleep", { date: "2026-03-10" });
    expect(result).toBeNull();
    expect(logSpy).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();

    logSpy.mockRestore();
    warnSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it("throws readable GarminError when API key is missing", async () => {
    const client = new GarminClient({ apiKey: "   " });
    await expect(client.get("/userprofile-service/userprofile/settings")).rejects.toThrow(
      /GARMIN_PERSONAL_API_KEY/,
    );
  });
});
