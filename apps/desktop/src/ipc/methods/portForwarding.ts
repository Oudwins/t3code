import {
  DesktopPortForwardingInputSchema,
  DesktopPortForwardingStatusSchema,
} from "@t3tools/contracts";
import * as Electron from "electron";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import * as ElectronApp from "../../electron/ElectronApp.ts";
import * as ElectronWindow from "../../electron/ElectronWindow.ts";
import * as LocalPortForwarder from "../../portForward/LocalPortForwarder.ts";
import * as DesktopIpc from "../DesktopIpc.ts";
import {
  GET_PORT_FORWARDING_STATUS_CHANNEL,
  PORT_FORWARDING_STATUS_CHANNEL,
  SET_PORT_FORWARDING_CHANNEL,
} from "../channels.ts";

/**
 * Each window reports the thread it has selected; the forwarder follows the
 * most recently focused one and every window is told what is forwarded.
 */
export const installPortForwarding = Effect.fn("desktop.ipc.installPortForwarding")(function* () {
  const ipc = yield* DesktopIpc.DesktopIpc;
  const app = yield* ElectronApp.ElectronApp;
  const electronWindow = yield* ElectronWindow.ElectronWindow;
  const forwarder = yield* LocalPortForwarder.LocalPortForwarder;
  const tracked = new Set<number>();

  yield* ipc.handle(
    DesktopIpc.makeIpcMethod({
      channel: SET_PORT_FORWARDING_CHANNEL,
      payload: DesktopPortForwardingInputSchema,
      result: Schema.Void,
      handler: (input, event) =>
        Effect.suspend(() => {
          if (event === undefined) return Effect.void;
          const windowId = event.sender.id;
          if (!tracked.has(windowId)) {
            tracked.add(windowId);
            Electron.webContents.fromId(windowId)?.once("destroyed", () => {
              tracked.delete(windowId);
              Effect.runFork(forwarder.forget(windowId));
            });
          }
          return forwarder.set(windowId, input);
        }),
    }),
  );
  yield* ipc.handle(
    DesktopIpc.makeIpcMethod({
      channel: GET_PORT_FORWARDING_STATUS_CHANNEL,
      payload: Schema.Void,
      result: DesktopPortForwardingStatusSchema,
      handler: () => SubscriptionRef.get(forwarder.status),
    }),
  );
  yield* app.on("browser-window-focus", (_event: unknown, window: Electron.BrowserWindow) => {
    if (!window.isDestroyed()) Effect.runFork(forwarder.focus(window.webContents.id));
  });
  yield* SubscriptionRef.changes(forwarder.status).pipe(
    Stream.runForEach((status) => electronWindow.sendAll(PORT_FORWARDING_STATUS_CHANNEL, status)),
    Effect.forkScoped,
  );
});
