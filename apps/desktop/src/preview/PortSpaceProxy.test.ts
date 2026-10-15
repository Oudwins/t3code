// @effect-diagnostics nodeBuiltinImport:off -- Tests drive the proxy over real loopback sockets and WebSockets.
import { assert, describe, it } from "@effect/vitest";
import type { Session } from "electron";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Scope from "effect/Scope";
import * as NodeNet from "node:net";
import * as NodeStream from "node:stream";
import { vi } from "vite-plus/test";

import * as PortSpaceProxy from "./PortSpaceProxy.ts";

const ipv4 = (...octets: number[]): PortSpaceProxy.SocksTarget => ({
  kind: "ipv4",
  bytes: Uint8Array.from(octets),
  port: 3000,
});

const ipv6 = (...groups: number[]): PortSpaceProxy.SocksTarget => {
  const bytes = new Uint8Array(16);
  groups.forEach((group, index) => {
    bytes[index * 2] = group >> 8;
    bytes[index * 2 + 1] = group & 0xff;
  });
  return { kind: "ipv6", bytes, port: 3000 };
};

describe("routeTarget", () => {
  it("sends loopback names and addresses to the thread's namespace", () => {
    const tunnel = (family: PortSpaceProxy.TunnelFamily): PortSpaceProxy.SocksRoute => ({
      kind: "tunnel",
      family,
      port: 3000,
    });
    assert.deepStrictEqual(
      PortSpaceProxy.routeTarget({ kind: "domain", host: "localhost", port: 3000 }),
      tunnel("localhost"),
    );
    assert.deepStrictEqual(
      PortSpaceProxy.routeTarget({ kind: "domain", host: "App.Localhost.", port: 3000 }),
      tunnel("localhost"),
    );
    assert.deepStrictEqual(PortSpaceProxy.routeTarget(ipv4(127, 0, 0, 1)), tunnel(4));
    assert.deepStrictEqual(PortSpaceProxy.routeTarget(ipv6(0, 0, 0, 0, 0, 0, 0, 1)), tunnel(6));
    assert.deepStrictEqual(
      PortSpaceProxy.routeTarget(ipv6(0, 0, 0, 0, 0, 0xffff, 0x7f00, 1)),
      tunnel(4),
    );
  });

  it("refuses loopback forms the tunnel cannot express instead of using this machine", () => {
    for (const target of [
      ipv4(127, 0, 0, 2),
      ipv4(127, 1, 2, 3),
      ipv4(0, 0, 0, 0),
      ipv6(0, 0, 0, 0, 0, 0, 0, 0),
      ipv6(0, 0, 0, 0, 0, 0xffff, 0x7f00, 2),
    ]) {
      assert.deepStrictEqual(PortSpaceProxy.routeTarget(target), { kind: "blocked" });
    }
  });

  it("leaves everything else on the direct path", () => {
    assert.deepStrictEqual(
      PortSpaceProxy.routeTarget({ kind: "domain", host: "example.com", port: 443 }),
      { kind: "direct", host: "example.com", port: 443 },
    );
    assert.deepStrictEqual(PortSpaceProxy.routeTarget(ipv4(10, 0, 0, 5)), {
      kind: "direct",
      host: "10.0.0.5",
      port: 3000,
    });
    assert.deepStrictEqual(PortSpaceProxy.routeTarget(ipv6(0x2001, 0xdb8, 0, 0, 0, 0, 0, 1)), {
      kind: "direct",
      host: "2001:db8:0:0:0:0:0:1",
      port: 3000,
    });
  });
});

interface FakeTunnel {
  readonly url: URL;
  readonly sent: Buffer[];
}

/** A tunnel whose far end echoes what it receives, so a round trip proves the route. */
const makeFakeTunnels = (options?: { readonly failToOpen?: boolean }) => {
  const tunnels: FakeTunnel[] = [];
  const createSocket: PortSpaceProxy.TunnelSocketFactory = (url, handlers) => {
    const tunnel: FakeTunnel = { url: new URL(url), sent: [] };
    tunnels.push(tunnel);
    queueMicrotask(options?.failToOpen ? handlers.error : handlers.open);
    return {
      send: (data) => {
        tunnel.sent.push(Buffer.from(data));
        handlers.message(Uint8Array.from(data));
      },
      close: () => handlers.close(),
      isOpen: () => true,
    };
  };
  return { tunnels, createSocket };
};

const ACCESS: PortSpaceProxy.PortSpaceTunnelAccess = {
  url: "wss://env.example/api/port-space/tunnel",
  ticket: "ticket-1",
};

const socksConnect = (
  port: number,
  target: Buffer,
): Promise<{ readonly status: number; readonly socket: NodeNet.Socket }> =>
  new Promise((resolve, reject) => {
    const socket = NodeNet.connect({ host: "127.0.0.1", port });
    socket.once("error", reject);
    let stage: "greeting" | "request" = "greeting";
    socket.on("data", (data) => {
      if (stage === "greeting") {
        assert.deepStrictEqual([...data], [5, 0]);
        stage = "request";
        socket.write(Buffer.concat([Buffer.from([5, 1, 0]), target]));
        return;
      }
      socket.removeAllListeners("data");
      resolve({ status: data[1] ?? -1, socket });
    });
    socket.write(Buffer.from([5, 1, 0]));
  });

const domainTarget = (host: string, port: number): Buffer => {
  const bytes = Buffer.from(host);
  return Buffer.concat([
    Buffer.from([3, bytes.length]),
    bytes,
    Buffer.from([port >> 8, port & 0xff]),
  ]);
};

const addressTarget = (octets: number[], port: number): Buffer =>
  Buffer.concat([Buffer.from([1, ...octets]), Buffer.from([port >> 8, port & 0xff])]);

const echoed = (socket: NodeNet.Socket, payload: string): Promise<string> =>
  new Promise((resolve) => {
    socket.once("data", (data) => resolve(data.toString()));
    socket.write(payload);
  });

const withServer = <A>(
  connect: PortSpaceProxy.SocksConnect,
  use: (server: PortSpaceProxy.SocksServer) => Promise<A>,
) =>
  Effect.acquireUseRelease(
    Effect.promise(() => PortSpaceProxy.startSocksServer(connect)),
    (server) => Effect.promise(() => use(server)),
    (server) => Effect.sync(() => server.close()),
  );

describe("SOCKS proxy", () => {
  it.effect("carries localhost:3000 through the thread's tunnel and nowhere else", () =>
    Effect.gen(function* () {
      const { tunnels, createSocket } = makeFakeTunnels();
      const connectDirect = vi.fn(() => Promise.reject(new Error("must not connect directly")));
      const connect = PortSpaceProxy.makeSocksConnect({
        threadId: "thread-a",
        access: () => ACCESS,
        createSocket,
        connectDirect,
      });

      yield* withServer(connect, async ({ port }) => {
        const { status, socket } = await socksConnect(port, domainTarget("localhost", 3000));
        assert.strictEqual(status, 0);
        assert.strictEqual(await echoed(socket, "GET / HTTP/1.1"), "GET / HTTP/1.1");
        socket.destroy();
      });

      assert.strictEqual(connectDirect.mock.calls.length, 0);
      assert.strictEqual(tunnels.length, 1);
      const { url } = tunnels[0]!;
      assert.strictEqual(url.origin + url.pathname, "wss://env.example/api/port-space/tunnel");
      assert.deepStrictEqual(Object.fromEntries(url.searchParams), {
        threadId: "thread-a",
        family: "localhost",
        port: "3000",
        wsTicket: "ticket-1",
      });
    }),
  );

  it.effect("keeps two threads' apps on the same port apart and reaches API ports in-thread", () =>
    Effect.gen(function* () {
      const { tunnels, createSocket } = makeFakeTunnels();
      const proxyFor = (threadId: string) =>
        PortSpaceProxy.makeSocksConnect({ threadId, access: () => ACCESS, createSocket });

      for (const [threadId, target] of [
        ["thread-a", domainTarget("localhost", 3000)],
        ["thread-b", domainTarget("localhost", 3000)],
        ["thread-b", addressTarget([127, 0, 0, 1], 8080)],
      ] as const) {
        yield* withServer(proxyFor(threadId), async ({ port }) => {
          const { status, socket } = await socksConnect(port, target);
          assert.strictEqual(status, 0);
          socket.destroy();
        });
      }

      assert.deepStrictEqual(
        tunnels.map(({ url }) => [
          url.searchParams.get("threadId"),
          url.searchParams.get("family"),
          url.searchParams.get("port"),
        ]),
        [
          ["thread-a", "localhost", "3000"],
          ["thread-b", "localhost", "3000"],
          ["thread-b", "4", "8080"],
        ],
      );
    }),
  );

  it.effect("fails closed for loopback without a tunnel and for unexpressible loopback", () =>
    Effect.gen(function* () {
      const { tunnels, createSocket } = makeFakeTunnels();
      const connectDirect = vi.fn(() => Promise.reject(new Error("must not connect directly")));
      const connect = PortSpaceProxy.makeSocksConnect({
        threadId: "thread-a",
        access: () => undefined,
        createSocket,
        connectDirect,
      });

      yield* withServer(connect, async ({ port }) => {
        for (const target of [
          domainTarget("localhost", 3000),
          addressTarget([127, 0, 0, 1], 3000),
          addressTarget([127, 0, 0, 2], 3000),
          addressTarget([0, 0, 0, 0], 3000),
        ]) {
          const { status, socket } = await socksConnect(port, target);
          assert.strictEqual(status, 5);
          socket.destroy();
        }
      });

      assert.strictEqual(tunnels.length, 0);
      assert.strictEqual(connectDirect.mock.calls.length, 0);
    }),
  );

  it.effect("reports a tunnel that cannot open as a failed connection", () =>
    Effect.gen(function* () {
      const { createSocket } = makeFakeTunnels({ failToOpen: true });
      const connect = PortSpaceProxy.makeSocksConnect({
        threadId: "thread-a",
        access: () => ACCESS,
        createSocket,
      });

      yield* withServer(connect, async ({ port }) => {
        const { status, socket } = await socksConnect(port, domainTarget("localhost", 3000));
        assert.strictEqual(status, 5);
        socket.destroy();
      });
    }),
  );

  it.effect("sends other hosts straight out", () =>
    Effect.gen(function* () {
      const { tunnels, createSocket } = makeFakeTunnels();
      const connectDirect = vi.fn(() =>
        Promise.resolve(
          new NodeStream.Duplex({
            read() {},
            write(_c, _e, done) {
              done();
            },
          }),
        ),
      );
      const connect = PortSpaceProxy.makeSocksConnect({
        threadId: "thread-a",
        access: () => ACCESS,
        createSocket,
        connectDirect,
      });

      yield* withServer(connect, async ({ port }) => {
        const { status, socket } = await socksConnect(port, domainTarget("example.com", 443));
        assert.strictEqual(status, 0);
        socket.destroy();
      });

      assert.deepStrictEqual(connectDirect.mock.calls, [["example.com", 443]]);
      assert.strictEqual(tunnels.length, 0);
    }),
  );

  it.effect("refuses commands other than CONNECT", () =>
    Effect.gen(function* () {
      const connect = PortSpaceProxy.makeSocksConnect({
        threadId: "thread-a",
        access: () => ACCESS,
        createSocket: makeFakeTunnels().createSocket,
      });

      yield* withServer(
        connect,
        ({ port }) =>
          new Promise<void>((resolve, reject) => {
            const socket = NodeNet.connect({ host: "127.0.0.1", port });
            socket.once("error", reject);
            let greeted = false;
            socket.on("data", (data) => {
              if (!greeted) {
                greeted = true;
                socket.write(Buffer.from([5, 3, 0, 1, 0, 0, 0, 0, 0, 0]));
                return;
              }
              assert.strictEqual(data[1], 7);
              socket.destroy();
              resolve();
            });
            socket.write(Buffer.from([5, 1, 0]));
          }),
      );
    }),
  );
});

describe("PortSpaceProxy service", () => {
  const makeSession = () => {
    const setProxy = vi.fn((_config: unknown) => Promise.resolve());
    return { session: { setProxy } as unknown as Session, setProxy };
  };

  const proxyPort = (setProxy: ReturnType<typeof vi.fn>, call = 0): number => {
    const [config] = setProxy.mock.calls[call] as [{ readonly proxyRules: string }];
    return Number(config.proxyRules.replace("socks5://127.0.0.1:", ""));
  };

  it.effect("routes a session's loopback requests through its own thread", () =>
    Effect.gen(function* () {
      const scope = yield* Scope.make();
      const { tunnels, createSocket } = makeFakeTunnels();
      const proxy = yield* PortSpaceProxy.make(createSocket).pipe(Scope.provide(scope));
      const first = makeSession();
      const second = makeSession();

      yield* proxy.setTunnel({ environmentId: "env-1", access: ACCESS });
      yield* proxy.attach(first.session, { environmentId: "env-1", threadId: "thread-a" });
      yield* proxy.attach(second.session, { environmentId: "env-1", threadId: "thread-b" });

      assert.deepStrictEqual(first.setProxy.mock.calls[0], [
        {
          proxyRules: `socks5://127.0.0.1:${proxyPort(first.setProxy)}`,
          proxyBypassRules: "<-loopback>",
        },
      ]);
      assert.notStrictEqual(proxyPort(first.setProxy), proxyPort(second.setProxy));

      yield* Effect.promise(async () => {
        for (const { setProxy } of [first, second]) {
          const { status, socket } = await socksConnect(
            proxyPort(setProxy),
            domainTarget("localhost", 3000),
          );
          assert.strictEqual(status, 0);
          socket.destroy();
        }
      });

      assert.deepStrictEqual(
        tunnels.map(({ url }) => url.searchParams.get("threadId")),
        ["thread-a", "thread-b"],
      );
      yield* Scope.close(scope, Exit.void);
    }),
  );

  it.effect("reuses a thread's listener and applies refreshed or revoked credentials", () =>
    Effect.gen(function* () {
      const scope = yield* Scope.make();
      const { tunnels, createSocket } = makeFakeTunnels();
      const proxy = yield* PortSpaceProxy.make(createSocket).pipe(Scope.provide(scope));
      const attached = makeSession();
      const again = makeSession();

      yield* proxy.setTunnel({ environmentId: "env-1", access: ACCESS });
      yield* proxy.attach(attached.session, { environmentId: "env-1", threadId: "thread-a" });
      yield* proxy.attach(again.session, { environmentId: "env-1", threadId: "thread-a" });
      assert.strictEqual(proxyPort(attached.setProxy), proxyPort(again.setProxy));
      const port = proxyPort(attached.setProxy);

      yield* proxy.setTunnel({ environmentId: "env-1", access: { ...ACCESS, ticket: "ticket-2" } });
      yield* Effect.promise(async () => {
        const { status, socket } = await socksConnect(port, domainTarget("localhost", 3000));
        assert.strictEqual(status, 0);
        socket.destroy();
      });
      assert.strictEqual(tunnels[0]?.url.searchParams.get("wsTicket"), "ticket-2");

      yield* proxy.setTunnel({ environmentId: "env-1", access: null });
      yield* Effect.promise(async () => {
        const { status, socket } = await socksConnect(port, domainTarget("localhost", 3000));
        assert.strictEqual(status, 5);
        socket.destroy();
      });
      assert.strictEqual(tunnels.length, 1);
      yield* Scope.close(scope, Exit.void);
    }),
  );
});
