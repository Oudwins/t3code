/**
 * Authenticated WebSocket tunnel into a thread's port space.
 *
 * One WebSocket carries one TCP connection to a loopback port inside the
 * thread's namespace. The client (the desktop app's per-thread proxy) opens one
 * per connection the browser makes, so `localhost:3000` means the thread's own
 * :3000 for every request the session issues, including absolute API URLs and
 * WebSockets. Like every `/api/*` route it rides the connection the client
 * already has, so local, Tailscale, SSH-forwarded, and relayed environments
 * need nothing more than T3's own transport.
 *
 * The target is dialed before the upgrade so a refused port is an HTTP error.
 * Only loopback targets exist: the route cannot be used to reach the host's
 * network. Half-close is not carried; either side closing ends both.
 */
import { AuthTerminalOperateScope, PORT_SPACE_TUNNEL_PATH, ThreadId } from "@t3tools/contracts";
import * as NodeSocket from "@effect/platform-node/NodeSocket";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import * as Socket from "effect/socket/Socket";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import {
  failEnvironmentAuthInvalid,
  failEnvironmentInternal,
  failEnvironmentScopeRequired,
} from "../auth/http.ts";
import { PortGateway, PortGatewayError, type PortTarget } from "./PortGateway.ts";

const decodeThreadId = Schema.decodeUnknownOption(ThreadId);

const parseTarget = (params: URLSearchParams) => {
  const threadId = decodeThreadId(params.get("threadId"));
  const family = { "4": 4, "6": 6, localhost: "localhost" }[params.get("family") ?? ""] as
    | PortTarget["family"]
    | undefined;
  const port = Number(params.get("port"));
  if (Option.isNone(threadId) || family === undefined || !Number.isInteger(port)) {
    return Option.none();
  }
  return port >= 1 && port <= 65535
    ? Option.some({ threadId: threadId.value, target: { family, port } })
    : Option.none();
};

const FAILURE_STATUS = { "no-port-space": 404, refused: 502, unavailable: 503 } as const;

const authenticate = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
  const session = yield* serverAuth.authenticateWebSocketUpgrade(request).pipe(
    Effect.catch((error) =>
      Effect.gen(function* () {
        if (EnvironmentAuth.isServerAuthCredentialError(error)) {
          return yield* failEnvironmentAuthInvalid(
            EnvironmentAuth.serverAuthCredentialReason(error),
            EnvironmentAuth.serverAuthDpopFailureReason(error),
          );
        }
        return yield* failEnvironmentInternal("internal_error", error);
      }),
    ),
  );
  if (!session.scopes.includes(AuthTerminalOperateScope)) {
    return yield* failEnvironmentScopeRequired(AuthTerminalOperateScope);
  }
});

const pump = (source: Socket.Socket, sink: Socket.Writer) =>
  Effect.gen(function* () {
    const { pull } = yield* source.reader;
    while (true) {
      yield* sink.writeAll(yield* pull);
    }
  });

const handler = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const url = HttpServerRequest.toURL(request);
  if (Option.isNone(url) || request.headers.upgrade?.toLowerCase() !== "websocket") {
    return HttpServerResponse.text("Bad Request", { status: 400 });
  }
  yield* authenticate;
  const parsed = parseTarget(url.value.searchParams);
  if (Option.isNone(parsed)) return HttpServerResponse.text("Bad Request", { status: 400 });

  const gateway = yield* PortGateway;
  return yield* Effect.scoped(
    gateway.dial(parsed.value.threadId, parsed.value.target).pipe(
      Effect.matchEffect({
        onFailure: (error: PortGatewayError) =>
          Effect.succeed(
            HttpServerResponse.text(error.message, { status: FAILURE_STATUS[error.reason] }),
          ),
        onSuccess: (tcp) =>
          Effect.gen(function* () {
            const client = yield* request.upgrade;
            const upstream = yield* NodeSocket.fromDuplex(Effect.succeed(tcp));
            const writeToClient = yield* client.writer;
            const writeToUpstream = yield* upstream.writer;
            // Whichever side closes first fails its pull, which ends the other via scope teardown.
            return yield* Effect.raceFirst(
              pump(upstream, writeToClient),
              pump(client, writeToUpstream),
            );
          }).pipe(Effect.ignoreCause, Effect.as(HttpServerResponse.empty())),
      }),
    ),
  );
});

export const layer = HttpRouter.add("GET", PORT_SPACE_TUNNEL_PATH, handler);
