import type { DesktopPortForwardingInput, PortSpaceListener } from "@t3tools/contracts";
import { useParams } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";

import { useClientSettings } from "~/hooks/useSettings";
import { useHoldPortSpaceTunnel, usePortSpacesEnabled } from "~/state/portSpace";
import { portForwardingBridge } from "~/state/portForwarding";
import { useEnvironmentPresentation } from "~/state/presentation";
import { previewEnvironment } from "~/state/preview";
import { useEnvironmentQuery } from "~/state/query";
import { resolveThreadRouteRef } from "~/threadRoutes";

const NO_LISTENERS: ReadonlyArray<PortSpaceListener> = [];

/**
 * Tells desktop main which thread this window has selected and which ports
 * that thread listens on. Main forwards them to this machine's localhost while
 * this is the most recently focused window.
 */
export function PortForwardingCoordinator() {
  const enabled = useClientSettings((settings) => settings.portForwardingEnabled);
  const route = resolveThreadRouteRef(useParams({ strict: false }));
  // Settings and other pages keep the thread last opened, so looking at
  // forwarding status does not change what localhost reaches.
  const [selected, setSelected] = useState(route);
  if (
    route !== null &&
    (route.environmentId !== selected?.environmentId || route.threadId !== selected.threadId)
  ) {
    setSelected(route);
  }

  const environmentId = enabled ? (selected?.environmentId ?? null) : null;
  const connected =
    useEnvironmentPresentation(environmentId).presentation?.connection.phase === "connected";
  const portSpacesEnabled = usePortSpacesEnabled(environmentId);
  // Disconnecting releases the ports; reconnecting forwards them again.
  const target =
    selected !== null && environmentId !== null && connected && portSpacesEnabled
      ? { environmentId, threadId: selected.threadId }
      : null;
  useHoldPortSpaceTunnel(target?.environmentId ?? null);
  const listeners =
    useEnvironmentQuery(
      target === null
        ? null
        : previewEnvironment.portSpaceListeners({
            environmentId: target.environmentId,
            input: { threadId: target.threadId },
          }),
    ).data?.listeners ?? null;

  const lastListeners = useRef(NO_LISTENERS);
  const targetEnvironmentId = target?.environmentId ?? null;
  const targetThreadId = target?.threadId ?? null;
  // oxlint-disable-next-line t3code/react-effect-budget -- pushes the active thread's listeners to the desktop shell, an external system
  useEffect(() => {
    let input: DesktopPortForwardingInput = null;
    if (targetEnvironmentId !== null && targetThreadId !== null) {
      // Until the newly selected thread reports its own ports, keep the ports
      // already bound and point them at it, so a port both threads serve
      // switches without being released.
      const next = listeners ?? lastListeners.current;
      lastListeners.current = next;
      input = { environmentId: targetEnvironmentId, threadId: targetThreadId, listeners: next };
    }
    void portForwardingBridge?.setPortForwarding?.(input).catch(() => undefined);
  }, [targetEnvironmentId, targetThreadId, listeners]);

  return null;
}
