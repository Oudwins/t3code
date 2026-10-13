import { describe, it } from "@effect/vitest";
import { expect } from "vite-plus/test";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import { tunnelRenewals } from "./portSpace";

const TICKET_LIFETIME_SECONDS = 300;

const attemptTimes = (results: ReadonlyArray<boolean>, runFor: Duration.Duration) =>
  Effect.gen(function* () {
    const times: number[] = [];
    const remaining = [...results];
    const attempt = Effect.gen(function* () {
      times.push((yield* Clock.currentTimeMillis) / 1000);
      return remaining.shift() ?? true;
    });
    yield* tunnelRenewals(attempt).pipe(Stream.runDrain, Effect.forkScoped);
    yield* Effect.yieldNow;
    yield* TestClock.adjust(runFor);
    return times;
  }).pipe(Effect.provide(TestClock.layer()));

describe("tunnelRenewals", () => {
  it.effect("renews every four minutes while attempts succeed", () =>
    Effect.gen(function* () {
      expect(yield* attemptTimes([], Duration.minutes(9))).toEqual([0, 240, 480]);
    }),
  );

  it.effect("retries a failed renewal before the previous ticket expires", () =>
    Effect.gen(function* () {
      const times = yield* attemptTimes([true, false, false, true], Duration.minutes(9));
      expect(times).toEqual([0, 240, 245, 255, 495]);
      expect(times[3]).toBeLessThan(TICKET_LIFETIME_SECONDS);
    }),
  );

  it.effect("retries a failed first attempt in seconds, not minutes", () =>
    Effect.gen(function* () {
      expect(yield* attemptTimes([false, true], Duration.minutes(9))).toEqual([0, 5, 245, 485]);
    }),
  );

  it.effect("backs off to a thirty second retry while attempts keep failing", () =>
    Effect.gen(function* () {
      const times = yield* attemptTimes(Array(20).fill(false), Duration.minutes(3));
      expect(times).toEqual([0, 5, 15, 35, 65, 95, 125, 155]);
    }),
  );
});
