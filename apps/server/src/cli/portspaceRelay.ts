import * as Effect from "effect/Effect";
import { Argument, Command } from "effect/cli";

import { PORT_RELAY_COMMAND, runPortRelay } from "../portSpace/PortRelay.ts";

/**
 * `t3 portspace-relay` - internal. The server runs it inside a thread's
 * network namespace so the host can reach that namespace's loopback ports.
 *
 * Real invocations dispatch through the bin.ts fast path before the CLI graph
 * loads; this definition keeps the command wired for help and for anything
 * that drives the full CLI programmatically.
 */
export const portspaceRelayCommand = Command.make(PORT_RELAY_COMMAND, {
  socket: Argument.String("socket"),
}).pipe(
  Command.withDescription("Relay host connections into a thread's port space."),
  Command.unlisted,
  Command.withHandler(({ socket }) => Effect.promise(() => runPortRelay(socket))),
);
