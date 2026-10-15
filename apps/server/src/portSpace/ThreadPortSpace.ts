/**
 * ThreadPortSpace - whether a thread's processes run in a port space.
 *
 * Opt-in per environment (`enablePortSpaces`). When it is on but the namespace
 * cannot be made, callers spawn in the host network instead of failing: a
 * terminal that does not open is worse than one that shares ports.
 *
 * @module ThreadPortSpace
 */

import { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as ServerSettings from "../serverSettings.ts";
import { PortSpaces, type PortSpaceSpawn } from "./PortSpaces.ts";

type SpawnInput = Parameters<PortSpaces["Service"]["wrapSpawn"]>[1];

/**
 * Returns the spawn to run instead of `input`, or `undefined` when the thread
 * does not use a port space and `input` should run as it is.
 */
export type ThreadSpawnWrapper = (
  threadId: string,
  input: SpawnInput,
) => Effect.Effect<PortSpaceSpawn | undefined>;

export const makeThreadSpawnWrapper = Effect.gen(function* () {
  const portSpaces = yield* PortSpaces;
  const settings = yield* ServerSettings.ServerSettingsService;

  const wrap: ThreadSpawnWrapper = Effect.fn("ThreadPortSpace.wrapSpawn")(
    function* (rawThreadId, input) {
      const enabled = yield* settings.getSettings.pipe(
        Effect.map((value) => value.enablePortSpaces),
        Effect.orElseSucceed(() => false),
      );
      if (!enabled) return undefined;

      const threadId = ThreadId.make(rawThreadId);
      const ensured = yield* Effect.result(portSpaces.ensure(threadId));
      if (ensured._tag === "Failure") {
        yield* Effect.logWarning("port space unavailable, using the host network", {
          threadId,
          cause: ensured.failure.message,
        });
        return undefined;
      }
      return portSpaces.wrapSpawn(threadId, input);
    },
  );
  return wrap;
});
