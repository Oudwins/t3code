/**
 * Dials loopback ports in a thread's port space through one lazily started relay per namespace
 * (`PortRelay.ts`) over a unix socket. No host listener exists, so every reach is authorizable.
 * `dial` never creates a namespace or falls back to the host network.
 * @module PortGateway
 */
// Dialing is raw sockets and unix paths; there is no Effect abstraction for them.
// @effect-diagnostics nodeBuiltinImport:off
import type { ThreadId } from "@t3tools/contracts";
import * as KeyedLock from "@t3tools/shared/KeyedLock";
import { resolveSelfInvocation, selfInvocationArgs } from "@t3tools/shared/nodeRuntime";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as NodeNet from "node:net";

import {
  PORT_RELAY_COMMAND,
  PORT_RELAY_READY_LINE,
  RELAY_STATUS_CONNECTED,
  encodeRelayTarget,
  type RelayFamily,
} from "./PortRelay.ts";
import { PortSpaces } from "./PortSpaces.ts";
import { spawnerInPortSpace } from "@t3tools/shared/SpawnerInPortSpace";

export interface PortTarget {
  readonly family: RelayFamily;
  readonly port: number;
}

export class PortGatewayError extends Schema.TaggedError<PortGatewayError>()("PortGatewayError", {
  threadId: Schema.String,
  /** `no-port-space`: the thread has no namespace. `unavailable`: its relay would not start or answer. `refused`: nothing listens there. */
  reason: Schema.Literals(["no-port-space", "unavailable", "refused"]),
}) {
  override get message(): string {
    return `Port space dial for thread ${this.threadId} failed: ${this.reason}`;
  }
}

export class PortGateway extends Context.Service<
  PortGateway,
  {
    /**
     * A connected stream to a loopback port inside the thread's namespace,
     * closed when the scope ends. Resolves only once the namespace accepted
     * the connection.
     */
    readonly dial: (
      threadId: ThreadId,
      target: PortTarget,
    ) => Effect.Effect<NodeNet.Socket, PortGatewayError, Scope.Scope>;
    /** Stops a thread's relay. Idempotent. */
    readonly release: (threadId: ThreadId) => Effect.Effect<void>;
  }
>()("t3/portSpace/PortGateway") {}

interface ThreadRelay {
  readonly scope: Scope.Closeable;
  readonly socket: string;
  readonly isRunning: Effect.Effect<boolean>;
}

const RELAY_START_TIMEOUT = "10 seconds";
const DIAL_TIMEOUT = "10 seconds";

const connectRelay = (threadId: ThreadId, socketPath: string, target: PortTarget) =>
  Effect.callback<NodeNet.Socket, PortGatewayError>((resume) => {
    const socket = NodeNet.connect({ path: socketPath, allowHalfOpen: true });
    const fail = (reason: PortGatewayError["reason"]) => {
      socket.destroy();
      resume(Effect.fail(new PortGatewayError({ threadId, reason })));
    };
    socket.once("error", () => fail("unavailable"));
    socket.once("close", () => fail("unavailable"));
    socket.once("connect", () => socket.write(encodeRelayTarget(target.family, target.port)));
    socket.once("data", (chunk) => {
      socket.pause();
      if (chunk[0] !== RELAY_STATUS_CONNECTED) {
        fail("refused");
        return;
      }
      // Bytes the namespace's server sent right behind the status byte belong to the caller.
      if (chunk.length > 1) socket.unshift(chunk.subarray(1));
      socket.removeAllListeners("close");
      socket.removeAllListeners("error");
      socket.on("error", () => socket.destroy());
      resume(Effect.succeed(socket));
    });
    return Effect.sync(() => socket.destroy());
  });

const make = Effect.gen(function* () {
  const portSpaces = yield* PortSpaces;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  // Each thread's entry is only touched while holding that thread's lock.
  const relays = new Map<ThreadId, ThreadRelay>();
  const locks = yield* KeyedLock.make<ThreadId>();

  const closeRelay = (relay: ThreadRelay) => Scope.close(relay.scope, Exit.void);

  const startRelay = Effect.fn("PortGateway.startRelay")(function* (threadId: ThreadId) {
    const scope = yield* Scope.make();
    const started = yield* Effect.gen(function* () {
      // mkdtemp makes the directory owner-only, which is the relay's access control.
      const directory = yield* fs.makeTempDirectory({ prefix: "t3-portspace-" });
      yield* Scope.addFinalizer(
        scope,
        fs.remove(directory, { recursive: true, force: true }).pipe(Effect.ignore),
      );
      const socket = path.join(directory, "relay.sock");
      const self = yield* resolveSelfInvocation().pipe(Effect.provideService(Path.Path, path));
      const relay = yield* spawnerInPortSpace(spawner, (input) =>
        portSpaces.wrapSpawn(threadId, input),
      )
        .spawn(
          ChildProcess.make(
            self.command,
            [...selfInvocationArgs(self, [PORT_RELAY_COMMAND, socket])],
            { env: { ELECTRON_RUN_AS_NODE: "1" } },
          ),
        )
        .pipe(Scope.provide(scope));
      const ready = yield* relay.stdout.pipe(
        Stream.decodeText(),
        Stream.splitLines,
        Stream.filter((line) => line === PORT_RELAY_READY_LINE),
        Stream.runHead,
        Effect.timeoutOption(RELAY_START_TIMEOUT),
      );
      if (ready._tag === "None" || ready.value._tag === "None") return undefined;
      return {
        scope,
        socket,
        isRunning: relay.isRunning.pipe(Effect.orElseSucceed(() => false)),
      } satisfies ThreadRelay;
    }).pipe(Effect.result);
    if (started._tag === "Failure" || started.success === undefined) {
      yield* Scope.close(scope, Exit.void);
      yield* Effect.logDebug("port space relay did not start", { threadId });
      return undefined;
    }
    relays.set(threadId, started.success);
    return started.success;
  });

  // A relay that exited leaves its socket dialing nothing; replace it.
  const relayFor = (threadId: ThreadId) =>
    locks.withLock(
      threadId,
      Effect.gen(function* () {
        const current = relays.get(threadId);
        if (current !== undefined && (yield* current.isRunning)) return current;
        if (current !== undefined) {
          relays.delete(threadId);
          yield* closeRelay(current);
        }
        return yield* startRelay(threadId);
      }),
    );

  const dial: PortGateway["Service"]["dial"] = Effect.fn("PortGateway.dial")(
    function* (threadId, target) {
      const threads = yield* portSpaces.threads;
      if (!threads.includes(threadId)) {
        return yield* new PortGatewayError({ threadId, reason: "no-port-space" });
      }
      const relay = yield* relayFor(threadId);
      if (relay === undefined)
        return yield* new PortGatewayError({ threadId, reason: "unavailable" });
      return yield* Effect.uninterruptibleMask((restore) =>
        restore(
          connectRelay(threadId, relay.socket, target).pipe(
            Effect.timeoutOrElse({
              duration: DIAL_TIMEOUT,
              orElse: () => Effect.fail(new PortGatewayError({ threadId, reason: "unavailable" })),
            }),
          ),
        ).pipe(
          Effect.tap((socket) => Effect.addFinalizer(() => Effect.sync(() => socket.destroy()))),
        ),
      );
    },
  );

  const release = Effect.fn("PortGateway.release")(function* (threadId: ThreadId) {
    yield* locks.withLock(
      threadId,
      Effect.gen(function* () {
        const relay = relays.get(threadId);
        if (relay === undefined) return;
        relays.delete(threadId);
        yield* closeRelay(relay);
      }),
    );
  });

  yield* Effect.addFinalizer(() =>
    Effect.forEach([...relays.values()], closeRelay, { discard: true }).pipe(
      Effect.tap(() => Effect.sync(() => relays.clear())),
    ),
  );

  return PortGateway.of({ dial, release });
});

export const layer = Layer.effect(PortGateway, make);
