// The route is an HTTP upgrade into raw sockets, so the tests drive a real server with real sockets.
// @effect-diagnostics nodeBuiltinImport:off
import { NodeHttpServer } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import {
  AuthOrchestrationReadScope,
  AuthSessionId,
  AuthTerminalOperateScope,
  PORT_SPACE_TUNNEL_PATH,
  type AuthEnvironmentScope,
  type ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpRouter, HttpServer } from "effect/http";
import * as NodeHttp from "node:http";
import * as NodeNet from "node:net";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as PortGateway from "./PortGateway.ts";
import * as PortTunnelRoute from "./PortTunnelRoute.ts";

type Dial = PortGateway.PortGateway["Service"]["dial"];

const failWith =
  (reason: PortGateway.PortGatewayError["reason"]): Dial =>
  (threadId) =>
    Effect.fail(new PortGateway.PortGatewayError({ threadId, reason }));

const dialLocal =
  (port: number): Dial =>
  () =>
    Effect.acquireRelease(
      Effect.callback<NodeNet.Socket>((resume) => {
        const socket = NodeNet.connect({ host: "127.0.0.1", port });
        socket.on("error", () => socket.destroy());
        socket.once("connect", () => {
          socket.pause();
          resume(Effect.succeed(socket));
        });
      }),
      (socket) => Effect.sync(() => socket.destroy()),
    );

const startRoute = (options: {
  readonly dial: Dial;
  readonly scopes?: ReadonlyArray<AuthEnvironmentScope>;
  readonly authError?:
    | EnvironmentAuth.ServerAuthCredentialError
    | EnvironmentAuth.ServerAuthInternalError;
}) =>
  Effect.gen(function* () {
    const dials: Array<{
      readonly threadId: ThreadId;
      readonly family: unknown;
      readonly port: number;
    }> = [];
    yield* HttpRouter.serve(PortTunnelRoute.layer, {
      disableListenLog: true,
      disableLogger: true,
    }).pipe(
      Layer.provide(
        Layer.succeed(EnvironmentAuth.EnvironmentAuth, {
          authenticateWebSocketUpgrade: () =>
            options.authError
              ? Effect.fail(options.authError)
              : Effect.succeed({
                  sessionId: AuthSessionId.make("test"),
                  subject: "test",
                  method: "bearer-access-token",
                  scopes: options.scopes ?? [AuthTerminalOperateScope],
                }),
        } as unknown as EnvironmentAuth.EnvironmentAuth["Service"]),
      ),
      Layer.provide(
        Layer.mock(PortGateway.PortGateway)({
          dial: (threadId, target) => {
            dials.push({ threadId, ...target });
            return options.dial(threadId, target);
          },
        }),
      ),
      Layer.build,
    );
    const server = yield* HttpServer.HttpServer;
    const port = "port" in server.address ? server.address.port : 0;
    return { port, dials };
  });

const TARGET = "threadId=thread-a&family=localhost&port=3000";

/** The status of a handshake the server answered without upgrading, or 101. */
const handshakeStatus = (port: number, query: string, upgrade = true) =>
  new Promise<number>((resolve, reject) => {
    const request = NodeHttp.request({
      // A shared keep-alive socket stalls after a handshake the server answered without upgrading.
      agent: false,
      host: "127.0.0.1",
      port,
      path: `${PORT_SPACE_TUNNEL_PATH}?${query}`,
      headers: upgrade
        ? {
            connection: "Upgrade",
            upgrade: "websocket",
            "sec-websocket-version": "13",
            "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
          }
        : {},
    });
    request.on("response", (response) => {
      response.resume();
      resolve(response.statusCode ?? 0);
    });
    request.on("upgrade", (response, socket) => {
      socket.destroy();
      resolve(response.statusCode ?? 0);
    });
    request.on("error", reject);
    request.end();
  });

const openTunnel = (port: number, query: string) =>
  new Promise<WebSocket>((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}${PORT_SPACE_TUNNEL_PATH}?${query}`);
    socket.binaryType = "arraybuffer";
    socket.addEventListener("open", () => resolve(socket));
    socket.addEventListener("error", () => reject(new Error("tunnel handshake failed")));
  });

const nextMessage = (socket: WebSocket) =>
  new Promise<Uint8Array>((resolve) => {
    socket.addEventListener(
      "message",
      (event) => resolve(new Uint8Array(event.data as ArrayBuffer)),
      { once: true },
    );
  });

const closed = (socket: WebSocket) =>
  new Promise<void>((resolve) => {
    socket.addEventListener("close", () => resolve(), { once: true });
  });

/** Echoes every byte. `closes` resolves when its first connection ends. */
const echoServer = (options: { readonly endAfterFirstReply?: boolean } = {}) =>
  Effect.acquireRelease(
    Effect.promise(
      () =>
        new Promise<{ readonly server: NodeNet.Server; readonly closes: Promise<void> }>(
          (resolve) => {
            let markClosed = () => {};
            const closes = new Promise<void>((done) => {
              markClosed = done;
            });
            const server = NodeNet.createServer((socket) => {
              socket.on("error", () => {});
              socket.once("close", markClosed);
              socket.on("data", (chunk) => {
                if (options.endAfterFirstReply) socket.end(chunk);
                else socket.write(chunk);
              });
            });
            server.listen({ host: "127.0.0.1", port: 0 }, () => resolve({ server, closes }));
          },
        ),
    ),
    ({ server }) => Effect.sync(() => server.close()),
  ).pipe(
    Effect.map(({ server, closes }) => {
      const address = server.address();
      return { port: typeof address === "object" && address !== null ? address.port : 0, closes };
    }),
  );

describe("port tunnel route", () => {
  it.effect("rejects a request that is not an upgrade or names no valid target", () =>
    Effect.gen(function* () {
      const { port, dials } = yield* startRoute({ dial: failWith("refused") });

      expect(yield* Effect.promise(() => handshakeStatus(port, TARGET, false))).toBe(400);
      for (const query of [
        "family=localhost&port=3000",
        "threadId=thread-a&family=5&port=3000",
        "threadId=thread-a&family=4&port=0",
        "threadId=thread-a&family=4&port=65536",
        "threadId=thread-a&family=4&port=3000.5",
        "threadId=thread-a&family=4",
      ]) {
        expect(yield* Effect.promise(() => handshakeStatus(port, query))).toBe(400);
      }
      expect(dials).toEqual([]);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("refuses an unauthenticated or under-scoped upgrade before dialing", () =>
    Effect.gen(function* () {
      const unauthenticated = yield* startRoute({
        dial: failWith("refused"),
        authError: new EnvironmentAuth.ServerAuthMissingCredentialError({}),
      });
      expect(yield* Effect.promise(() => handshakeStatus(unauthenticated.port, TARGET))).toBe(401);
      expect(unauthenticated.dials).toEqual([]);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("requires the terminal operate scope", () =>
    Effect.gen(function* () {
      const readOnly = yield* startRoute({
        dial: failWith("refused"),
        scopes: [AuthOrchestrationReadScope],
      });
      expect(yield* Effect.promise(() => handshakeStatus(readOnly.port, TARGET))).toBe(403);
      expect(readOnly.dials).toEqual([]);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect.each([
    ["no-port-space", 404],
    ["refused", 502],
    ["unavailable", 503],
  ] as const)("answers a %s dial with HTTP %s instead of upgrading", ([reason, status]) =>
    Effect.gen(function* () {
      const { port, dials } = yield* startRoute({ dial: failWith(reason) });

      expect(yield* Effect.promise(() => handshakeStatus(port, TARGET))).toBe(status);
      expect(dials).toEqual([{ threadId: "thread-a", family: "localhost", port: 3000 }]);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("carries bytes both ways and ends the connection when the client closes", () =>
    Effect.gen(function* () {
      const upstream = yield* echoServer();
      const { port, dials } = yield* startRoute({ dial: dialLocal(upstream.port) });

      const tunnel = yield* Effect.promise(() =>
        openTunnel(port, "threadId=thread-b&family=6&port=3000&wsTicket=ignored"),
      );
      const reply = nextMessage(tunnel);
      tunnel.send(new Uint8Array([0, 1, 2, 255]));
      expect([...(yield* Effect.promise(() => reply))]).toEqual([0, 1, 2, 255]);

      tunnel.close();
      yield* Effect.promise(() => upstream.closes);
      expect(dials).toEqual([{ threadId: "thread-b", family: 6, port: 3000 }]);
    }).pipe(Effect.scoped, Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("closes the tunnel when the upstream ends", () =>
    Effect.gen(function* () {
      const upstream = yield* echoServer({ endAfterFirstReply: true });
      const { port } = yield* startRoute({ dial: dialLocal(upstream.port) });

      const tunnel = yield* Effect.promise(() => openTunnel(port, TARGET));
      const reply = nextMessage(tunnel);
      const ended = closed(tunnel);
      tunnel.send(new Uint8Array([7]));
      expect([...(yield* Effect.promise(() => reply))]).toEqual([7]);
      yield* Effect.promise(() => ended);
    }).pipe(Effect.scoped, Effect.provide(NodeHttpServer.layerTest)),
  );
});
