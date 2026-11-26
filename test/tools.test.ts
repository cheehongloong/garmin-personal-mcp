import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import { describe, expect, it, vi } from "vitest";
import { GarminClient } from "../src/garmin.js";
import { registerGarminTools } from "../src/tools.js";

const FIXED_NOW = new Date("2026-03-10T18:30:00Z"); // 2026-03-11 in Asia/Tokyo

function makeFakeJwt(exp: number): string {
  const encode = (obj: unknown) =>
    btoa(JSON.stringify(obj)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `${encode({ alg: "RS256", typ: "JWT" })}.${encode({ sub: "synthetic", exp })}.sig`;
}

function makeTestHarness(
  routeResponder: (url: URL, init?: RequestInit) => Response | Promise<Response>,
  timeZone = "Asia/Tokyo",
) {
  const jwt = makeFakeJwt(Math.floor(FIXED_NOW.getTime() / 1000) + 86_400);
  const requests: URL[] = [];

  const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
    const url = new URL(String(input));
    requests.push(url);
    if (url.pathname.endsWith("/personal-api-key/token")) {
      return new Response(jwt, { status: 200 });
    }
    return routeResponder(url, init);
  });

  const client = new GarminClient({
    apiKey: "synthetic-api-key",
    fetchFn: fetchMock,
    nowMs: () => FIXED_NOW.getTime(),
  });

  const handler = createMcpHandler(
    () => {
      const server = new McpServer({ name: "garmin-test", version: "0.1.0" });
      registerGarminTools(server, {
        client,
        timeZone,
        now: () => FIXED_NOW,
      });
      return server;
    },
    { route: "/mcp", allowedOriginHostnames: "*" },
  );

  async function rpc(method: string, params: Record<string, unknown> = {}) {
    const res = await handler.fetch(
      new Request("http://localhost:8787/mcp", {
        method: "POST",
        headers: {
          Host: "localhost:8787",
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      }),
    );
    const raw = await res.text();
    const contentType = res.headers.get("content-type") ?? "";
    if (contentType.includes("text/event-stream")) {
      const dataLine = raw
        .split("\n")
        .find((line) => line.startsWith("data:"))
        ?.slice(5)
        .trim();
      return JSON.parse(dataLine ?? "{}") as {
        result?: {
          tools?: Array<{ name: string; annotations?: { readOnlyHint?: boolean } }>;
          content?: Array<{ type: string; text: string }>;
          isError?: boolean;
        };
        error?: { code: number; message: string };
      };
    }
    return JSON.parse(raw) as {
      result?: {
        tools?: Array<{ name: string; annotations?: { readOnlyHint?: boolean } }>;
        content?: Array<{ type: string; text: string }>;
        isError?: boolean;
      };
      error?: { code: number; message: string };
    };
  }

  return { rpc, requests, fetchMock };
}

describe("Garmin MCP tools", () => {
  it("registers all 14 read-only Garmin tools", async () => {
    const { rpc } = makeTestHarness(() => Response.json({}));
    const response = await rpc("tools/list");
    const tools = response.result?.tools ?? [];
    const names = tools.map((t) => t.name).sort();

    expect(names).toEqual(
      [
        "get_activity",
        "get_activity_splits",
        "get_body_battery",
        "get_daily_summaries",
        "get_fitness_age",
        "get_heart_rate_day",
        "get_heart_rate_zones",
        "get_hrv",
        "get_profile",
        "get_sleep",
        "get_sleep_range",
        "get_stress",
        "list_activities",
        "recovery_snapshot",
      ].sort(),
    );

    for (const tool of tools) {
      expect(tool.annotations?.readOnlyHint).toBe(true);
    }
  });

  it("maps every single tool to the exact Garmin Personal API path and query params", async () => {
    const { rpc, requests } = makeTestHarness((url) =>
      Response.json({ path: url.pathname, search: url.search }),
    );

    const callTool = async (name: string, args: Record<string, unknown> = {}) => {
      const res = await rpc("tools/call", { name, arguments: args });
      expect(res.result?.isError).toBeFalsy();
      const text = res.result?.content?.[0]?.text ?? "";
      // Compact JSON check (no pretty-printed newlines)
      expect(text).not.toContain("\n");
      return JSON.parse(text) as { path: string; search: string };
    };

    expect(
      await callTool("list_activities", {
        limit: 10,
        start: 5,
        start_date: "2026-03-01",
        end_date: "2026-03-10",
        activity_type: "running",
        activity_sub_type: "street_running",
      }),
    ).toEqual({
      path: "/activitylist-service/activities/search/activities",
      search:
        "?start=5&limit=10&startDate=2026-03-01&endDate=2026-03-10&activityType=running&activitySubType=street_running",
    });

    expect(await callTool("get_activity", { activity_id: 123456 })).toEqual({
      path: "/activity-service/activity/123456",
      search: "",
    });

    expect(await callTool("get_activity_splits", { activity_id: 123456 })).toEqual({
      path: "/activity-service/activity/123456/workouts",
      search: "",
    });

    // Asia/Tokyo at 2026-03-10T18:30:00Z is 2026-03-11 -> default 7-day range is 2026-03-05..2026-03-11
    expect(await callTool("get_sleep")).toEqual({
      path: "/sleep-service/sleep/dailySleep",
      search: "?date=2026-03-11",
    });

    expect(await callTool("get_sleep_range")).toEqual({
      path: "/sleep-service/sleep/dailySleepSummariesByDate",
      search: "?startDate=2026-03-05&endDate=2026-03-11",
    });

    expect(await callTool("get_hrv")).toEqual({
      path: "/hrv-service/hrv/daily/2026-03-05/2026-03-11",
      search: "",
    });

    expect(await callTool("get_body_battery")).toEqual({
      path: "/wellness-service/wellness/bodyBattery/reports/daily",
      search: "?startDate=2026-03-05&endDate=2026-03-11",
    });

    expect(await callTool("get_stress")).toEqual({
      path: "/usersummary-service/stats/stress/daily/2026-03-05/2026-03-11",
      search: "",
    });

    expect(await callTool("get_daily_summaries")).toEqual({
      path: "/usersummary-service/v2/dailysummaries",
      search: "?startDate=2026-03-05&endDate=2026-03-11",
    });

    expect(await callTool("get_heart_rate_day")).toEqual({
      path: "/wellness-service/wellness/dailyHeartRate",
      search: "?date=2026-03-11",
    });

    expect(await callTool("get_heart_rate_zones")).toEqual({
      path: "/biometric-service/heartRateZones/v2",
      search: "",
    });

    expect(await callTool("get_fitness_age")).toEqual({
      path: "/fitnessage-service/fitnessage/v2/2026-03-11",
      search: "",
    });

    expect(await callTool("get_profile")).toEqual({
      path: "/userprofile-service/userprofile/settings",
      search: "",
    });

    expect(requests.length).toBeGreaterThanOrEqual(14);
  });

  it("validates dates, limits, activity IDs, and date ordering cleanly", async () => {
    const { rpc } = makeTestHarness(() => Response.json({}));

    const badDate = await rpc("tools/call", {
      name: "get_sleep",
      arguments: { calendar_date: "2026-02-30" },
    });
    expect(badDate.error || badDate.result?.isError).toBeTruthy();

    const badLimit = await rpc("tools/call", {
      name: "list_activities",
      arguments: { limit: 101 },
    });
    expect(badLimit.error || badLimit.result?.isError).toBeTruthy();

    const badActivityId = await rpc("tools/call", {
      name: "get_activity",
      arguments: { activity_id: -1 },
    });
    expect(badActivityId.error || badActivityId.result?.isError).toBeTruthy();

    const reversedRange = await rpc("tools/call", {
      name: "get_hrv",
      arguments: { start_date: "2026-03-10", end_date: "2026-03-01" },
    });
    expect(reversedRange.result?.isError).toBe(true);
    expect(reversedRange.result?.content?.[0]?.text).toContain("cannot be after");
  });

  it("returns readable error text on Garmin HTTP failures without throwing raw", async () => {
    const { rpc } = makeTestHarness(() => new Response("Activity not found", { status: 404 }));

    const res = await rpc("tools/call", {
      name: "get_activity",
      arguments: { activity_id: 98765 },
    });

    expect(res.result?.isError).toBe(true);
    expect(res.result?.content?.[0]?.text).toBe(
      "Garmin API error 404 on GET /activity-service/activity/98765: Activity not found",
    );
  });

  it("runs recovery_snapshot in parallel and isolates partial section failures", async () => {
    const { rpc, fetchMock } = makeTestHarness((url) => {
      if (url.pathname.includes("/hrv-service/")) {
        return new Response("HRV unavailable", { status: 503 });
      }
      return Response.json({ ok: url.pathname });
    });

    const res = await rpc("tools/call", {
      name: "recovery_snapshot",
      arguments: { days: 5 },
    });

    expect(res.result?.isError).toBeFalsy();
    const payload = JSON.parse(res.result?.content?.[0]?.text ?? "{}") as Record<string, unknown>;
    expect(payload).toEqual({
      range: ["2026-03-07", "2026-03-11"],
      sleep: { ok: "/sleep-service/sleep/dailySleepSummariesByDate" },
      hrv: "Garmin API error 503 on GET /hrv-service/hrv/daily/2026-03-07/2026-03-11: HRV unavailable",
      body_battery: { ok: "/wellness-service/wellness/bodyBattery/reports/daily" },
      stress: { ok: "/usersummary-service/stats/stress/daily/2026-03-07/2026-03-11" },
    });

    // Cold cache + 4 parallel calls coalesced into 1 token call + 4 API calls
    const tokenCalls = fetchMock.mock.calls.filter((c) =>
      String(c[0]).includes("/personal-api-key/token"),
    );
    expect(tokenCalls).toHaveLength(1);
  });
});
