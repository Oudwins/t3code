// @effect-diagnostics globalDate:off -- Tests exercise local calendar and elapsed-time snooze input.
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { resolveCustomSnooze, resolveSnoozeQuery } from "./threadSettled.ts";

const now = new Date(2026, 8, 14, 14, 30);

afterEach(() => vi.unstubAllEnvs());

describe("custom snooze", () => {
  it.each([
    ["2026-09-14", "14:30"],
    ["2027-02-29", "09:00"],
    ["2026-09-15", "24:00"],
  ])("rejects invalid or non-future calendar input %s %s", (date, time) => {
    expect(resolveCustomSnooze({ mode: "date", date, time }, now)).toBeNull();
  });

  it.each([
    ["minutes", "45", 45 * 60_000],
    ["hours", "1.5", 90 * 60_000],
    ["days", "2", 48 * 3_600_000],
  ] as const)("resolves %s from the confirmation time", (unit, amount, elapsed) => {
    const confirmedAt = new Date(now.getTime() + 5 * 60_000);
    expect(resolveCustomSnooze({ mode: "duration", amount, unit }, confirmedAt)).toBe(
      new Date(confirmedAt.getTime() + elapsed).toISOString(),
    );
  });

  it.each(["0", "NaN", "1e300"])("rejects invalid duration %s", (amount) => {
    expect(resolveCustomSnooze({ mode: "duration", amount, unit: "hours" }, now)).toBeNull();
  });

  it("rejects nonexistent local times at the spring DST transition", () => {
    vi.stubEnv("TZ", "America/Los_Angeles");
    expect(
      resolveCustomSnooze(
        { mode: "date", date: "2027-03-14", time: "02:30" },
        new Date("2027-03-01T00:00:00Z"),
      ),
    ).toBeNull();
  });

  it("treats duration days as 24 hours across DST", () => {
    vi.stubEnv("TZ", "America/Los_Angeles");
    const before = new Date(2027, 2, 13, 12);
    const wake = resolveCustomSnooze({ mode: "duration", amount: "1", unit: "days" }, before);
    expect(wake).toBe(new Date(2027, 2, 14, 13).toISOString());
  });
});

describe("typed snooze query", () => {
  it.each([
    ["5d", 5 * 24 * 60],
    ["5h", 5 * 60],
    ["45m", 45],
    ["2w", 14 * 24 * 60],
    ["1.5h", 90],
    ["1.1h", 66],
    ["1h 30m", 90],
    ["3 days", 3 * 24 * 60],
    ["in 2 hours", 120],
    [" 10 MIN ", 10],
  ])("resolves %s", (query, minutes) => {
    expect(resolveSnoozeQuery(query, now)?.snoozedUntil).toBe(
      new Date(now.getTime() + minutes * 60_000).toISOString(),
    );
  });

  it.each(["", "5", "tomorrow", "5x", "5 in", "0.2m", "1.5m", "h5", "400d", "1e9w"])(
    "rejects %s",
    (query) => {
      expect(resolveSnoozeQuery(query, now)).toBeNull();
    },
  );
});
