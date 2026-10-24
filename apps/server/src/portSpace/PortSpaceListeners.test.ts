import { ThreadId } from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as PortSpaceListeners from "./PortSpaceListeners.ts";
import { PortSpaceCommandError, PortSpaces, type PortSpaceListener } from "./PortSpaces.ts";

const threadId = ThreadId.make("thread-a");

const listener = (address: string, port: number): PortSpaceListener => ({
  address,
  port,
  process: undefined,
});

const portSpaces = (state: {
  threads: ReadonlyArray<ThreadId>;
  listeners: ReadonlyArray<PortSpaceListener> | "gone";
}) =>
  PortSpaces.of({
    capability: Effect.succeed({ available: true }),
    ensure: () => Effect.void,
    threads: Effect.sync(() => state.threads),
    wrapSpawn: () => ({ command: "helper", args: [], env: {} }),
    hostAddress: () => Effect.succeed("10.0.2.2"),
    listeners: () =>
      Effect.suspend(() =>
        state.listeners === "gone"
          ? Effect.fail(new PortSpaceCommandError({ operation: "listeners", detail: "gone" }))
          : Effect.succeed(state.listeners),
      ),
    release: () => Effect.void,
  });

describe("PortSpaceListeners.watch", () => {
  it.effect("sends the reachable listeners, then only changes", () =>
    Effect.gen(function* () {
      const state = {
        threads: [threadId],
        listeners: [
          listener("*", 3000),
          listener("127.0.0.1", 5432),
          // Only 127.0.0.1 and ::1 are dialable through the tunnel.
          listener("10.0.2.15", 9000),
          listener("127.0.0.2", 9001),
        ] as ReadonlyArray<PortSpaceListener> | "gone",
      };
      const fiber = yield* PortSpaceListeners.watch(threadId).pipe(
        Stream.take(3),
        Stream.runCollect,
        Effect.provideService(PortSpaces, portSpaces(state)),
        Effect.forkChild,
      );
      yield* TestClock.adjust(Duration.seconds(3));
      // Unchanged: no update.
      yield* TestClock.adjust(Duration.seconds(3));
      state.listeners = [listener("*", 3000), listener("::1", 8080)];
      yield* TestClock.adjust(Duration.seconds(3));
      // The namespace went away.
      state.listeners = "gone";
      yield* TestClock.adjust(Duration.seconds(3));

      assert.deepStrictEqual(yield* Fiber.join(fiber), [
        {
          listeners: [
            { address: "*", port: 3000 },
            { address: "127.0.0.1", port: 5432 },
          ],
        },
        {
          listeners: [
            { address: "*", port: 3000 },
            { address: "::1", port: 8080 },
          ],
        },
        { listeners: [] },
      ]);
    }),
  );

  it.effect("lists nothing for a thread this process has no namespace for", () =>
    Effect.gen(function* () {
      const first = yield* PortSpaceListeners.watch(threadId).pipe(
        Stream.take(1),
        Stream.runCollect,
        Effect.provideService(
          PortSpaces,
          portSpaces({ threads: [], listeners: [listener("*", 3000)] }),
        ),
      );
      assert.deepStrictEqual(first, [{ listeners: [] }]);
    }),
  );
});
