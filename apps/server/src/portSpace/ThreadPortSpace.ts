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
import {
  type PortSpaceSpawn,
  type PortSpaceSpawnInput,
  ThreadPortSpace,
  type ThreadPortSpaceHandle,
  type ThreadPortSpaceShape,
} from "@t3tools/shared/ThreadPortSpace";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ServerSettings from "../serverSettings.ts";
import { PortSpaces } from "./PortSpaces.ts";

export const makeThreadPortSpace = Effect.gen(function* () {
  const portSpaces = yield* PortSpaces;
  const settings = yield* ServerSettings.ServerSettingsService;

  const resolve = Effect.fn("ThreadPortSpace.resolve")(function* (rawThreadId: string) {
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
    return {
      rewrite: (input) => portSpaces.wrapSpawn(threadId, input),
      hostAddress: portSpaces.hostAddress(threadId).pipe(
        Effect.tapError((error) =>
          Effect.logWarning("port space host address unavailable, MCP stays on loopback", {
            threadId,
            cause: error.message,
          }),
        ),
        Effect.orElseSucceed(() => undefined),
      ),
    } satisfies ThreadPortSpaceHandle;
  });
  return { resolve } satisfies ThreadPortSpaceShape;
});

export const layer = Layer.effect(ThreadPortSpace, makeThreadPortSpace);

/**
 * Returns the spawn to run instead of `input`, or `undefined` when the thread
 * does not use a port space and `input` should run as it is.
 */
export type ThreadSpawnWrapper = (
  threadId: string,
  input: PortSpaceSpawnInput,
) => Effect.Effect<PortSpaceSpawn | undefined>;

export const makeThreadSpawnWrapper = Effect.gen(function* () {
  const { resolve } = yield* makeThreadPortSpace;
  const wrap: ThreadSpawnWrapper = (threadId, input) =>
    resolve(threadId).pipe(Effect.map((handle) => handle?.rewrite(input)));
  return wrap;
});
