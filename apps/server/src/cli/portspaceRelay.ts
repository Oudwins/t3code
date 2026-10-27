import * as Effect from "effect/Effect";
import { Argument, Command } from "effect/cli";

import { PORT_RELAY_COMMAND, runPortRelay } from "../portSpace/PortRelay.ts";

/**
 * `t3 portspace-relay` - internal; runs inside a thread's namespace so the host can reach its
 * loopback. Real invocations take the bin.ts fast path; this keeps the command wired for help
 * and for anything that drives the full CLI programmatically.
 */
export const portspaceRelayCommand = Command.make(PORT_RELAY_COMMAND, {
  socket: Argument.String("socket"),
}).pipe(
  Command.withDescription("Relay host connections into a thread's port space."),
  Command.unlisted,
  Command.withHandler(({ socket }) => Effect.promise(() => runPortRelay(socket))),
);
