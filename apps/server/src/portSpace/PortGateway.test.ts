// The gateway is real sockets and a real relay process, so the tests dial real loopback ports.
// The "namespace" is the host's own loopback: wrapSpawn leaves the relay's spawn untouched.
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as NodeNet from "node:net";
import * as NodePath from "node:path";

import * as PortGateway from "./PortGateway.ts";
import * as PortSpaces from "./PortSpaces.ts";

const BIN_PATH = NodePath.resolve(import.meta.dirname, "../bin.ts");
const SLOW_TEST = 30_000;

const threadA = ThreadId.make("thread-a");
const threadB = ThreadId.make("thread-b");
const noSpace = ThreadId.make("thread-without-a-port-space");

interface Harness {
  /** The argv of every relay started in a port space, in start order. */
  readonly spawned: Array<ReadonlyArray<string>>;
  /** The handle of every process started, in the same order as `spawned`. */
  readonly handles: Array<ChildProcessSpawner.ChildProcessHandle>;
}

const harness = (): Harness => ({ spawned: [], handles: [] });

const recordingSpawner = (state: Harness) =>
  Layer.effect(
    ChildProcessSpawner.ChildProcessSpawner,
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      return ChildProcessSpawner.make((command) =>
        spawner
          .spawn(command)
          .pipe(Effect.tap((handle) => Effect.sync(() => state.handles.push(handle)))),
      );
    }),
  );

const gatewayLayer = (state: Harness) =>
  PortGateway.layer.pipe(
    Layer.provideMerge(recordingSpawner(state)),
    Layer.provideMerge(
      Layer.mock(PortSpaces.PortSpaces)({
        threads: Effect.succeed([threadA, threadB]),
        wrapSpawn: (_threadId, input) => {
          state.spawned.push(input.args);
          return { command: input.command, args: input.args, env: {} };
        },
      }),
    ),
    Layer.provideMerge(NodeServices.layer),
  );

/** Runs `use` with the relay started the way a source checkout starts it: node running bin.ts. */
const withGateway = <A, E>(
  state: Harness,
  use: (gateway: PortGateway.PortGateway["Service"]) => Effect.Effect<A, E>,
) =>
  Effect.gen(function* () {
    return yield* use(yield* PortGateway.PortGateway);
  }).pipe(
    Effect.provide(gatewayLayer(state)),
    Effect.provideService(HostProcess.ExecutablePath, process.execPath),
    Effect.provideService(HostProcess.IsExecutable, false),
    Effect.provideService(HostProcess.Arguments, [process.execPath, BIN_PATH]),
  );

/** A TCP service answering `echo:<what it was sent>`, optionally greeting first. */
const serve = (host: string, options: { readonly greeting?: string } = {}) =>
  Effect.acquireRelease(
    Effect.promise(
      () =>
        new Promise<{ readonly server: NodeNet.Server; readonly sockets: Set<NodeNet.Socket> }>(
          (resolve) => {
            const sockets = new Set<NodeNet.Socket>();
            const server = NodeNet.createServer((socket) => {
              sockets.add(socket);
              socket.on("error", () => {});
              if (options.greeting !== undefined) socket.write(options.greeting);
              socket.once("data", (chunk) => socket.end(`echo:${chunk.toString()}`));
            });
            server.listen({ host, port: 0 }, () => resolve({ server, sockets }));
          },
        ),
    ),
    ({ server, sockets }) =>
      Effect.sync(() => {
        for (const socket of sockets) socket.destroy();
        server.close();
      }),
  ).pipe(
    Effect.map(({ server }) => {
      const address = server.address();
      return { port: typeof address === "object" && address !== null ? address.port : 0 };
    }),
  );

/** A TCP service that holds each connection open and reports when its first one closes. */
const serveAndWatch = (host: string) =>
  Effect.acquireRelease(
    Effect.promise(
      () =>
        new Promise<{ readonly server: NodeNet.Server; readonly closed: Promise<void> }>(
          (resolve) => {
            let markClosed = () => {};
            const closed = new Promise<void>((done) => {
              markClosed = done;
            });
            const server = NodeNet.createServer((socket) => {
              socket.on("error", () => {});
              socket.once("close", markClosed);
            });
            server.listen({ host, port: 0 }, () => resolve({ server, closed }));
          },
        ),
    ),
    ({ server }) => Effect.sync(() => server.close()),
  ).pipe(
    Effect.map(({ server, closed }) => {
      const address = server.address();
      return { port: typeof address === "object" && address !== null ? address.port : 0, closed };
    }),
  );

/** A port nothing listens on. */
const unusedPort = Effect.promise(
  () =>
    new Promise<number>((resolve) => {
      const server = NodeNet.createServer();
      server.listen({ host: "127.0.0.1", port: 0 }, () => {
        const address = server.address();
        const port = typeof address === "object" && address !== null ? address.port : 0;
        server.close(() => resolve(port));
      });
    }),
);

/** Sends `payload` through a dialed connection and reads until the other side ends. */
const exchange = (
  gateway: PortGateway.PortGateway["Service"],
  threadId: ThreadId,
  target: PortGateway.PortTarget,
  payload: string,
) =>
  Effect.scoped(
    gateway.dial(threadId, target).pipe(
      Effect.flatMap((socket) =>
        Effect.promise(
          () =>
            new Promise<string>((resolve) => {
              const chunks: Array<string> = [];
              socket.setEncoding("utf8");
              socket.on("data", (chunk: string) => chunks.push(chunk));
              socket.on("end", () => socket.end());
              socket.on("close", () => resolve(chunks.join("")));
              socket.write(payload);
              socket.resume();
            }),
        ),
      ),
    ),
  );

const failureOf = <A>(effect: Effect.Effect<A, PortGateway.PortGatewayError, never>) =>
  effect.pipe(
    Effect.flip,
    Effect.map((error) => error.reason),
  );

const killRelay = (state: Harness, index: number) =>
  Effect.gen(function* () {
    const relay = state.handles[index];
    expect(relay).toBeDefined();
    if (relay === undefined) return;
    yield* relay.kill();
    yield* relay.exitCode;
  });

describe("PortGateway.dial", () => {
  it.effect(
    "reaches a loopback port by address family",
    () =>
      Effect.gen(function* () {
        const v4 = yield* serve("127.0.0.1");
        const v6 = yield* serve("::1");
        const state = harness();

        yield* withGateway(state, (gateway) =>
          Effect.gen(function* () {
            expect(yield* exchange(gateway, threadA, { family: 4, port: v4.port }, "four")).toBe(
              "echo:four",
            );
            expect(yield* exchange(gateway, threadA, { family: 6, port: v6.port }, "six")).toBe(
              "echo:six",
            );
            expect(
              yield* exchange(gateway, threadA, { family: "localhost", port: v4.port }, "name"),
            ).toBe("echo:name");
          }),
        );
        expect(state.spawned).toHaveLength(1);
      }).pipe(Effect.scoped),
    SLOW_TEST,
  );

  it.effect(
    "keeps the bytes a server sends right behind the connect status",
    () =>
      Effect.gen(function* () {
        const service = yield* serve("127.0.0.1", { greeting: "hello;" });

        yield* withGateway(harness(), (gateway) =>
          Effect.gen(function* () {
            expect(yield* exchange(gateway, threadA, { family: 4, port: service.port }, "x")).toBe(
              "hello;echo:x",
            );
          }),
        );
      }).pipe(Effect.scoped),
    SLOW_TEST,
  );

  it.effect(
    "starts one relay per thread",
    () =>
      Effect.gen(function* () {
        const service = yield* serve("127.0.0.1");
        const state = harness();

        yield* withGateway(state, (gateway) =>
          Effect.gen(function* () {
            yield* exchange(gateway, threadA, { family: 4, port: service.port }, "a");
            yield* exchange(gateway, threadB, { family: 4, port: service.port }, "b");
            yield* exchange(gateway, threadA, { family: 4, port: service.port }, "again");
          }),
        );
        expect(state.spawned).toHaveLength(2);
        expect(new Set(state.spawned.map((args) => args.at(-1))).size).toBe(2);
      }).pipe(Effect.scoped),
    SLOW_TEST,
  );

  it.effect(
    "fails without starting anything for a thread that has no port space",
    () =>
      Effect.gen(function* () {
        const state = harness();

        yield* withGateway(state, (gateway) =>
          Effect.gen(function* () {
            expect(
              yield* failureOf(
                gateway.dial(noSpace, { family: 4, port: 3000 }).pipe(Effect.scoped),
              ),
            ).toBe("no-port-space");
          }),
        );
        expect(state.spawned).toEqual([]);
      }),
    SLOW_TEST,
  );

  it.effect(
    "fails when nothing listens on the port",
    () =>
      Effect.gen(function* () {
        const port = yield* unusedPort;

        yield* withGateway(harness(), (gateway) =>
          Effect.gen(function* () {
            expect(
              yield* failureOf(gateway.dial(threadA, { family: 4, port }).pipe(Effect.scoped)),
            ).toBe("refused");
            expect(
              yield* failureOf(
                gateway.dial(threadA, { family: "localhost", port }).pipe(Effect.scoped),
              ),
            ).toBe("refused");
          }),
        );
      }),
    SLOW_TEST,
  );

  it.effect(
    "replaces a relay that exited",
    () =>
      Effect.gen(function* () {
        const service = yield* serve("127.0.0.1");
        const state = harness();

        yield* withGateway(state, (gateway) =>
          Effect.gen(function* () {
            yield* exchange(gateway, threadA, { family: 4, port: service.port }, "first");
            yield* killRelay(state, 0);
            expect(
              yield* exchange(gateway, threadA, { family: 4, port: service.port }, "second"),
            ).toBe("echo:second");
          }),
        );
        expect(state.spawned).toHaveLength(2);
      }).pipe(Effect.scoped),
    SLOW_TEST,
  );

  it.effect(
    "closes the upstream connection when the scope ends",
    () =>
      Effect.gen(function* () {
        const service = yield* serveAndWatch("127.0.0.1");

        yield* withGateway(harness(), (gateway) =>
          Effect.gen(function* () {
            yield* Effect.scoped(gateway.dial(threadA, { family: 4, port: service.port }));
            yield* Effect.promise(() => service.closed);
          }),
        );
      }).pipe(Effect.scoped),
    SLOW_TEST,
  );
});

describe("PortGateway.release", () => {
  it.effect(
    "stops a thread's relay and starts a new one on the next dial",
    () =>
      Effect.gen(function* () {
        const service = yield* serve("127.0.0.1");
        const state = harness();

        yield* withGateway(state, (gateway) =>
          Effect.gen(function* () {
            yield* exchange(gateway, threadA, { family: 4, port: service.port }, "first");
            yield* gateway.release(threadA);
            const relay = state.handles[0];
            expect(relay).toBeDefined();
            if (relay !== undefined) yield* relay.exitCode;
            expect(
              yield* exchange(gateway, threadA, { family: 4, port: service.port }, "second"),
            ).toBe("echo:second");
          }),
        );
        expect(state.spawned).toHaveLength(2);
      }).pipe(Effect.scoped),
    SLOW_TEST,
  );

  it.effect("is a no-op for a thread without a relay", () =>
    withGateway(harness(), (gateway) => gateway.release(threadA)),
  );
});
