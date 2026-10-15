import { useAtomValue } from "@effect/atom-react";
import { resolvePortSpaceTunnelAccess } from "@t3tools/client-runtime/state/portSpaceTunnel";
import type { EnvironmentId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { AsyncResult, Atom } from "effect/reactivity";

import { previewBridge } from "~/components/preview/previewBridge";

import { connectionAtomRuntime } from "../connection/runtime";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { serverEnvironment } from "./server";
import { environmentSession } from "./session";

// Tickets live five minutes server-side; renewing sooner keeps one always valid.
const TUNNEL_RENEW_INTERVAL = "4 minutes";

const portSpacesEnabledAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.make(
    (get) => get(serverEnvironment.settingsValueAtom(environmentId))?.enablePortSpaces === true,
  ).pipe(Atom.withLabel(`port-spaces:enabled:${environmentId}`)),
);

const DISABLED_ATOM = Atom.make(false).pipe(Atom.withLabel("port-spaces:enabled:none"));

export function usePortSpacesEnabled(environmentId: EnvironmentId | null): boolean {
  return useAtomValue(
    environmentId === null ? DISABLED_ATOM : portSpacesEnabledAtom(environmentId),
  );
}

export function readPortSpacesEnabled(environmentId: EnvironmentId): boolean {
  return appAtomRegistry.get(portSpacesEnabledAtom(environmentId));
}

/**
 * Keeps desktop main supplied with a current tunnel ticket for one environment
 * for as long as the atom is mounted. Each element is whether a ticket reached
 * main; a failed attempt leaves loopback requests failing closed, and the next
 * renewal tries again.
 */
const portSpaceTunnelAtom = Atom.family((environmentId: EnvironmentId) =>
  connectionAtomRuntime
    .atom((get) => {
      const prepared = Option.getOrNull(
        get(environmentSession.preparedConnectionValueAtom(environmentId)),
      );
      const bridge = previewBridge;
      if (prepared === null || bridge === null) return Stream.never;
      return Stream.fromEffectSchedule(
        resolvePortSpaceTunnelAccess({ prepared }).pipe(
          Effect.flatMap((access) =>
            Effect.tryPromise(() => bridge.setPortSpaceTunnel({ environmentId, access })),
          ),
          Effect.match({ onFailure: () => false, onSuccess: () => true }),
        ),
        Schedule.spaced(TUNNEL_RENEW_INTERVAL),
      );
    })
    .pipe(Atom.setIdleTTL(60_000), Atom.withLabel(`port-spaces:tunnel:${environmentId}`)),
);

const IDLE_TUNNEL_ATOM = Atom.make(AsyncResult.initial<boolean, never>()).pipe(
  Atom.withLabel("port-spaces:tunnel:none"),
);

/** False until the first ticket attempt settles, so a preview never starts without one. */
export function usePortSpaceTunnelSettled(
  environmentId: EnvironmentId,
  portSpacesEnabled: boolean,
): boolean {
  const result = useAtomValue(
    portSpacesEnabled ? portSpaceTunnelAtom(environmentId) : IDLE_TUNNEL_ATOM,
  );
  return !portSpacesEnabled || !AsyncResult.isInitial(result);
}
