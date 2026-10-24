// @effect-diagnostics nodeBuiltinImport:off -- Tests drive the forwarder over real loopback sockets.
import { assert, describe, it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as TestClock from "effect/testing/TestClock";
import * as NodeEvents from "node:events";
import * as NodeNet from "node:net";

import * as PortSpaceProxy from "../preview/PortSpaceProxy.ts";
import * as LocalPortForwarder from "./LocalPortForwarder.ts";

/** A stand-in for one thread's namespace: every port answers with the thread's name. */
const fakeThread =
  (name: string): LocalPortForwarder.ForwardSelection["dial"] =>
  async () => {
    const [client, server] = await socketPair();
    server.end(name);
    return client;
  };

const socketPair = async (): Promise<[NodeNet.Socket, NodeNet.Socket]> => {
  const server = NodeNet.createServer();
  server.listen({ host: "127.0.0.1", port: 0 });
  await NodeEvents.EventEmitter.once(server, "listening");
  const accepted = NodeEvents.EventEmitter.once(server, "connection");
  const client = NodeNet.connect((server.address() as NodeNet.AddressInfo).port, "127.0.0.1");
  const [peer] = (await accepted) as [NodeNet.Socket];
  server.close();
  return [client, peer];
};

const freePort = async (): Promise<number> => {
  const server = NodeNet.createServer().listen({ host: "127.0.0.1", port: 0 });
  await NodeEvents.EventEmitter.once(server, "listening");
  const { port } = server.address() as NodeNet.AddressInfo;
  await new Promise((resolve) => server.close(resolve));
  return port;
};

const read = (port: number): Promise<string> =>
  new Promise((resolve) => {
    let text = "";
    const socket = NodeNet.connect(port, "127.0.0.1");
    socket.on("data", (chunk) => (text += chunk));
    socket.once("error", () => resolve("refused"));
    socket.once("close", () => resolve(text));
  });

const selection = (name: string, ports: ReadonlyArray<number>) => ({
  key: name,
  dial: fakeThread(name),
  listeners: ports.map((port) => ({ address: "127.0.0.1", port })),
});

describe("localEndpoints", () => {
  it("binds each listener where the tunnel can reach it", () => {
    const families = (address: string) =>
      LocalPortForwarder.localEndpoints([{ address, port: 3000 }]).map(({ host }) => host);
    assert.deepStrictEqual(families("*"), ["127.0.0.1", "::1"]);
    assert.deepStrictEqual(families("0.0.0.0"), ["127.0.0.1"]);
    assert.deepStrictEqual(families("127.0.0.1"), ["127.0.0.1"]);
    assert.deepStrictEqual(families("::"), ["::1"]);
    assert.deepStrictEqual(families("::1"), ["::1"]);
    // The tunnel only dials 127.0.0.1 and ::1, and other interfaces are not loopback.
    assert.deepStrictEqual(families("127.0.0.2"), []);
    assert.deepStrictEqual(families("10.0.2.15"), []);
  });

  it("skips privileged ports", () => {
    assert.deepStrictEqual(
      LocalPortForwarder.localEndpoints([
        { address: "127.0.0.1", port: 80 },
        { address: "127.0.0.1", port: 1024 },
      ]).map(({ port }) => port),
      [1024],
    );
  });
});

describe("activeSelection", () => {
  it("follows the most recently focused window that has a selection", () => {
    const selections = new Map([
      [1, "thread in window 1"],
      [2, "thread in window 2"],
    ]);
    assert.strictEqual(
      LocalPortForwarder.activeSelection(selections, [1, 2]),
      "thread in window 2",
    );
    assert.strictEqual(
      LocalPortForwarder.activeSelection(selections, [2, 1]),
      "thread in window 1",
    );
    // Focusing a window without a selection (a preview popout) changes nothing.
    assert.strictEqual(
      LocalPortForwarder.activeSelection(selections, [2, 1, 3]),
      "thread in window 1",
    );
    // A window that selected nothing wins too, so nothing is forwarded.
    assert.strictEqual(
      LocalPortForwarder.activeSelection(new Map([...selections, [3, null]]), [2, 1, 3]),
      null,
    );
    assert.strictEqual(LocalPortForwarder.activeSelection(new Map(), [1]), null);
  });
});

describe("makePortForwarder", () => {
  it.effect(
    "moves a shared port to the selected thread and releases ports it no longer serves",
    () =>
      Effect.promise(async () => {
        const [shared, onlyA, onlyB] = [await freePort(), await freePort(), await freePort()];
        const forwarder = LocalPortForwarder.makePortForwarder();
        try {
          await forwarder.apply(selection("A", [shared, onlyA]));
          assert.deepStrictEqual([await read(shared), await read(onlyA)], ["A", "A"]);

          const ports = await forwarder.apply(selection("B", [shared, onlyB]));
          assert.deepStrictEqual(
            ports.map(({ port, state }) => [port, state]),
            [shared, onlyB].toSorted((a, b) => a - b).map((port) => [port, "forwarding"]),
          );
          assert.deepStrictEqual(
            [await read(shared), await read(onlyB), await read(onlyA)],
            ["B", "B", "refused"],
          );
        } finally {
          await forwarder.close();
        }
      }),
  );

  it.effect("closes connections to the previous thread instead of reassigning them", () =>
    Effect.promise(async () => {
      const port = await freePort();
      const forwarder = LocalPortForwarder.makePortForwarder();
      try {
        // A thread whose connection stays open until something closes it.
        let dialed!: () => void;
        const upstreamOpen = new Promise<void>((resolve) => (dialed = resolve));
        await forwarder.apply({
          key: "A",
          listeners: [{ address: "127.0.0.1", port }],
          dial: async () => {
            const [client] = await socketPair();
            dialed();
            return client;
          },
        });
        const open = NodeNet.connect(port, "127.0.0.1");
        await NodeEvents.EventEmitter.once(open, "connect");
        await upstreamOpen;
        const closed = NodeEvents.EventEmitter.once(open, "close");

        await forwarder.apply(selection("B", [port]));
        await closed;
        assert.strictEqual(await read(port), "B");

        // Re-applying the same thread keeps its connections.
        const kept = NodeNet.connect(port, "127.0.0.1");
        let keptClosed = false;
        kept.once("close", () => (keptClosed = true));
        await forwarder.apply(selection("B", [port]));
        assert.isFalse(keptClosed);
        kept.destroy();
      } finally {
        await forwarder.close();
      }
    }),
  );

  it.effect("leaves an address another process serves alone, and takes it once freed", () =>
    Effect.promise(async () => {
      const port = await freePort();
      // A wildcard listener does not stop a loopback bind on macOS, so this is
      // the case binding alone would miss.
      const other = NodeNet.createServer((socket) => socket.end("other"));
      other.listen({ host: "0.0.0.0", port });
      await NodeEvents.EventEmitter.once(other, "listening");
      const forwarder = LocalPortForwarder.makePortForwarder();
      try {
        const ports = await forwarder.apply(selection("A", [port]));
        assert.deepStrictEqual(ports, [{ host: "127.0.0.1", port, state: "conflict" }]);
        assert.strictEqual(await read(port), "other");

        await new Promise((resolve) => other.close(resolve));
        const retried = await forwarder.apply(selection("A", [port]));
        assert.deepStrictEqual(retried, [{ host: "127.0.0.1", port, state: "forwarding" }]);
        assert.strictEqual(await read(port), "A");
      } finally {
        other.close();
        await forwarder.close();
      }
    }),
  );

  it.effect("releases every port when forwarding stops", () =>
    Effect.promise(async () => {
      const port = await freePort();
      const forwarder = LocalPortForwarder.makePortForwarder();
      await forwarder.apply(selection("A", [port]));
      assert.strictEqual(await read(port), "A");
      assert.deepStrictEqual(await forwarder.apply(null), []);
      assert.strictEqual(await read(port), "refused");
      await forwarder.close();
    }),
  );
});

describe("LocalPortForwarder", () => {
  /** The service over a real proxy whose tunnels answer with the thread they reach. */
  const makeService = Effect.fn(function* (scope: Scope.Scope) {
    const proxy = yield* PortSpaceProxy.make(async (url) => {
      const [client, server] = await socketPair();
      server.end(new URL(url).searchParams.get("threadId") ?? "");
      return client;
    }).pipe(Scope.provide(scope));
    yield* proxy.setTunnel({
      environmentId: "env-1",
      access: { url: "wss://env.example/api/port-space/tunnel", ticket: "ticket-1" },
    });
    return yield* LocalPortForwarder.make.pipe(
      Effect.provideService(PortSpaceProxy.PortSpaceProxy, proxy),
      Scope.provide(scope),
    );
  });

  const thread = (threadId: string, port: number) => ({
    environmentId: "env-1",
    threadId,
    listeners: [{ address: "127.0.0.1", port }],
  });

  it.effect("forwards the focused window's thread and hands over when that window closes", () =>
    Effect.gen(function* () {
      const scope = yield* Scope.make();
      const service = yield* makeService(scope);
      const port = yield* Effect.promise(freePort);
      const reached = Effect.promise(() => read(port));

      yield* service.set(1, thread("thread-a", port));
      assert.strictEqual(yield* reached, "thread-a");

      // A window that reports before it is ever focused does not take over.
      yield* service.set(2, thread("thread-b", port));
      assert.strictEqual(yield* reached, "thread-a");

      yield* service.focus(2);
      assert.strictEqual(yield* reached, "thread-b");
      assert.strictEqual((yield* SubscriptionRef.get(service.status))?.threadId, "thread-b");

      // A window with no selection, such as a preview popout, changes nothing.
      yield* service.focus(3);
      assert.strictEqual(yield* reached, "thread-b");

      yield* service.forget(2);
      assert.strictEqual(yield* reached, "thread-a");

      yield* service.set(1, null);
      assert.strictEqual(yield* reached, "refused");
      assert.isNull(yield* SubscriptionRef.get(service.status));
      yield* Scope.close(scope, Exit.void);
    }),
  );

  it.effect("takes a conflicting port once the other process lets it go", () =>
    Effect.gen(function* () {
      const scope = yield* Scope.make();
      const service = yield* makeService(scope);
      const port = yield* Effect.promise(freePort);
      const other = NodeNet.createServer((socket) => socket.end("other"));
      yield* Effect.promise(async () => {
        other.listen({ host: "127.0.0.1", port });
        await NodeEvents.EventEmitter.once(other, "listening");
      });

      yield* service.set(1, thread("thread-a", port));
      assert.deepStrictEqual((yield* SubscriptionRef.get(service.status))?.ports, [
        { host: "127.0.0.1", port, state: "conflict" },
      ]);

      yield* Effect.promise(() => new Promise((resolve) => other.close(resolve)));
      yield* TestClock.adjust(Duration.seconds(5));
      yield* SubscriptionRef.changes(service.status).pipe(
        Stream.filter((status) => status?.ports[0]?.state === "forwarding"),
        Stream.runHead,
      );
      assert.strictEqual(yield* Effect.promise(() => read(port)), "thread-a");
      yield* Scope.close(scope, Exit.void);
    }),
  );
});
