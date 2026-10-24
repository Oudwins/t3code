import type { DesktopPortForwardingStatus } from "@t3tools/contracts";
import { useSyncExternalStore } from "react";

/** Desktop main's port forwarding; `null` on the web build and on desktop builds without it. */
export const portForwardingBridge =
  typeof window !== "undefined" && window.desktopBridge?.setPortForwarding
    ? window.desktopBridge
    : null;

let status: DesktopPortForwardingStatus = null;
const listeners = new Set<() => void>();

if (portForwardingBridge) {
  const publish = (next: DesktopPortForwardingStatus) => {
    status = next;
    for (const listener of listeners) listener();
  };
  portForwardingBridge.onPortForwardingStatus?.(publish);
  void portForwardingBridge.getPortForwardingStatus?.().then(publish, () => undefined);
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

/** What desktop main forwards to this machine right now, for whichever window selected it. */
export function usePortForwardingStatus(): DesktopPortForwardingStatus {
  return useSyncExternalStore(
    subscribe,
    () => status,
    () => null,
  );
}
