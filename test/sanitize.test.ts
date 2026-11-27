import { describe, expect, it } from "vitest";
import {
  shapeActivityDetail,
  shapeActivityList,
  shapeBodyBattery,
  shapeHeartRateDay,
  shapeProfile,
  shapeSleepDay,
  stripPiiAndNoise,
} from "../src/sanitize.js";

describe("response trimming and PII scrubbing", () => {
  it("strips owner identity, profile image URLs, device IDs, GPS coords, and dive bloat from list_activities", () => {
    const bloatedRun = {
      activityId: 1001,
      activityName: "Morning Run",
      startTimeLocal: "2026-03-10 06:30:00",
      activityType: {
        typeId: 1,
        typeKey: "running",
        parentTypeId: 17,
        isHidden: false,
        restricted: false,
        trimmable: true,
      },
      distance: 10000,
      duration: 2850,
      movingDuration: 2840,
      averageSpeed: 3.51,
      averageHR: 152,
      maxHR: 171,
      averageRunningCadenceInStepsPerMinute: 176,
      aerobicTrainingEffect: 3.4,
      activityTrainingLoad: 112,
      hrTimeInZone_1: 0,
      hrTimeInZone_2: 420,
      hrTimeInZone_3: 1800,
      hrTimeInZone_4: 630,
      hrTimeInZone_5: 0,
      // PII & device identifiers
      ownerId: 99887766,
      ownerDisplayName: "synthetic-uuid-1234",
      ownerFullName: "Jane Runner",
      ownerProfileImageUrlSmall:
        "https://s3.amazonaws.com/garmin-connect-prod/profile_images/s.png",
      ownerProfileImageUrlMedium:
        "https://s3.amazonaws.com/garmin-connect-prod/profile_images/m.png",
      ownerProfileImageUrlLarge:
        "https://s3.amazonaws.com/garmin-connect-prod/profile_images/l.png",
      deviceId: 3456789012,
      startLatitude: 3.139003,
      startLongitude: 101.686855,
      endLatitude: 3.139011,
      endLongitude: 101.686842,
      // Dive & irrelevant sport bloat
      bottomTime: null,
      maxDepth: null,
      avgDepth: null,
      surfaceInterval: null,
      diveNumber: null,
      decoDive: false,
      waterType: null,
      privacy: { typeId: 2, typeKey: "private" },
      hasPolyline: true,
      hasImages: false,
      hasVideo: false,
      favorite: false,
      autoCalcCalories: false,
    };

    const rawSize = JSON.stringify([bloatedRun]).length;
    const trimmed = shapeActivityList([bloatedRun]) as Array<Record<string, unknown>>;
    const trimmedJson = JSON.stringify(trimmed);

    expect(trimmed).toHaveLength(1);
    const item = trimmed[0];
    expect(item).toBeDefined();
    expect(item?.activityId).toBe(1001);
    expect(item?.activityType).toBe("running");
    expect(item?.distance).toBe(10000);
    expect(item?.averageHR).toBe(152);
    expect(item?.hrTimeInZone_2).toBe(420);
    expect(item?.hrTimeInZone_1).toBeUndefined(); // zero bucket omitted
    expect(item?.hrTimeInZone_5).toBeUndefined();

    // Verify PII & bloat completely stripped
    for (const forbidden of [
      "ownerId",
      "ownerDisplayName",
      "ownerFullName",
      "ownerProfileImageUrl",
      "Jane Runner",
      "deviceId",
      "startLatitude",
      "endLongitude",
      "bottomTime",
      "maxDepth",
      "decoDive",
      "privacy",
    ]) {
      expect(trimmedJson).not.toContain(forbidden);
    }

    // Significant payload size reduction
    expect(trimmedJson.length).toBeLessThan(rawSize * 0.5);
  });

  it("preserves dive metrics on actual diving activities while still stripping PII", () => {
    const diveActivity = {
      activityId: 2002,
      activityName: "Reef Dive",
      activityType: { typeKey: "single_gas_diving" },
      duration: 2400,
      maxDepth: 18.4,
      bottomTime: 2100,
      ownerFullName: "Jane Diver",
      deviceId: 11223344,
    };

    const trimmed = shapeActivityList([diveActivity]) as Array<Record<string, unknown>>;
    expect(trimmed[0]?.activityType).toBe("single_gas_diving");
    expect(trimmed[0]?.maxDepth).toBe(18.4);
    expect(trimmed[0]?.bottomTime).toBe(2100);
    expect(JSON.stringify(trimmed)).not.toContain("Jane Diver");
    expect(JSON.stringify(trimmed)).not.toContain("deviceId");
  });

  it("trims get_activity detail responses and strips metadataDTO/userInfoDto/deviceIds", () => {
    const rawDetail = {
      activityId: 1001,
      activityName: "Tempo Run",
      locationName: "City Park",
      activityTypeDTO: { typeId: 1, typeKey: "running", parentTypeId: 17 },
      eventTypeDTO: { typeId: 9, typeKey: "uncategorized" },
      accessControlRuleDTO: { typeId: 2, typeKey: "private" },
      timeZoneUnitDTO: { unitId: 124, timeZone: "UTC" },
      metadataDTO: {
        deviceApplicationInstallationId: 987654321,
        deviceMetaDataDTO: { deviceId: "3456789012", deviceTypePk: 37086 },
        userInfoDto: {
          userProfilePk: 99887766,
          displayname: "secret-handle",
          fullname: "Jane Runner",
          profileImageUrlLarge: "https://example.com/avatar.jpg",
        },
        sensors: [{ sku: "006-B1234", serialNumber: 555555 }],
      },
      summaryDTO: {
        startTimeLocal: "2026-03-10T06:30:00.0",
        distance: 10000,
        duration: 2700,
        averageSpeed: 3.7,
        averageHR: 162,
        maxHR: 178,
        trainingEffect: 3.8,
        startLatitude: 3.139,
        startLongitude: 101.686,
        bottomTime: null,
        maxDepth: null,
      },
      splitSummaries: [
        {
          splitType: "RWD_RUN",
          noOfSplits: 1,
          duration: 2700,
          distance: 10000,
          averageSpeed: 3.7,
          averageHR: 162,
          deviceId: 3456789012,
        },
      ],
    };

    const shaped = shapeActivityDetail(rawDetail) as Record<string, unknown>;
    const text = JSON.stringify(shaped);

    expect(shaped.activityId).toBe(1001);
    expect(shaped.activityType).toBe("running");
    expect(shaped.eventType).toBeUndefined(); // uncategorized omitted
    expect((shaped.summary as Record<string, unknown>).averageHR).toBe(162);
    expect(shaped.splitSummaries).toEqual([
      {
        splitType: "RWD_RUN",
        noOfSplits: 1,
        duration: 2700,
        distance: 10000,
        averageSpeed: 3.7,
        averageHR: 162,
      },
    ]);

    for (const forbidden of [
      "metadataDTO",
      "userInfoDto",
      "deviceApplicationInstallationId",
      "deviceId",
      "Jane Runner",
      "serialNumber",
      "startLatitude",
      "accessControlRuleDTO",
      "bottomTime",
    ]) {
      expect(text).not.toContain(forbidden);
    }
  });

  it("summarizes Body Battery arrays into daily stats and removes huge raw series", () => {
    const rawPoints = Array.from({ length: 300 }, (_, i) => [
      1773100800000 + i * 180_000,
      20 + (i % 70),
    ]);
    const raw = [
      {
        date: "2026-03-10",
        userProfilePK: 99887766,
        charged: 64,
        drained: 48,
        bodyBatteryValueDescriptorDTOList: [
          { bodyBatteryValueDescriptorIndex: 0, bodyBatteryValueDescriptorKey: "timestamp" },
        ],
        bodyBatteryValuesArray: rawPoints,
      },
    ];

    const shaped = shapeBodyBattery(raw) as Array<Record<string, unknown>>;
    const text = JSON.stringify(shaped);

    expect(shaped[0]).toEqual({
      date: "2026-03-10",
      charged: 64,
      drained: 48,
      summary: {
        highest: 89,
        lowest: 20,
        start: 20,
        end: 39,
        samples: 300,
      },
    });
    expect(text).not.toContain("userProfilePK");
    expect(text).not.toContain("bodyBatteryValuesArray");
    expect(text.length).toBeLessThan(JSON.stringify(raw).length * 0.1);
  });

  it("downsamples daily heart rate values into compact hourly buckets and strips userProfilePK", () => {
    const raw = {
      userProfilePK: 99887766,
      calendarDate: "2026-03-10",
      restingHeartRate: 52,
      minHeartRate: 48,
      maxHeartRate: 165,
      heartRateValueDescriptors: [{ key: "timestamp" }, { key: "heartrate" }],
      heartRateValues: [
        [Date.UTC(2026, 2, 10, 6, 0), 50],
        [Date.UTC(2026, 2, 10, 6, 30), 60],
        [Date.UTC(2026, 2, 10, 7, 15), 140],
        [Date.UTC(2026, 2, 10, 7, 45), 160],
        [Date.UTC(2026, 2, 10, 7, 50), null],
      ],
    };

    const shaped = shapeHeartRateDay(raw, "UTC") as Record<string, unknown>;
    expect(shaped).toEqual({
      calendarDate: "2026-03-10",
      restingHeartRate: 52,
      minHeartRate: 48,
      maxHeartRate: 165,
      hourlyHeartRate: [
        { hour: "06:00", min: 50, avg: 55, max: 60, samples: 2 },
        { hour: "07:00", min: 140, avg: 150, max: 160, samples: 2 },
      ],
    });
    expect(JSON.stringify(shaped)).not.toContain("userProfilePK");
    expect(JSON.stringify(shaped)).not.toContain("heartRateValues");
  });

  it("strips massive per-minute sleep epoch arrays while retaining sleep stages and scores", () => {
    const raw = {
      dailySleepDTO: {
        id: 12345,
        userProfilePK: 99887766,
        calendarDate: "2026-03-10",
        sleepTimeSeconds: 27900,
        deepSleepSeconds: 5400,
        lightSleepSeconds: 16200,
        remSleepSeconds: 6300,
        awakeSleepSeconds: 900,
        sleepScores: { overall: { value: 84, qualifierKey: "GOOD" } },
        retro: false,
        deviceRemCapable: true,
      },
      restingHeartRate: 51,
      avgOvernightHrv: 62,
      sleepMovement: Array.from({ length: 200 }, (_, i) => ({ startGMT: i, activityLevel: 0.1 })),
      sleepLevels: Array.from({ length: 100 }, (_, i) => ({ startGMT: i, activityLevel: 1 })),
      wellnessEpochRespirationDataDTOList: [{ startTimeGMT: 1, respirationValue: 13 }],
    };

    const shaped = shapeSleepDay(raw) as Record<string, unknown>;
    const text = JSON.stringify(shaped);
    expect(shaped).toEqual({
      dailySleepDTO: {
        calendarDate: "2026-03-10",
        sleepTimeSeconds: 27900,
        deepSleepSeconds: 5400,
        lightSleepSeconds: 16200,
        remSleepSeconds: 6300,
        awakeSleepSeconds: 900,
        sleepScores: { overall: { value: 84, qualifierKey: "GOOD" } },
      },
      restingHeartRate: 51,
      avgOvernightHrv: 62,
    });
    expect(text).not.toContain("userProfilePK");
    expect(text).not.toContain("sleepMovement");
    expect(text).not.toContain("sleepLevels");
  });

  it("strips personal identifiers from get_profile while preserving unit and schedule settings", () => {
    const rawProfile = {
      id: 99887766,
      displayName: "Jane Runner",
      fullName: "Jane Runner",
      email: "jane@example.com",
      birthDate: "1990-01-01",
      measurementSystem: "metric",
      firstDayOfWeek: { dayName: "monday" },
      timeFormat: { formatKey: "time_twenty_four_hr" },
      heartRateFormat: { formatKey: "bpm" },
      availableTrainingDays: ["MONDAY", "WEDNESDAY", "SATURDAY"],
    };

    const shaped = shapeProfile(rawProfile);
    expect(shaped).toEqual({
      measurementSystem: "metric",
      firstDayOfWeek: { dayName: "monday" },
      timeFormat: { formatKey: "time_twenty_four_hr" },
      heartRateFormat: { formatKey: "bpm" },
      availableTrainingDays: ["MONDAY", "WEDNESDAY", "SATURDAY"],
    });
  });

  it("handles null and primitive inputs gracefully", () => {
    expect(stripPiiAndNoise(null)).toBeNull();
    expect(shapeActivityList(null)).toBeNull();
    expect(shapeActivityDetail(null)).toBeNull();
    expect(shapeBodyBattery(null)).toBeNull();
    expect(shapeHeartRateDay(null, "UTC")).toBeNull();
    expect(shapeSleepDay(null)).toBeNull();
    expect(shapeProfile(null)).toBeNull();
  });
});
