import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { type EnvironmentId, type ScopedThreadRef, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { recordThreadVisit, resolveLastThread, type ThreadVisits } from "./lastThread";

const threadA = scopeThreadRef("env-1" as EnvironmentId, ThreadId.make("thread-A"));
const threadB = scopeThreadRef("env-1" as EnvironmentId, ThreadId.make("thread-B"));
// Same thread id on another environment is a different thread.
const remoteA = scopeThreadRef("env-2" as EnvironmentId, ThreadId.make("thread-A"));

function visit(...refs: ReadonlyArray<ScopedThreadRef | null>): ThreadVisits {
  return refs.reduce(recordThreadVisit, { current: null, previous: null });
}

describe("last thread", () => {
  it("toggles between the two most recent threads", () => {
    let visits = visit(threadA, threadB);
    expect(resolveLastThread(visits, threadB)).toEqual(threadA);

    visits = recordThreadVisit(visits, threadA);
    expect(resolveLastThread(visits, threadA)).toEqual(threadB);

    visits = recordThreadVisit(visits, threadB);
    expect(resolveLastThread(visits, threadB)).toEqual(threadA);
  });

  it("has no target before a second thread opens", () => {
    expect(resolveLastThread(visit(threadA), threadA)).toBeNull();
    expect(resolveLastThread(visit(threadA, threadA), threadA)).toBeNull();
  });

  it("skips pages that are not threads", () => {
    const visits = visit(threadA, null, threadB);
    expect(resolveLastThread(visits, threadB)).toEqual(threadA);
  });

  it("returns to the thread last open from a page that is not a thread", () => {
    const visits = visit(threadA, threadB, null);
    expect(resolveLastThread(visits, null)).toEqual(threadB);
  });

  it("tells threads on different environments apart", () => {
    const visits = visit(threadA, remoteA);
    expect(resolveLastThread(visits, remoteA)).toEqual(threadA);
  });
});
