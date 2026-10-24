/**
 * A thread's port space TCP listeners as a stream, for clients that forward
 * them to their own machine. Unlike port discovery it lists every listener the
 * tunnel can reach, not only web servers, so databases and raw TCP services
 * come along too.
 *
 * @module PortSpaceListeners
 */
import type { PortSpaceListenerList, ThreadId } from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";

import { PortSpaces } from "./PortSpaces.ts";

const POLL_INTERVAL = Duration.seconds(3);

/** The addresses `ss` prints for a listener `127.0.0.1` or `::1` can reach. */
const TUNNEL_REACHABLE = new Set(["*", "0.0.0.0", "::", "127.0.0.1", "::1"]);

const listKey = (list: PortSpaceListenerList) =>
  list.listeners.map(({ address, port }) => `${address} ${port}`).join(",");

/**
 * The thread's listeners now, then again whenever the set changes. A thread
 * this process has no namespace for has none: `PortGateway` cannot dial it
 * either, so listing its ports would only promise connections that fail.
 */
export const watch = (
  threadId: ThreadId,
): Stream.Stream<PortSpaceListenerList, never, PortSpaces> =>
  Stream.unwrap(
    Effect.gen(function* () {
      const portSpaces = yield* PortSpaces;
      const read = Effect.gen(function* () {
        if (!(yield* portSpaces.threads).includes(threadId)) return { listeners: [] };
        const listeners = yield* portSpaces.listeners(threadId);
        const unique = new Map<string, { address: string; port: number }>();
        for (const { address, port } of listeners) {
          if (TUNNEL_REACHABLE.has(address)) unique.set(`${address} ${port}`, { address, port });
        }
        return { listeners: [...unique.values()] };
      }).pipe(
        // A namespace released between reads has nothing left to forward.
        Effect.orElseSucceed((): PortSpaceListenerList => ({ listeners: [] })),
      );
      return Stream.fromEffectSchedule(read, Schedule.spaced(POLL_INTERVAL)).pipe(
        Stream.changesWith((previous, next) => listKey(previous) === listKey(next)),
      );
    }),
  );
