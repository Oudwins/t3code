/**
 * Credentials for the port space tunnel.
 *
 * The tunnel is dialed by desktop main, which has no cookie jar and cannot sign
 * relay DPoP proofs, so every connection kind mints a short-lived WebSocket
 * ticket in the renderer and hands it over. Unlike the device hub, cookie
 * sessions mint too. A ticket lives five minutes server-side and is bound to the
 * session, so one covers every tunnel opened with it.
 */
import { PORT_SPACE_TUNNEL_PATH } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import type { HttpClient } from "effect/http";

import * as RemoteEnvironmentAuthorization from "../authorization/service.ts";
import type { PreparedConnection } from "../connection/model.ts";
import { environmentEndpointUrl } from "../environment/endpoint.ts";
import * as ManagedRelay from "../relay/managedRelay.ts";
import type { RemoteEnvironmentRequestError } from "../rpc/http.ts";
import { executeAuthenticatedEnvironmentHttpRequest } from "./environmentHttpAuth.ts";

const TICKET_TIMEOUT_MS = 8_000;

export interface PortSpaceTunnelAccess {
  /** Absolute `ws(s)` URL of the environment's tunnel route. */
  readonly url: string;
  readonly ticket: string;
}

export const resolvePortSpaceTunnelAccess = Effect.fn(
  "clientRuntime.state.resolvePortSpaceTunnelAccess",
)(function* (input: {
  readonly prepared: PreparedConnection;
}): Effect.fn.Return<PortSpaceTunnelAccess, RemoteEnvironmentRequestError, HttpClient.HttpClient> {
  const signer = yield* Effect.serviceOption(ManagedRelay.ManagedRelayDpopSigner);
  const remoteAuthorization = yield* Effect.serviceOption(
    RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization,
  );
  const ticket = yield* executeAuthenticatedEnvironmentHttpRequest({
    prepared: input.prepared,
    signer,
    remoteAuthorization,
    group: "auth",
    method: "POST",
    url: (urls) => urls.webSocketTicket(),
    timeoutMs: TICKET_TIMEOUT_MS,
    request: ({ client, headers }) => client.webSocketTicket({ headers }),
  });
  return {
    url: environmentEndpointUrl(input.prepared.httpBaseUrl, PORT_SPACE_TUNNEL_PATH).replace(
      /^http/,
      "ws",
    ),
    ticket: ticket.ticket,
  };
});
