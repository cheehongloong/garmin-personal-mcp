import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { isValidIsoDate, resolveDateRange, resolveTimeZone, todayInTimeZone } from "./dates.js";
import { formatGarminError, type GarminClient } from "./garmin.js";

const READ_ONLY_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} as const;

const isoDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Date must be in YYYY-MM-DD format")
  .refine(isValidIsoDate, "Invalid calendar date");

const activityIdSchema = z
  .number()
  .int("activity_id must be an integer")
  .positive("activity_id must be a positive integer");

const dateRangeInputSchema = z.object({
  start_date: isoDateSchema
    .optional()
    .describe("Start date (YYYY-MM-DD, inclusive). Defaults to 6 days before end_date."),
  end_date: isoDateSchema
    .optional()
    .describe("End date (YYYY-MM-DD, inclusive). Defaults to today in the configured timezone."),
});

const singleDateInputSchema = z.object({
  calendar_date: isoDateSchema
    .optional()
    .describe("Calendar date (YYYY-MM-DD). Defaults to today in the configured timezone."),
});

const activityIdInputSchema = z.object({
  activity_id: activityIdSchema.describe("Numeric Garmin activity ID."),
});

const emptyInputSchema = z.object({});

export interface RegisterGarminToolsOptions {
  client: GarminClient;
  timeZone?: string;
  now?: () => Date;
}

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
};

function okJson(data: unknown): ToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(data) }],
  };
}

function errorText(message: string): ToolResult {
  return {
    content: [{ type: "text", text: message }],
    isError: true,
  };
}

async function runGarminCall(fn: () => Promise<unknown>): Promise<ToolResult> {
  try {
    const data = await fn();
    return okJson(data);
  } catch (error) {
    return errorText(formatGarminError(error));
  }
}

function validateRangeOrder(startDate: string, endDate: string): string | null {
  if (startDate > endDate) {
    return `Invalid date range: start_date (${startDate}) cannot be after end_date (${endDate}).`;
  }
  return null;
}

export function registerGarminTools(server: McpServer, options: RegisterGarminToolsOptions): void {
  const { client } = options;
  const tz = resolveTimeZone(options.timeZone);
  const getNow = options.now ?? (() => new Date());

  const getToday = () => todayInTimeZone(tz, getNow());
  const getRange = (startDate?: string, endDate?: string, days = 7) =>
    resolveDateRange(startDate, endDate, { days, timeZone: tz, now: getNow() });

  // ---------- Activities ----------

  server.registerTool(
    "list_activities",
    {
      description:
        "List Garmin Connect activities, newest first. Dates are YYYY-MM-DD. Optional filters include activity_type (e.g. 'running') and activity_sub_type.",
      inputSchema: z.object({
        limit: z
          .number()
          .int()
          .min(1)
          .max(100)
          .default(20)
          .describe("Maximum number of activities to return (1-100, default 20)."),
        start: z.number().int().min(0).default(0).describe("Pagination offset (default 0)."),
        start_date: isoDateSchema
          .optional()
          .describe("Optional earliest activity date (YYYY-MM-DD)."),
        end_date: isoDateSchema.optional().describe("Optional latest activity date (YYYY-MM-DD)."),
        activity_type: z
          .string()
          .trim()
          .min(1)
          .optional()
          .describe("Optional Garmin activity type key, e.g. 'running', 'cycling'."),
        activity_sub_type: z
          .string()
          .trim()
          .min(1)
          .optional()
          .describe("Optional Garmin activity sub-type key."),
      }),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ limit, start, start_date, end_date, activity_type, activity_sub_type }) => {
      if (start_date && end_date) {
        const rangeError = validateRangeOrder(start_date, end_date);
        if (rangeError) return errorText(rangeError);
      }
      return runGarminCall(() =>
        client.get("/activitylist-service/activities/search/activities", {
          start,
          limit,
          startDate: start_date,
          endDate: end_date,
          activityType: activity_type,
          activitySubType: activity_sub_type,
        }),
      );
    },
  );

  server.registerTool(
    "get_activity",
    {
      description:
        "Full summary of one Garmin activity: distance, time, pace, heart rate, cadence, training effect, etc.",
      inputSchema: activityIdInputSchema,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ activity_id }) =>
      runGarminCall(() => client.get(`/activity-service/activity/${activity_id}`)),
  );

  server.registerTool(
    "get_activity_splits",
    {
      description: "Laps/splits and structured workout steps for one Garmin activity.",
      inputSchema: activityIdInputSchema,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ activity_id }) =>
      runGarminCall(() => client.get(`/activity-service/activity/${activity_id}/workouts`)),
  );

  server.registerTool(
    "get_activity_weather",
    {
      description:
        "Weather recorded for one Garmin activity. May not be exposed by the Garmin Personal API — returns a readable error message if rejected.",
      inputSchema: activityIdInputSchema,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ activity_id }) =>
      runGarminCall(() => client.get(`/activity-service/activity/${activity_id}/weather`)),
  );

  // ---------- Recovery & health ----------

  server.registerTool(
    "get_sleep",
    {
      description:
        "Detailed sleep for one night (stages, score, duration). Defaults to today in the configured timezone.",
      inputSchema: singleDateInputSchema,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ calendar_date }) =>
      runGarminCall(() =>
        client.get("/sleep-service/sleep/dailySleep", {
          date: calendar_date ?? getToday(),
        }),
      ),
  );

  server.registerTool(
    "get_sleep_range",
    {
      description:
        "Daily sleep summaries for a date range (default last 7 days ending today in the configured timezone).",
      inputSchema: dateRangeInputSchema,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ start_date, end_date }) => {
      const { startDate, endDate } = getRange(start_date, end_date);
      const rangeError = validateRangeOrder(startDate, endDate);
      if (rangeError) return errorText(rangeError);
      return runGarminCall(() =>
        client.get("/sleep-service/sleep/dailySleepSummariesByDate", {
          startDate,
          endDate,
        }),
      );
    },
  );

  server.registerTool(
    "get_hrv",
    {
      description:
        "Daily HRV summaries for a date range (default last 7 days ending today in the configured timezone).",
      inputSchema: dateRangeInputSchema,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ start_date, end_date }) => {
      const { startDate, endDate } = getRange(start_date, end_date);
      const rangeError = validateRangeOrder(startDate, endDate);
      if (rangeError) return errorText(rangeError);
      return runGarminCall(() => client.get(`/hrv-service/hrv/daily/${startDate}/${endDate}`));
    },
  );

  server.registerTool(
    "get_body_battery",
    {
      description:
        "Daily Body Battery reports for a date range (default last 7 days ending today in the configured timezone).",
      inputSchema: dateRangeInputSchema,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ start_date, end_date }) => {
      const { startDate, endDate } = getRange(start_date, end_date);
      const rangeError = validateRangeOrder(startDate, endDate);
      if (rangeError) return errorText(rangeError);
      return runGarminCall(() =>
        client.get("/wellness-service/wellness/bodyBattery/reports/daily", {
          startDate,
          endDate,
        }),
      );
    },
  );

  server.registerTool(
    "get_stress",
    {
      description:
        "Daily stress stats for a date range (default last 7 days ending today in the configured timezone).",
      inputSchema: dateRangeInputSchema,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ start_date, end_date }) => {
      const { startDate, endDate } = getRange(start_date, end_date);
      const rangeError = validateRangeOrder(startDate, endDate);
      if (rangeError) return errorText(rangeError);
      return runGarminCall(() =>
        client.get(`/usersummary-service/stats/stress/daily/${startDate}/${endDate}`),
      );
    },
  );

  server.registerTool(
    "get_daily_summaries",
    {
      description:
        "Daily summaries (steps, calories, resting HR, intensity minutes) for a date range (default last 7 days).",
      inputSchema: dateRangeInputSchema,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ start_date, end_date }) => {
      const { startDate, endDate } = getRange(start_date, end_date);
      const rangeError = validateRangeOrder(startDate, endDate);
      if (rangeError) return errorText(rangeError);
      return runGarminCall(() =>
        client.get("/usersummary-service/v2/dailysummaries", {
          startDate,
          endDate,
        }),
      );
    },
  );

  server.registerTool(
    "get_heart_rate_day",
    {
      description:
        "All-day heart rate for one date, including resting HR. Defaults to today in the configured timezone.",
      inputSchema: singleDateInputSchema,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ calendar_date }) =>
      runGarminCall(() =>
        client.get("/wellness-service/wellness/dailyHeartRate", {
          date: calendar_date ?? getToday(),
        }),
      ),
  );

  server.registerTool(
    "get_heart_rate_zones",
    {
      description: "Your configured Garmin heart rate zones.",
      inputSchema: emptyInputSchema,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async () => runGarminCall(() => client.get("/biometric-service/heartRateZones/v2")),
  );

  server.registerTool(
    "get_fitness_age",
    {
      description: "Garmin fitness age for one date. Defaults to today in the configured timezone.",
      inputSchema: singleDateInputSchema,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ calendar_date }) =>
      runGarminCall(() =>
        client.get(`/fitnessage-service/fitnessage/v2/${calendar_date ?? getToday()}`),
      ),
  );

  server.registerTool(
    "get_profile",
    {
      description: "Garmin profile settings (units, sleep times, etc.).",
      inputSchema: emptyInputSchema,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async () => runGarminCall(() => client.get("/userprofile-service/userprofile/settings")),
  );

  server.registerTool(
    "recovery_snapshot",
    {
      description:
        "One call for 'should I train hard today?': fetches sleep summaries, HRV, Body Battery, and stress in parallel for the last N days (default 7). Each section returns data or an error string.",
      inputSchema: z.object({
        days: z
          .number()
          .int()
          .min(1)
          .max(90)
          .default(7)
          .describe("Number of days ending today to include (1-90, default 7)."),
      }),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ days }) => {
      const { startDate, endDate } = getRange(undefined, undefined, days);
      const fetchSection = async (fn: () => Promise<unknown>): Promise<unknown> => {
        try {
          return await fn();
        } catch (error) {
          return formatGarminError(error);
        }
      };

      const [sleep, hrv, bodyBattery, stress] = await Promise.all([
        fetchSection(() =>
          client.get("/sleep-service/sleep/dailySleepSummariesByDate", {
            startDate,
            endDate,
          }),
        ),
        fetchSection(() => client.get(`/hrv-service/hrv/daily/${startDate}/${endDate}`)),
        fetchSection(() =>
          client.get("/wellness-service/wellness/bodyBattery/reports/daily", {
            startDate,
            endDate,
          }),
        ),
        fetchSection(() =>
          client.get(`/usersummary-service/stats/stress/daily/${startDate}/${endDate}`),
        ),
      ]);

      return okJson({
        range: [startDate, endDate],
        sleep,
        hrv,
        body_battery: bodyBattery,
        stress,
      });
    },
  );
}
