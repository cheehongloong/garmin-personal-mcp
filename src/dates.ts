const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const DEFAULT_TIMEZONE = "UTC";
const DEFAULT_RANGE_DAYS = 7;

export interface DateRange {
  startDate: string;
  endDate: string;
}

export interface ResolveDateRangeOptions {
  days?: number;
  timeZone?: string;
  now?: Date;
}

/**
 * Validates that a string is a real YYYY-MM-DD calendar date (e.g. rejects 2026-02-30).
 */
export function isValidIsoDate(value: string): boolean {
  if (!ISO_DATE_PATTERN.test(value)) {
    return false;
  }
  const [yearStr, monthStr, dayStr] = value.split("-");
  const year = Number(yearStr);
  const month = Number(monthStr);
  const day = Number(dayStr);
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  );
}

/**
 * Normalizes an IANA timezone string, falling back safely to UTC when unset or invalid.
 */
export function resolveTimeZone(timeZone?: string): string {
  const trimmed = timeZone?.trim();
  if (!trimmed) {
    return DEFAULT_TIMEZONE;
  }
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: trimmed });
    return trimmed;
  } catch {
    return DEFAULT_TIMEZONE;
  }
}

/**
 * Computes today's YYYY-MM-DD calendar date in the given IANA timezone.
 * Cloudflare Workers run in UTC, so Intl formatting is required for user-local dates.
 */
export function todayInTimeZone(timeZone?: string, now: Date = new Date()): string {
  const tz = resolveTimeZone(timeZone);
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);

  let year = "";
  let month = "";
  let day = "";
  for (const part of parts) {
    if (part.type === "year") year = part.value;
    if (part.type === "month") month = part.value;
    if (part.type === "day") day = part.value;
  }
  return `${year}-${month}-${day}`;
}

/**
 * Shifts a valid YYYY-MM-DD calendar date by `deltaDays` using pure UTC calendar math
 * (immune to daylight saving transitions).
 */
export function shiftIsoDate(isoDate: string, deltaDays: number): string {
  if (!isValidIsoDate(isoDate)) {
    throw new RangeError(`Invalid ISO date: ${isoDate}`);
  }
  const [yearStr, monthStr, dayStr] = isoDate.split("-");
  const shifted = new Date(
    Date.UTC(Number(yearStr), Number(monthStr) - 1, Number(dayStr) + deltaDays),
  );
  const y = String(shifted.getUTCFullYear()).padStart(4, "0");
  const m = String(shifted.getUTCMonth() + 1).padStart(2, "0");
  const d = String(shifted.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/**
 * Resolves an inclusive [startDate, endDate] range defaulting to the last N days
 * ending today in `timeZone` (inclusive, matching garmin_mcp.py).
 */
export function resolveDateRange(
  startDate: string | undefined,
  endDate: string | undefined,
  options: ResolveDateRangeOptions = {},
): DateRange {
  const days = options.days ?? DEFAULT_RANGE_DAYS;
  const resolvedEnd = endDate ?? todayInTimeZone(options.timeZone, options.now);
  const resolvedStart = startDate ?? shiftIsoDate(resolvedEnd, -(days - 1));
  return { startDate: resolvedStart, endDate: resolvedEnd };
}
