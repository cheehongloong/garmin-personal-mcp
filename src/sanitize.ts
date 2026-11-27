/**
 * Response trimming, normalization, and PII scrubbing for Garmin Connect Personal API payloads.
 *
 * Goals:
 * 1. Strip personal identifiers (names, owner IDs, user profile PKs, device IDs,
 *    profile image URLs, exact start/end GPS coordinates) before any data reaches an LLM.
 * 2. Trim massive Garmin DTO bloat (null sport-specific fields like dive metrics on runs,
 *    metadata wrappers, and huge per-minute raw epoch arrays) to keep MCP responses fast
 *    and context-friendly.
 * 3. Normalize misleading Garmin defaults:
 *    - Unworn sleep nights (boilerplate sleepNeed with no recorded sleep) -> { date, recorded: false }
 *    - Negative stress sentinels (-1 / -2 meaning "no data") -> null / { date, recorded: false }
 *    - Explicit `units` map and pre-formatted pace strings (e.g. "5:12 /km") on activities
 */

export const ACTIVITY_UNITS = {
  distance: "meters",
  duration: "seconds",
  speed: "m/s",
  pace: "min:sec /km (or /100m for swimming)",
  speedKmh: "km/h (cycling)",
  elevation: "meters",
  heartRate: "bpm",
  runningCadence: "spm",
  cyclingCadence: "rpm",
  strideLength: "cm",
  groundContactTime: "ms",
  verticalOscillation: "cm",
  power: "watts",
  temperature: "C",
  hrTimeInZone: "seconds",
} as const;

const EXACT_STRIP_KEYS = new Set([
  // User / owner PII
  "ownerId",
  "ownerDisplayName",
  "ownerFullName",
  "ownerProfileImageUrl",
  "ownerProfileImageUrlSmall",
  "ownerProfileImageUrlMedium",
  "ownerProfileImageUrlLarge",
  "userProfileId",
  "userProfilePK",
  "userProfilePk",
  "userProfileNumber",
  "userProfileFullName",
  "userFullName",
  "fullName",
  "firstName",
  "lastName",
  "displayName",
  "username",
  "userName",
  "email",
  "emailAddress",
  "birthDate",
  "userRoles",
  "userPro",
  "userInfoDto",
  "uuid",
  // Device / hardware identifiers
  "deviceId",
  "deviceIds",
  "deviceApplicationInstallationId",
  "deviceMetaDataDTO",
  "deviceMetadataDTO",
  "deviceTypePk",
  "serialNumber",
  "unitId",
  "sensors",
  "manufacturer",
  "fileFormat",
  // Exact home-revealing GPS coordinates
  "startLatitude",
  "startLongitude",
  "endLatitude",
  "endLongitude",
  // UI / social / internal metadata bloat
  "privacy",
  "accessControlRuleDTO",
  "timeZoneUnitDTO",
  "metadataDTO",
  "rule",
  "privacyProtected",
  "hasPolyline",
  "hasImages",
  "hasVideo",
  "videoUrl",
  "hasHeatMap",
  "hasSplits",
  "favorite",
  "autoCalcCalories",
  "atpActivity",
  "purposeful",
  "manualActivity",
  "parent",
  "elevationCorrected",
  "decoDive",
  "retro",
  "deviceRemCapable",
  "sleepVersion",
  "includesWellnessData",
  "includesActivityData",
  "includesCalorieConsumedData",
  "source",
  // Descriptor / massive raw per-minute time-series arrays
  "bodyBatteryValueDescriptorDTOList",
  "bodyBatteryValuesArray",
  "stressValueDescriptorDTOList",
  "stressValuesArray",
  "heartRateValueDescriptors",
  "heartRateValues",
  "sleepMovement",
  "sleepLevels",
  "sleepHeartRate",
  "sleepStress",
  "sleepBodyBattery",
  "sleepRestlessMoments",
  "hrvData",
  "wellnessEpochRespirationDataDTOList",
  "wellnessEpochRespirationAveragesList",
  "wellnessEpochSPO2DataDTOList",
]);

const STRIP_KEY_PATTERNS = [
  /profileImageUrl/i,
  /^owner(Id|DisplayName|FullName|Profile)/i,
  /^userProfile(Id|Pk|Number|FullName)/i,
  /^device(Id|Ids|ApplicationInstallationId|MetaDataDTO|MetadataDTO)$/i,
  /DescriptorDTOList$/i,
];

const STRESS_SENTINEL_KEY_PATTERNS = [/stressLevel$/i, /stressDuration$/i, /stressPercentage$/i];

const ACTIVITY_LIST_KEEP_KEYS = [
  "activityId",
  "activityName",
  "startTimeLocal",
  "locationName",
  "distance",
  "duration",
  "movingDuration",
  "elapsedDuration",
  "elevationGain",
  "elevationLoss",
  "averageSpeed",
  "maxSpeed",
  "averageHR",
  "maxHR",
  "averageRunningCadenceInStepsPerMinute",
  "maxRunningCadenceInStepsPerMinute",
  "avgStrideLength",
  "avgGroundContactTime",
  "avgVerticalOscillation",
  "avgVerticalRatio",
  "averageBikingCadenceInRevPerMinute",
  "maxBikingCadenceInRevPerMinute",
  "averageSwolf",
  "averageSwimCadenceInStrokesPerMinute",
  "poolLength",
  "activeLengths",
  "avgPower",
  "maxPower",
  "normPower",
  "calories",
  "aerobicTrainingEffect",
  "anaerobicTrainingEffect",
  "trainingEffectLabel",
  "activityTrainingLoad",
  "vO2MaxValue",
  "lapCount",
  "workoutFeel",
  "workoutRpe",
  "moderateIntensityMinutes",
  "vigorousIntensityMinutes",
  "hrTimeInZone_1",
  "hrTimeInZone_2",
  "hrTimeInZone_3",
  "hrTimeInZone_4",
  "hrTimeInZone_5",
  "minTemperature",
  "maxTemperature",
  "description",
] as const;

const SPLIT_SUMMARY_KEEP_KEYS = [
  "splitType",
  "noOfSplits",
  "duration",
  "distance",
  "averageSpeed",
  "maxSpeed",
  "averageHR",
  "maxHR",
  "averageRunCadence",
  "elevationGain",
  "elevationLoss",
  "totalAscent",
  "totalDescent",
] as const;

const DIVE_ONLY_KEYS = new Set([
  "summarizedDiveInfo",
  "bottomTime",
  "maxDepth",
  "avgDepth",
  "surfaceInterval",
  "diveNumber",
  "waterType",
  "minRespirationRate",
  "maxRespirationRate",
  "avgRespirationRate",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPositiveNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function isNonNegativeNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function shouldStripKey(key: string): boolean {
  if (EXACT_STRIP_KEYS.has(key)) {
    return true;
  }
  return STRIP_KEY_PATTERNS.some((pattern) => pattern.test(key));
}

function isStressSentinelKey(key: string): boolean {
  return STRESS_SENTINEL_KEY_PATTERNS.some((pattern) => pattern.test(key));
}

function isCyclingActivity(activityType?: string): boolean {
  return Boolean(activityType && /(cycl|bik|mtb|gravel)/i.test(activityType));
}

function isSwimmingActivity(activityType?: string): boolean {
  return Boolean(activityType && /swim/i.test(activityType));
}

/**
 * Formats a speed in m/s into a human-readable pace string ("M:SS /km", or "M:SS /100m" for swimming).
 */
export function formatPace(speedMetersPerSec: number, activityType?: string): string | undefined {
  if (!Number.isFinite(speedMetersPerSec) || speedMetersPerSec <= 0) {
    return undefined;
  }
  const isSwim = isSwimmingActivity(activityType);
  const metersPerUnit = isSwim ? 100 : 1000;
  const suffix = isSwim ? "/100m" : "/km";
  const totalSeconds = Math.round(metersPerUnit / speedMetersPerSec);
  const mins = Math.floor(totalSeconds / 60);
  const secs = totalSeconds % 60;
  return `${mins}:${String(secs).padStart(2, "0")} ${suffix}`;
}

function formatSpeedKmh(speedMetersPerSec: number): number | undefined {
  if (!Number.isFinite(speedMetersPerSec) || speedMetersPerSec <= 0) {
    return undefined;
  }
  return Math.round(speedMetersPerSec * 3.6 * 10) / 10;
}

function attachDerivedPaceOrSpeed(target: Record<string, unknown>, activityType?: string): void {
  const avgSpeed = target.averageSpeed;
  const maxSpeed = target.maxSpeed;

  if (isCyclingActivity(activityType)) {
    if (isPositiveNumber(avgSpeed)) {
      const kmh = formatSpeedKmh(avgSpeed);
      if (kmh !== undefined) target.averageSpeedKmh = kmh;
    }
    if (isPositiveNumber(maxSpeed)) {
      const kmh = formatSpeedKmh(maxSpeed);
      if (kmh !== undefined) target.maxSpeedKmh = kmh;
    }
    return;
  }

  if (isPositiveNumber(avgSpeed)) {
    const pace = formatPace(avgSpeed, activityType);
    if (pace) target.averagePace = pace;
  }
  if (isPositiveNumber(maxSpeed)) {
    const pace = formatPace(maxSpeed, activityType);
    if (pace) target.maxPace = pace;
  }
}

/**
 * Recursively converts negative Garmin stress sentinel values (e.g. -1, -2 meaning "no data")
 * to null so LLMs never interpret them as real stress measurements.
 */
export function normalizeStressSentinels(value: unknown): unknown {
  if (value === null || value === undefined) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(normalizeStressSentinels);
  }
  if (!isRecord(value)) {
    return value;
  }
  const out: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (isStressSentinelKey(key) && typeof raw === "number" && raw < 0) {
      out[key] = null;
      continue;
    }
    out[key] = normalizeStressSentinels(raw);
  }
  return out;
}

/**
 * Recursively removes PII, device IDs, profile image URLs, raw per-minute arrays,
 * and null/empty values from any Garmin payload.
 */
export function stripPiiAndNoise(value: unknown, extraStripKeys?: ReadonlySet<string>): unknown {
  if (value === null || value === undefined) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => stripPiiAndNoise(item, extraStripKeys));
  }
  if (!isRecord(value)) {
    return value;
  }

  const out: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (shouldStripKey(key) || extraStripKeys?.has(key)) {
      continue;
    }
    if (raw === null || raw === undefined || raw === "") {
      continue;
    }
    const cleaned = stripPiiAndNoise(raw, extraStripKeys);
    if (cleaned === null || cleaned === undefined || cleaned === "") {
      continue;
    }
    if (isRecord(cleaned) && Object.keys(cleaned).length === 0) {
      continue;
    }
    out[key] = cleaned;
  }
  return out;
}

function extractTypeKey(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim().length > 0) {
    return value;
  }
  if (isRecord(value) && typeof value.typeKey === "string" && value.typeKey.length > 0) {
    return value.typeKey;
  }
  return undefined;
}

function extractDateField(obj: Record<string, unknown>): string | undefined {
  if (typeof obj.calendarDate === "string" && obj.calendarDate.length > 0) {
    return obj.calendarDate;
  }
  if (typeof obj.date === "string" && obj.date.length > 0) {
    return obj.date;
  }
  if (isRecord(obj.dailySleepDTO)) {
    const nested = extractDateField(obj.dailySleepDTO);
    if (nested) return nested;
  }
  if (isRecord(obj.sleepNeed)) {
    const nested = extractDateField(obj.sleepNeed);
    if (nested) return nested;
  }
  return undefined;
}

function shapeActivitySummaryItem(raw: unknown): unknown {
  if (!isRecord(raw)) {
    return stripPiiAndNoise(raw);
  }

  const out: Record<string, unknown> = {};
  const activityType = extractTypeKey(raw.activityType ?? raw.activityTypeDTO);
  if (activityType) {
    out.activityType = activityType;
  }

  for (const key of ACTIVITY_LIST_KEEP_KEYS) {
    const val = raw[key];
    if (val === null || val === undefined || val === "") {
      continue;
    }
    // Omit zero HR zone buckets to save tokens
    if (key.startsWith("hrTimeInZone_") && val === 0) {
      continue;
    }
    out[key] = stripPiiAndNoise(val);
  }

  attachDerivedPaceOrSpeed(out, activityType);

  // Only include dive metrics if this is actually a diving activity
  if (activityType && /div/i.test(activityType)) {
    for (const key of DIVE_ONLY_KEYS) {
      const val = raw[key];
      if (val !== null && val !== undefined && val !== "") {
        out[key] = val;
      }
    }
  }

  return out;
}

export function shapeActivityList(data: unknown): unknown {
  if (data === null || data === undefined) {
    return null;
  }
  if (!Array.isArray(data)) {
    return stripPiiAndNoise(data);
  }
  return {
    units: ACTIVITY_UNITS,
    activities: data.map(shapeActivitySummaryItem),
  };
}

export function shapeActivityDetail(data: unknown): unknown {
  if (!isRecord(data)) {
    return stripPiiAndNoise(data);
  }

  // Standard Garmin /activity-service/activity/{id} payload contains summaryDTO
  if (isRecord(data.summaryDTO) || isRecord(data.activityTypeDTO)) {
    const out: Record<string, unknown> = {
      units: ACTIVITY_UNITS,
    };
    if (data.activityId !== undefined) out.activityId = data.activityId;
    if (typeof data.activityName === "string" && data.activityName.length > 0) {
      out.activityName = data.activityName;
    }
    if (typeof data.description === "string" && data.description.length > 0) {
      out.description = data.description;
    }
    if (typeof data.locationName === "string" && data.locationName.length > 0) {
      out.locationName = data.locationName;
    }

    const activityType = extractTypeKey(data.activityTypeDTO ?? data.activityType);
    if (activityType) {
      out.activityType = activityType;
    }

    const eventType = extractTypeKey(data.eventTypeDTO ?? data.eventType);
    if (eventType && eventType !== "uncategorized") {
      out.eventType = eventType;
    }

    const isDive = Boolean(activityType && /div/i.test(activityType));
    if (isRecord(data.summaryDTO)) {
      const summary = stripPiiAndNoise(
        data.summaryDTO,
        isDive ? undefined : DIVE_ONLY_KEYS,
      ) as Record<string, unknown>;
      attachDerivedPaceOrSpeed(summary, activityType);
      out.summary = summary;
    }

    if (Array.isArray(data.splitSummaries) && data.splitSummaries.length > 0) {
      out.splitSummaries = data.splitSummaries.map((split) => {
        if (!isRecord(split)) return stripPiiAndNoise(split);
        const compactSplit: Record<string, unknown> = {};
        for (const key of SPLIT_SUMMARY_KEEP_KEYS) {
          const val = split[key];
          if (val !== null && val !== undefined && val !== "") {
            compactSplit[key] = val;
          }
        }
        attachDerivedPaceOrSpeed(compactSplit, activityType);
        return compactSplit;
      });
    }

    return out;
  }

  const cleaned = stripPiiAndNoise(data, DIVE_ONLY_KEYS);
  if (isRecord(cleaned) && (cleaned.distance !== undefined || cleaned.averageSpeed !== undefined)) {
    attachDerivedPaceOrSpeed(cleaned, extractTypeKey(cleaned.activityType));
    return { units: ACTIVITY_UNITS, ...cleaned };
  }
  return cleaned;
}

function summarizeNumericSeries(
  series: unknown,
): { highest: number; lowest: number; start: number; end: number; samples: number } | undefined {
  if (!Array.isArray(series)) {
    return undefined;
  }
  const values: number[] = [];
  for (const point of series) {
    if (Array.isArray(point) && typeof point[1] === "number" && Number.isFinite(point[1])) {
      values.push(point[1]);
    }
  }
  const first = values[0];
  const last = values[values.length - 1];
  if (first === undefined || last === undefined) {
    return undefined;
  }
  let highest = first;
  let lowest = first;
  for (const v of values) {
    if (v > highest) highest = v;
    if (v < lowest) lowest = v;
  }
  return {
    highest,
    lowest,
    start: first,
    end: last,
    samples: values.length,
  };
}

export function shapeBodyBattery(data: unknown): unknown {
  if (!Array.isArray(data)) {
    return stripPiiAndNoise(data);
  }
  return data.map((day) => {
    if (!isRecord(day)) {
      return stripPiiAndNoise(day);
    }
    const stats = summarizeNumericSeries(day.bodyBatteryValuesArray);
    const cleaned = stripPiiAndNoise(day) as Record<string, unknown>;
    if (stats) {
      cleaned.summary = stats;
    }
    return cleaned;
  });
}

function summarizeHourlyHeartRate(
  series: unknown,
  timeZone: string,
): Array<{ hour: string; min: number; avg: number; max: number; samples: number }> | undefined {
  if (!Array.isArray(series) || series.length === 0) {
    return undefined;
  }

  const formatter = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    hour: "2-digit",
    hour12: false,
  });

  const buckets = new Map<string, { min: number; max: number; sum: number; count: number }>();
  for (const point of series) {
    if (
      !Array.isArray(point) ||
      typeof point[0] !== "number" ||
      typeof point[1] !== "number" ||
      !Number.isFinite(point[0]) ||
      !Number.isFinite(point[1])
    ) {
      continue;
    }
    const hourNum = formatter.format(new Date(point[0]));
    const hour = `${hourNum === "24" ? "00" : hourNum}:00`;
    const bpm = point[1];
    const existing = buckets.get(hour);
    if (!existing) {
      buckets.set(hour, { min: bpm, max: bpm, sum: bpm, count: 1 });
    } else {
      if (bpm < existing.min) existing.min = bpm;
      if (bpm > existing.max) existing.max = bpm;
      existing.sum += bpm;
      existing.count += 1;
    }
  }

  if (buckets.size === 0) {
    return undefined;
  }

  return [...buckets.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([hour, b]) => ({
      hour,
      min: b.min,
      avg: Math.round(b.sum / b.count),
      max: b.max,
      samples: b.count,
    }));
}

export function shapeHeartRateDay(data: unknown, timeZone: string): unknown {
  if (!isRecord(data)) {
    return stripPiiAndNoise(data);
  }
  const hourly = summarizeHourlyHeartRate(data.heartRateValues, timeZone);
  const cleaned = stripPiiAndNoise(data) as Record<string, unknown>;
  if (hourly) {
    cleaned.hourlyHeartRate = hourly;
  }
  return cleaned;
}

const SLEEP_SIGNAL_KEYS = [
  "sleepTimeSeconds",
  "totalSleepTimeInSeconds",
  "durationInSeconds",
  "deepSleepSeconds",
  "lightSleepSeconds",
  "remSleepSeconds",
  "unmeasurableSleepSeconds",
  "sleepStartTimestampLocal",
  "sleepStartTimestampGMT",
  "sleepEndTimestampLocal",
  "sleepEndTimestampGMT",
  "startTimeInSeconds",
] as const;

function hasRecordedSleep(obj: Record<string, unknown>): boolean {
  const target = isRecord(obj.dailySleepDTO) ? obj.dailySleepDTO : obj;
  for (const key of SLEEP_SIGNAL_KEYS) {
    if (isPositiveNumber(target[key])) {
      return true;
    }
  }
  return false;
}

function isSleepRecordLike(obj: Record<string, unknown>): boolean {
  if (isRecord(obj.dailySleepDTO)) return true;
  return (
    "sleepTimeSeconds" in obj ||
    "totalSleepTimeInSeconds" in obj ||
    "sleepNeed" in obj ||
    "nextSleepNeed" in obj ||
    "sleepScores" in obj ||
    "deepSleepSeconds" in obj ||
    "calendarDate" in obj
  );
}

export function shapeSleepDay(data: unknown, requestedDate?: string): unknown {
  if (data === null || data === undefined) {
    return requestedDate ? { date: requestedDate, recorded: false } : null;
  }
  if (!isRecord(data)) {
    return stripPiiAndNoise(data);
  }
  if (isSleepRecordLike(data) && !hasRecordedSleep(data)) {
    const date = extractDateField(data) ?? requestedDate;
    return date ? { date, recorded: false } : { recorded: false };
  }
  // Remove redundant internal sleep row IDs while keeping all sleep stages, scores, and insights
  return stripPiiAndNoise(data, new Set(["id", "sleepResultType"]));
}

export function shapeSleepRange(data: unknown): unknown {
  if (!Array.isArray(data)) {
    return shapeSleepDay(data);
  }
  return data.map((item) => shapeSleepDay(item));
}

const STRESS_LEVEL_KEYS = [
  "overallStressLevel",
  "avgStressLevel",
  "averageStressLevel",
  "maxStressLevel",
  "minStressLevel",
] as const;

const STRESS_DURATION_KEYS = [
  "restStressDuration",
  "lowStressDuration",
  "mediumStressDuration",
  "highStressDuration",
  "stressDuration",
  "totalStressDuration",
] as const;

function hasRecordedStress(day: Record<string, unknown>): boolean {
  const containers = isRecord(day.values) ? [day.values, day] : [day];
  for (const container of containers) {
    for (const key of STRESS_LEVEL_KEYS) {
      if (isNonNegativeNumber(container[key])) {
        return true;
      }
    }
    for (const key of STRESS_DURATION_KEYS) {
      if (isPositiveNumber(container[key])) {
        return true;
      }
    }
  }
  return false;
}

function isStressRecordLike(obj: Record<string, unknown>): boolean {
  const containers = isRecord(obj.values) ? [obj.values, obj] : [obj];
  return containers.some(
    (c) =>
      "overallStressLevel" in c ||
      "avgStressLevel" in c ||
      "averageStressLevel" in c ||
      "maxStressLevel" in c ||
      "stressDuration" in c ||
      "restStressDuration" in c,
  );
}

export function shapeStress(data: unknown): unknown {
  if (!Array.isArray(data)) {
    return stripPiiAndNoise(normalizeStressSentinels(data));
  }
  return data.map((day) => {
    if (!isRecord(day)) {
      return stripPiiAndNoise(day);
    }
    if (isStressRecordLike(day) && !hasRecordedStress(day)) {
      const date = extractDateField(day);
      return date ? { date, recorded: false } : { recorded: false };
    }
    return stripPiiAndNoise(normalizeStressSentinels(day));
  });
}

export function shapeDailySummaries(data: unknown): unknown {
  return stripPiiAndNoise(normalizeStressSentinels(data));
}

export function shapeProfile(data: unknown): unknown {
  if (!isRecord(data)) {
    return stripPiiAndNoise(data);
  }
  // Strip top-level numeric user/profile ID as well as displayName/fullName/email/birthDate
  return stripPiiAndNoise(data, new Set(["id", "profileId"]));
}
