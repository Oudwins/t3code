// @effect-diagnostics globalTimers:off - Shelf placement timers run in web and native clients, outside an Effect runtime.
import { threadHasRunningChecks } from "@t3tools/shared/threadPullRequests";

import { threadRuntimeIsActive, type EnvironmentThreadShell } from "./models.ts";
import { toSortableTimestamp } from "./threadSort.ts";
import { effectiveSnoozed } from "./threadSettled.ts";

type WorkingThreadInput = Pick<
  EnvironmentThreadShell,
  | "hasActionableProposedPlan"
  | "hasPendingApprovals"
  | "hasPendingUserInput"
  | "pendingSubagentRequest"
  | "interactionMode"
  | "latestRun"
  | "runtime"
>;

function needsUser(thread: WorkingThreadInput): boolean {
  if (thread.hasPendingApprovals || thread.hasPendingUserInput) return true;
  if (thread.pendingSubagentRequest != null) return true;
  const run = thread.latestRun;
  const runSettled =
    run !== null &&
    run.status !== "preparing" &&
    run.status !== "queued" &&
    run.status !== "starting" &&
    run.status !== "running" &&
    run.status !== "waiting" &&
    thread.runtime?.activeRunId !== run.runId;
  return thread.interactionMode === "plan" && thread.hasActionableProposedPlan && runSettled;
}

/** Threads busy with work that does not need the user fold into the Working
    section: a running run, or one stopped with background work that will wake
    it. Approvals, questions (its own or a subagent's), plan prompts, and
    failures stay in the inbox. */
export function isThreadWorking(thread: WorkingThreadInput): boolean {
  if (!threadRuntimeIsActive(thread.runtime) && thread.runtime?.status !== "idle") return false;
  return !needsUser(thread);
}

type WaitingThreadInput = WorkingThreadInput & Pick<EnvironmentThreadShell, "pullRequests">;

/** Threads that have stopped but will come back without the user: background
    work that wakes the agent, or checks still running on a linked pull
    request. Anything the user has to act on stays in the inbox. Clients that
    only have a Working section keep folding the background-work case there
    through `isThreadWorking`. */
export function isThreadWaiting(thread: WaitingThreadInput): boolean {
  if (threadRuntimeIsActive(thread.runtime) || needsUser(thread)) return false;
  if (thread.runtime?.status === "idle") return true;
  if (thread.runtime?.status === "failed") return false;
  return threadHasRunningChecks(thread.pullRequests);
}

type InboxThreadInput = Pick<
  EnvironmentThreadShell,
  "id" | "environmentId" | "createdAt" | "unsettledAt" | "latestRun"
>;

export function sortInboxThreadsByReturn<T extends InboxThreadInput>(
  threads: readonly T[],
  observedReturnAt?: (thread: T) => number | undefined,
): T[] {
  const timestamps = new Map(
    threads.map((thread) => [
      thread,
      Math.max(
        toSortableTimestamp(thread.createdAt) ?? 0,
        toSortableTimestamp(thread.unsettledAt ?? undefined) ?? 0,
        toSortableTimestamp(thread.latestRun?.requestedAt ?? undefined) ?? 0,
        toSortableTimestamp(thread.latestRun?.completedAt ?? undefined) ?? 0,
        observedReturnAt?.(thread) ?? 0,
      ),
    ]),
  );
  return sortNewestFirst(threads, timestamps);
}

type WorkingSortInput = Pick<
  EnvironmentThreadShell,
  "id" | "environmentId" | "createdAt" | "latestRun" | "latestUserAuthoredMessageAt"
>;

export function sortWorkingThreadsBySend<T extends WorkingSortInput>(threads: readonly T[]): T[] {
  const timestamps = new Map(
    threads.map((thread) => [
      thread,
      Math.max(
        toSortableTimestamp(thread.createdAt) ?? 0,
        toSortableTimestamp(
          (thread.latestUserAuthoredMessageAt === undefined
            ? thread.latestRun?.requestedAt
            : thread.latestUserAuthoredMessageAt) ?? undefined,
        ) ?? 0,
      ),
    ]),
  );
  return sortNewestFirst(threads, timestamps);
}

function sortNewestFirst<T extends Pick<EnvironmentThreadShell, "id" | "environmentId">>(
  threads: readonly T[],
  timestamps: ReadonlyMap<T, number>,
): T[] {
  return [...threads].sort(
    (left, right) =>
      timestamps.get(right)! - timestamps.get(left)! ||
      left.id.localeCompare(right.id) ||
      left.environmentId.localeCompare(right.environmentId),
  );
}

type TrackedInboxThread = WorkingThreadInput &
  InboxThreadInput &
  Partial<
    Pick<
      EnvironmentThreadShell,
      | "archivedAt"
      | "deletedAt"
      | "pinnedAt"
      | "settledOverride"
      | "settledAt"
      | "snoozedAt"
      | "snoozedUntil"
      | "activeOrderKey"
      | "pendingGuestMessageCount"
    >
  >;

type ThreadKeyInput = Pick<EnvironmentThreadShell, "environmentId" | "id">;

/**
 * How long a thread that stopped working keeps reading as working. An orchestrator
 * run can end moments before its continuation starts, so clients wait this long
 * before treating the thread as done.
 */
export const WORKING_EXIT_GRACE_MS = 2_000;

/**
 * Tracks threads off the inbox: the Working section, or whichever shelves
 * `isOffInbox` names, and when each returned. Keep one at module scope so placement
 * survives routes that unmount the list. Call `observe` when the shells or the
 * snapshot version change, or with null while the beta is off. Its result stays
 * fixed, so a list built from it can be cached.
 */
export function createInboxReturnTracker<T extends TrackedInboxThread = TrackedInboxThread>(
  isOffInbox: (thread: T) => boolean = isThreadWorking,
) {
  const keyOf = (thread: ThreadKeyInput) => `${thread.environmentId}:${thread.id}`;
  const states = new Map<
    string,
    { working: boolean; deadline: number | null; placement: string }
  >();
  const returns = new Map<string, number>();
  const listeners = new Set<() => void>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let version = 0;
  const now = () => {
    // @effect-diagnostics-next-line globalDate:off - The grace deadline is wall-clock time shared by web and native clients.
    return Date.now();
  };
  const schedule = () => {
    clearTimeout(timer);
    timer = undefined;
    let next = Infinity;
    for (const state of states.values()) {
      if (state.deadline !== null) next = Math.min(next, state.deadline);
    }
    if (next === Infinity) return;
    timer = setTimeout(
      () => {
        const at = now();
        for (const [key, state] of states) {
          if (state.deadline !== null && state.deadline <= at) {
            state.working = false;
            state.deadline = null;
            returns.set(key, at);
          }
        }
        schedule();
        version++;
        for (const listener of listeners) listener();
      },
      Math.max(0, next - now()),
    );
  };
  return {
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getSnapshot: () => version,
    observe(threads: readonly T[] | null): {
      readonly isWorking: (thread: T) => boolean;
      readonly returnedAt: (thread: ThreadKeyInput) => number | undefined;
    } {
      if (threads === null) {
        clearTimeout(timer);
        timer = undefined;
        states.clear();
        returns.clear();
        return { isWorking: isOffInbox, returnedAt: () => undefined };
      }
      const present = new Set<string>();
      const at = now();
      // @effect-diagnostics-next-line globalDate:off - Snooze checks compare wall-clock ISO times.
      const observedAt = new Date(at).toISOString();
      for (const thread of threads) {
        const key = keyOf(thread);
        present.add(key);
        const placement = JSON.stringify([
          thread.archivedAt,
          thread.deletedAt,
          thread.pinnedAt,
          thread.settledOverride,
          thread.settledAt,
          thread.snoozedAt,
          thread.snoozedUntil,
          thread.activeOrderKey,
        ]);
        const previous = states.get(key);
        const actionable =
          thread.hasPendingApprovals ||
          thread.hasPendingUserInput ||
          thread.pendingSubagentRequest != null ||
          (thread.pendingGuestMessageCount ?? 0) > 0 ||
          (thread.interactionMode === "plan" && thread.hasActionableProposedPlan) ||
          thread.runtime?.lastError != null ||
          thread.latestRun?.status === "failed";
        const moved = previous !== undefined && previous.placement !== placement;
        const excluded =
          thread.archivedAt != null ||
          thread.deletedAt != null ||
          thread.pinnedAt != null ||
          thread.settledOverride === "settled" ||
          effectiveSnoozed(thread, { now: observedAt });
        const actual = isOffInbox(thread);
        // Only shelf placement is held: execution state and attention requests stay authoritative.
        const deadline =
          !actual && previous?.working && !actionable && !moved && !excluded
            ? (previous.deadline ?? at + WORKING_EXIT_GRACE_MS)
            : null;
        const working = actual || (deadline !== null && deadline > at);
        if (previous?.working && !working) returns.set(key, at);
        states.set(key, { working, deadline: working ? deadline : null, placement });
      }
      for (const key of states.keys()) {
        if (!present.has(key)) {
          states.delete(key);
          returns.delete(key);
        }
      }
      schedule();
      const observedWorking = new Map([...states].map(([key, state]) => [key, state.working]));
      const observedReturns = new Map(returns);
      return {
        isWorking: (thread) => observedWorking.get(keyOf(thread)) ?? isOffInbox(thread),
        returnedAt: (thread) => observedReturns.get(keyOf(thread)),
      };
    },
    isWorking: (thread: T) => states.get(keyOf(thread))?.working ?? isOffInbox(thread),
    returnedAt: (thread: ThreadKeyInput) => returns.get(keyOf(thread)),
  };
}
