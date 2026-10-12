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
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ServerSettings from "../serverSettings.ts";
import { PortSpaces, type PortSpaceSpawn } from "./PortSpaces.ts";

type SpawnInput = Parameters<PortSpaces["Service"]["wrapSpawn"]>[1];

/** Rewrites a spawn to run inside a thread's namespace. Synchronous so SDK spawn callbacks can use it. */
export type SpawnRewriter = (input: SpawnInput) => PortSpaceSpawn;

export interface ThreadPortSpaceHandle {
  readonly rewrite: SpawnRewriter;
  /**
   * Where the host's loopback is, seen from inside the namespace, or
   * `undefined` when it cannot be found: URLs then stay as they are.
   */
  readonly hostAddress: Effect.Effect<string | undefined>;
}

export interface ThreadPortSpaceShape {
  /**
   * Makes the thread's namespace and returns a handle into it, or `undefined`
   * when the thread does not use a port space and spawns should run as they are.
   */
  readonly resolve: (threadId: string) => Effect.Effect<ThreadPortSpaceHandle | undefined>;
}

/**
 * Provider adapters capture this when they are built. The default reference
 * never rewrites, which keeps adapter construction dependency-free in tests;
 * the live layer must be in the context the provider instances are built in.
 */
export class ThreadPortSpace extends Context.Reference<ThreadPortSpaceShape>(
  "t3/portSpace/ThreadPortSpace",
  { defaultValue: () => ({ resolve: () => Effect.succeed(undefined) }) },
) {}

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
  input: SpawnInput,
) => Effect.Effect<PortSpaceSpawn | undefined>;

export const makeThreadSpawnWrapper = Effect.gen(function* () {
  const { resolve } = yield* makeThreadPortSpace;
  const wrap: ThreadSpawnWrapper = (threadId, input) =>
    resolve(threadId).pipe(Effect.map((handle) => handle?.rewrite(input)));
  return wrap;
});

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

/**
 * The same URL as seen from inside a port space. A namespace has its own
 * loopback, so anything that points at the host's loopback (T3's MCP endpoint)
 * has to go through `hostAddress` instead. Other hosts are left alone.
 */
export const urlInPortSpace = (url: string, hostAddress: string | undefined): string => {
  if (hostAddress === undefined) return url;
  const parsed = URL.parse(url);
  if (parsed === null || !LOOPBACK_HOSTS.has(parsed.hostname)) return url;
  parsed.hostname = hostAddress;
  return parsed.toString();
};
