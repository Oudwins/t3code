import { threadHasRunningChecks } from "@t3tools/shared/threadPullRequests";

import { threadRuntimeIsActive, type EnvironmentThreadShell } from "./models.ts";
import { toSortableTimestamp } from "./threadSort.ts";

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

/**
 * Remembers when this client saw each thread leave the Working section, or
 * whichever shelves `isOffInbox` names. Keep one at module scope so the inbox
 * order survives routes that unmount the list. Call `observe` with every
 * thread shell on each list rebuild, or with null to reset while the beta is
 * off. The first call only takes a baseline, so mounting never reshuffles the
 * inbox.
 */
export function createInboxReturnTracker<
  T extends WorkingThreadInput & InboxThreadInput = WorkingThreadInput & InboxThreadInput,
>(isOffInbox: (thread: T) => boolean = isThreadWorking) {
  const keyOf = (thread: Pick<EnvironmentThreadShell, "environmentId" | "id">) =>
    `${thread.environmentId}:${thread.id}`;
  let lastWorkingKeys: ReadonlySet<string> | null = null;
  const returns = new Map<string, number>();
  return {
    observe(threads: ReadonlyArray<T> | null): void {
      if (threads === null) {
        lastWorkingKeys = null;
        returns.clear();
        return;
      }
      const working = new Set<string>();
      const present = new Set<string>();
      for (const thread of threads) {
        const key = keyOf(thread);
        present.add(key);
        if (isOffInbox(thread)) working.add(key);
      }
      for (const key of returns.keys()) {
        if (!present.has(key)) returns.delete(key);
      }
      // @effect-diagnostics-next-line globalDate:off
      const at = Date.now();
      for (const key of lastWorkingKeys ?? []) {
        if (present.has(key) && !working.has(key)) returns.set(key, at);
      }
      lastWorkingKeys = working;
    },
    returnedAt: (thread: Pick<EnvironmentThreadShell, "environmentId" | "id">) =>
      returns.get(keyOf(thread)),
  };
}
