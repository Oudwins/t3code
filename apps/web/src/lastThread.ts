import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";

import { readThreadShell } from "./state/entities";

export interface ThreadVisits {
  readonly current: ScopedThreadRef | null;
  readonly previous: ScopedThreadRef | null;
}

/**
 * Pages that are not a thread (Settings, a draft) leave the pair alone, so
 * A → Settings → B still goes back to A.
 */
export function recordThreadVisit(
  visits: ThreadVisits,
  threadRef: ScopedThreadRef | null,
): ThreadVisits {
  if (threadRef === null) return visits;
  if (visits.current !== null && scopedThreadKey(visits.current) === scopedThreadKey(threadRef)) {
    return visits;
  }
  return { current: threadRef, previous: visits.current };
}

/** Away from a thread page, the thread to go back to is the one last open. */
export function resolveLastThread(
  visits: ThreadVisits,
  routeThreadRef: ScopedThreadRef | null,
): ScopedThreadRef | null {
  return routeThreadRef === null ? visits.current : visits.previous;
}

// Per window on purpose: a visit on another device must not move this target.
let threadVisits: ThreadVisits = { current: null, previous: null };

export function noteThreadVisit(threadRef: ScopedThreadRef | null): void {
  threadVisits = recordThreadVisit(threadVisits, threadRef);
}

/** Null when there is no earlier thread or it has since been deleted. */
export function readLastThread(routeThreadRef: ScopedThreadRef | null): ScopedThreadRef | null {
  const target = resolveLastThread(threadVisits, routeThreadRef);
  return target !== null && readThreadShell(target) !== null ? target : null;
}
