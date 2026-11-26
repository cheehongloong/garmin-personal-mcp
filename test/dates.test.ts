import { describe, expect, it } from "vitest";
import {
  isValidIsoDate,
  resolveDateRange,
  resolveTimeZone,
  shiftIsoDate,
  todayInTimeZone,
} from "../src/dates.js";

describe("dates helpers", () => {
  it("validates ISO calendar dates strictly", () => {
    expect(isValidIsoDate("2026-05-15")).toBe(true);
    expect(isValidIsoDate("2024-02-29")).toBe(true); // leap year
    expect(isValidIsoDate("2026-02-29")).toBe(false); // non-leap year
    expect(isValidIsoDate("2026-02-30")).toBe(false);
    expect(isValidIsoDate("2026-04-31")).toBe(false);
    expect(isValidIsoDate("2026-13-01")).toBe(false);
    expect(isValidIsoDate("2026-00-10")).toBe(false);
    expect(isValidIsoDate("2026-5-1")).toBe(false);
    expect(isValidIsoDate("not-a-date")).toBe(false);
  });

  it("resolves valid IANA timezones and falls back safely to UTC", () => {
    expect(resolveTimeZone(undefined)).toBe("UTC");
    expect(resolveTimeZone("")).toBe("UTC");
    expect(resolveTimeZone("   ")).toBe("UTC");
    expect(resolveTimeZone("Asia/Tokyo")).toBe("Asia/Tokyo");
    expect(resolveTimeZone(" America/New_York ")).toBe("America/New_York");
    expect(resolveTimeZone("Mars/Olympus_Mons")).toBe("UTC");
  });

  it("computes today accurately across timezone day boundaries", () => {
    // 2026-03-10 18:30:00 UTC -> 2026-03-11 in Asia/Tokyo (UTC+9), 2026-03-10 in America/New_York (UTC-4)
    const instant = new Date("2026-03-10T18:30:00Z");
    expect(todayInTimeZone("UTC", instant)).toBe("2026-03-10");
    expect(todayInTimeZone("Asia/Tokyo", instant)).toBe("2026-03-11");
    expect(todayInTimeZone("America/New_York", instant)).toBe("2026-03-10");
  });

  it("shifts dates across month, year, and leap-year boundaries", () => {
    expect(shiftIsoDate("2026-03-01", -1)).toBe("2026-02-28");
    expect(shiftIsoDate("2024-03-01", -1)).toBe("2024-02-29");
    expect(shiftIsoDate("2026-01-03", -6)).toBe("2025-12-28");
    expect(() => shiftIsoDate("2026-02-30", -1)).toThrow(RangeError);
  });

  it("resolves inclusive default 7-day range in the configured timezone", () => {
    const instant = new Date("2026-03-10T18:30:00Z");
    expect(resolveDateRange(undefined, undefined, { timeZone: "UTC", now: instant })).toEqual({
      startDate: "2026-03-04",
      endDate: "2026-03-10",
    });
    expect(
      resolveDateRange(undefined, undefined, { timeZone: "Asia/Tokyo", now: instant }),
    ).toEqual({
      startDate: "2026-03-05",
      endDate: "2026-03-11",
    });
    expect(
      resolveDateRange(undefined, "2026-05-10", { days: 14, timeZone: "UTC", now: instant }),
    ).toEqual({
      startDate: "2026-04-27",
      endDate: "2026-05-10",
    });
    expect(resolveDateRange("2026-05-01", "2026-05-05", { timeZone: "UTC" })).toEqual({
      startDate: "2026-05-01",
      endDate: "2026-05-05",
    });
  });
});
