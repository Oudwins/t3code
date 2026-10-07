import { EnvironmentId, ProviderInstanceId, RunId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  createInboxReturnTracker,
  isThreadWaiting,
  isThreadWorking,
  sortWorkingThreadsBySend,
} from "./threadInbox.ts";

const environmentId = EnvironmentId.make("environment-1");

function thread(id: string, working: boolean) {
  return {
    id: ThreadId.make(id),
    environmentId,
    createdAt: "2026-06-01T00:00:00.000Z",
    unsettledAt: null,
    latestRun: null,
    hasActionableProposedPlan: false,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    interactionMode: "default" as const,
    runtime: working
      ? {
          status: "running" as const,
          activeRunId: null,
          providerInstanceId: ProviderInstanceId.make("codex"),
          providerName: "Codex",
          lastError: null,
          updatedAt: "2026-06-01T00:00:00.000Z",
        }
      : null,
  };
}

const runtimeAt = (status: "running" | "idle" | "failed" | "completed") => ({
  status,
  activeRunId: null,
  providerInstanceId: ProviderInstanceId.make("codex"),
  providerName: "Codex",
  lastError: null,
  updatedAt: "2026-06-01T00:00:00.000Z",
});

const pullRequest = (checksState: "pending" | "passing", state: "open" | "merged" = "open") =>
  ({ source: "agent", snapshot: { state, checksState } }) as never;

describe("isThreadWaiting", () => {
  const base = { ...thread("a", false), pullRequests: [] as never[] };

  it("covers a stopped thread with background work, and not a running one", () => {
    expect(isThreadWaiting({ ...base, runtime: runtimeAt("idle") })).toBe(true);
    expect(isThreadWaiting({ ...base, runtime: runtimeAt("running") })).toBe(false);
  });

  it("covers a finished thread while its linked pull request has checks running", () => {
    const pending = { ...base, pullRequests: [pullRequest("pending")] };
    expect(isThreadWaiting({ ...pending, runtime: runtimeAt("completed") })).toBe(true);
    expect(isThreadWaiting({ ...pending, runtime: null })).toBe(true);
    expect(isThreadWaiting({ ...base, pullRequests: [pullRequest("passing")] })).toBe(false);
    expect(isThreadWaiting({ ...pending, pullRequests: [pullRequest("pending", "merged")] })).toBe(
      false,
    );
  });

  it("leaves anything the user has to act on in the inbox", () => {
    const pending = { ...base, pullRequests: [pullRequest("pending")] };
    expect(isThreadWaiting({ ...pending, runtime: runtimeAt("failed") })).toBe(false);
    expect(isThreadWaiting({ ...pending, hasPendingApprovals: true })).toBe(false);
    expect(isThreadWaiting({ ...pending, hasPendingUserInput: true })).toBe(false);
    expect(
      isThreadWaiting({
        ...pending,
        interactionMode: "plan",
        hasActionableProposedPlan: true,
        latestRun: { runId: RunId.make("run-1"), status: "completed" } as never,
      }),
    ).toBe(false);
  });

  it("does not change what the Working section folds", () => {
    expect(isThreadWorking({ ...base, runtime: runtimeAt("idle") })).toBe(true);
    const pending = { ...base, pullRequests: [pullRequest("pending")], runtime: null };
    expect(isThreadWorking(pending)).toBe(false);
  });
});

describe("createInboxReturnTracker", () => {
  it("stamps a thread when it leaves the shelves the predicate names", () => {
    const waiting = (id: string, isWaiting: boolean) => ({
      ...thread(id, false),
      pullRequests: isWaiting ? [pullRequest("pending")] : [pullRequest("passing")],
    });
    const tracker = createInboxReturnTracker<ReturnType<typeof waiting>>(isThreadWaiting);
    tracker.observe([waiting("a", true)]);
    tracker.observe([waiting("a", false)]);
    expect(tracker.returnedAt(waiting("a", false))).toBeDefined();
  });

  it("stamps a thread when it stops working, but never on the first observation", () => {
    const tracker = createInboxReturnTracker();
    tracker.observe([thread("a", true), thread("b", false)]);
    expect(tracker.returnedAt(thread("a", true))).toBeUndefined();
    expect(tracker.returnedAt(thread("b", false))).toBeUndefined();

    tracker.observe([thread("a", false), thread("b", false)]);
    expect(tracker.returnedAt(thread("a", false))).toBeDefined();
    expect(tracker.returnedAt(thread("b", false))).toBeUndefined();
  });

  it("forgets deleted threads and resets when the beta turns off", () => {
    const tracker = createInboxReturnTracker();
    tracker.observe([thread("a", true), thread("b", true)]);
    tracker.observe([thread("a", false), thread("b", false)]);
    tracker.observe([thread("b", false)]);
    expect(tracker.returnedAt(thread("a", false))).toBeUndefined();
    expect(tracker.returnedAt(thread("b", false))).toBeDefined();

    tracker.observe(null);
    expect(tracker.returnedAt(thread("b", false))).toBeUndefined();
    // After a reset the next call is a fresh baseline again.
    tracker.observe([thread("b", true)]);
    tracker.observe([thread("b", false)]);
    expect(tracker.returnedAt(thread("b", false))).toBeDefined();
  });
});

describe("sortWorkingThreadsBySend", () => {
  it("orders by the last message the user sent, not by later runs", () => {
    const sentFirst = {
      ...thread("sent-first", true),
      latestUserAuthoredMessageAt: "2026-06-01T01:00:00.000Z",
      // A wake run requested after the other thread's send.
      latestRun: {
        runId: RunId.make("run:wake"),
        status: "running" as const,
        requestedAt: "2026-06-01T04:00:00.000Z",
        startedAt: "2026-06-01T04:00:00.000Z",
        completedAt: null,
        assistantMessageId: null,
      },
    };
    const sentLast = {
      ...thread("sent-last", true),
      latestUserAuthoredMessageAt: "2026-06-01T02:00:00.000Z",
    };
    // Launched by an agent: no user message, so creation time is the send.
    const launched = { ...thread("launched", true), latestUserAuthoredMessageAt: null };
    expect(
      sortWorkingThreadsBySend([launched, sentFirst, sentLast]).map((thread) => thread.id),
    ).toEqual(["sent-last", "sent-first", "launched"]);
  });
});
