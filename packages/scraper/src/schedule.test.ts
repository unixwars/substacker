import { describe, expect, it } from "vitest";
import {
  HEALTH_MAX_AGE_MS,
  MAX_TIMER_MS,
  RETRY_DELAYS_MS,
  healthStatus,
  nextChunkMs,
  nextRunTime,
  parseJitterMinutes,
  parseRetryDelays,
  parseSchedule,
} from "./schedule.js";

const at = (iso: string) => Date.parse(iso);
const never = () => 0;
const almostOne = () => 0.999999999;

describe("parseSchedule", () => {
  it("defaults to 04:17", () => {
    expect(parseSchedule(undefined)).toEqual({ hour: 4, minute: 17 });
    expect(parseSchedule("")).toEqual({ hour: 4, minute: 17 });
  });
  it("reads HH:MM and H:MM", () => {
    expect(parseSchedule("23:59")).toEqual({ hour: 23, minute: 59 });
    expect(parseSchedule(" 0:05 ")).toEqual({ hour: 0, minute: 5 });
  });
  it.each(["24:00", "12:60", "1217", "12:5", "ab:cd", "-1:00", "12:00:00", "4pm"])("rejects %j", (v) => {
    expect(() => parseSchedule(v)).toThrow(/SUBSTACKER_SCHEDULE_UTC/);
  });
});

describe("parseJitterMinutes", () => {
  it("defaults to 20 and accepts 0 to 120", () => {
    expect(parseJitterMinutes(undefined)).toBe(20);
    expect(parseJitterMinutes("0")).toBe(0);
    expect(parseJitterMinutes("120")).toBe(120);
    expect(parseJitterMinutes("7.5")).toBe(7.5);
  });
  it.each(["-1", "121", "abc", "NaN", "Infinity"])("rejects %j", (v) => {
    expect(() => parseJitterMinutes(v)).toThrow(/SUBSTACKER_JITTER_MINUTES/);
  });
});

describe("nextRunTime", () => {
  const sched = { hour: 4, minute: 17 };
  it("is today when the time has not come", () => {
    expect(nextRunTime(at("2026-11-09T03:00:00Z"), sched, 0, never)).toBe(at("2026-11-09T04:17:00Z"));
  });
  it("is tomorrow when the time has passed", () => {
    expect(nextRunTime(at("2026-11-09T05:00:00Z"), sched, 0, never)).toBe(at("2026-11-10T04:17:00Z"));
  });
  it("is tomorrow on the exact boundary, and today one millisecond before", () => {
    expect(nextRunTime(at("2026-11-09T04:17:00.000Z"), sched, 0, never)).toBe(at("2026-11-10T04:17:00Z"));
    expect(nextRunTime(at("2026-11-09T04:16:59.999Z"), sched, 0, never)).toBe(at("2026-11-09T04:17:00Z"));
  });
  it("adds the jitter within [0, jitter] minutes", () => {
    const now = at("2026-11-09T03:00:00Z");
    expect(nextRunTime(now, sched, 20, never)).toBe(at("2026-11-09T04:17:00Z"));
    const high = nextRunTime(now, sched, 20, almostOne);
    expect(high).toBeGreaterThan(at("2026-11-09T04:36:59Z"));
    expect(high).toBeLessThanOrEqual(at("2026-11-09T04:37:00Z"));
    expect(nextRunTime(now, sched, 20, () => 0.5)).toBe(at("2026-11-09T04:27:00Z"));
  });
  it("rolls over month and year ends", () => {
    expect(nextRunTime(at("2026-11-30T23:00:00Z"), sched, 0, never)).toBe(at("2026-12-01T04:17:00Z"));
    expect(nextRunTime(at("2026-12-31T23:59:59Z"), sched, 0, never)).toBe(at("2027-01-01T04:17:00Z"));
    expect(nextRunTime(at("2028-02-28T10:00:00Z"), sched, 0, never)).toBe(at("2028-02-29T04:17:00Z"));
    expect(nextRunTime(at("2028-02-29T10:00:00Z"), sched, 0, never)).toBe(at("2028-03-01T04:17:00Z"));
  });
  it("does not depend on the local time zone: a late-evening time stays UTC", () => {
    expect(nextRunTime(at("2026-03-29T00:30:00Z"), { hour: 1, minute: 30 }, 0, never)).toBe(at("2026-03-29T01:30:00Z"));
  });
});

describe("nextChunkMs", () => {
  it("never exceeds the timer maximum, and is the remainder when that is smaller", () => {
    expect(nextChunkMs(10 * MAX_TIMER_MS)).toBeLessThanOrEqual(MAX_TIMER_MS);
    expect(nextChunkMs(1234)).toBe(1234);
    expect(nextChunkMs(0)).toBe(0);
    expect(nextChunkMs(-5)).toBe(0);
  });
  it("keeps the maximum under setTimeout's 2^31-1 limit", () => {
    expect(MAX_TIMER_MS).toBeLessThan(2 ** 31 - 1);
  });
});

describe("parseRetryDelays", () => {
  it("defaults to 5, 15 and 45 minutes", () => {
    expect(RETRY_DELAYS_MS).toEqual([300_000, 900_000, 2_700_000]);
    expect(parseRetryDelays(undefined)).toEqual(RETRY_DELAYS_MS);
  });
  it("reads a comma separated override in milliseconds", () => {
    expect(parseRetryDelays("10, 20,30")).toEqual([10, 20, 30]);
    expect(parseRetryDelays("")).toEqual(RETRY_DELAYS_MS);
  });
  it("rejects nonsense", () => {
    expect(() => parseRetryDelays("a,b")).toThrow(/SUBSTACKER_RETRY_DELAYS_MS/);
    expect(() => parseRetryDelays("-1")).toThrow(/SUBSTACKER_RETRY_DELAYS_MS/);
  });
});

describe("healthStatus", () => {
  const now = at("2026-11-09T12:00:00Z");
  const h = 3_600_000;
  it("is healthy with a recent success", () => {
    expect(healthStatus({ now, lastSuccess: now - 35 * h, startedAt: now - 100 * h })).toEqual({ ok: true, reason: expect.stringContaining("last success") });
  });
  it("is unhealthy with an old success, even if the container is old too", () => {
    const r = healthStatus({ now, lastSuccess: now - 37 * h, startedAt: now - 100 * h });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/37 h ago/);
  });
  it("gives a new container the benefit of the doubt when there is no success yet", () => {
    expect(healthStatus({ now, lastSuccess: undefined, startedAt: now - 2 * h }).ok).toBe(true);
    expect(healthStatus({ now, lastSuccess: now - 50 * h, startedAt: now - 2 * h }).ok).toBe(true);
  });
  it("is unhealthy with no success and an old (or unknown) start", () => {
    expect(healthStatus({ now, lastSuccess: undefined, startedAt: now - 40 * h }).ok).toBe(false);
    expect(healthStatus({ now, lastSuccess: undefined, startedAt: undefined }).ok).toBe(false);
  });
  it("is exactly 36 hours at the limit", () => {
    expect(HEALTH_MAX_AGE_MS).toBe(36 * h);
    expect(healthStatus({ now, lastSuccess: now - 36 * h, startedAt: undefined }).ok).toBe(true);
    expect(healthStatus({ now, lastSuccess: now - 36 * h - 1, startedAt: undefined }).ok).toBe(false);
  });
  it("treats a success time in the future as recent", () => {
    expect(healthStatus({ now, lastSuccess: now + h, startedAt: undefined }).ok).toBe(true);
  });
});
