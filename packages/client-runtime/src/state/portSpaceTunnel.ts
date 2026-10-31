/**
 * Desktop main dials the port space tunnel but has no cookie jar and cannot sign relay DPoP
 * proofs, so the renderer mints a short-lived WebSocket ticket for every connection kind,
 * cookie sessions included. A ticket lives five minutes server-side and is session-bound, so
 * one covers every tunnel opened with it.
 */
import { PORT_SPACE_TUNNEL_PATH } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
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
    ticket: Redacted.value(ticket.ticket),
  };
});
