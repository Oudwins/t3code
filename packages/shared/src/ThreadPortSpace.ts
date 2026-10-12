import * as Context from "effect/Context";
import * as Effect from "effect/Effect";

/**
 * Whether a thread's processes run in its port space (a per-thread network
 * namespace). The server provides the real implementation; the default never
 * rewrites, which is also the behavior wherever port spaces are off.
 */
export interface PortSpaceSpawnInput {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd?: string | undefined;
  readonly env?: Readonly<Record<string, string | undefined>> | undefined;
}

export interface PortSpaceSpawn {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  /** The complete environment to spawn with. The caller's own variables travel inside the helper's prologue. */
  readonly env: Record<string, string>;
}

/** Rewrites a spawn to run inside a thread's namespace. Synchronous so SDK spawn callbacks can use it. */
export type SpawnRewriter = (input: PortSpaceSpawnInput) => PortSpaceSpawn;

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
 * Provider adapters capture this when they are built, so the server's layer
 * must be in the context the provider instances are built in.
 */
export const ThreadPortSpace = Context.Reference<ThreadPortSpaceShape>(
  "@t3tools/shared/ThreadPortSpace",
  { defaultValue: () => ({ resolve: () => Effect.succeed(undefined) }) },
);

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
