import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it, vi } from "@effect/vitest";
import {
  GitCommandError,
  type VcsCreateWorktreeInput,
  type VcsRemoveWorktreeInput,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as ServerSettings from "../serverSettings.ts";
import type * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as GitWorkflow from "./GitWorkflowService.ts";
import * as WorktreeManager from "./WorktreeManager.ts";
import * as WorktreePool from "./WorktreePool.ts";

const repo = "/repos/app";
const otherRepo = "/repos/other";

// Where the fake driver moves a worktree released at `path`.
const parkedOf = (path: string) => `${path}.parked`;

const gitFailure = (operation: string) =>
  new GitCommandError({ operation, command: "git", cwd: repo, detail: "simulated failure" });

interface HarnessOptions {
  readonly reuse?: { enabled?: boolean; maxStandby?: number; standbyHours?: number };
  readonly parkFails?: boolean;
  readonly reuseFails?: boolean;
}

function makeHarness(options: HarnessOptions = {}) {
  const createWorktree = vi.fn((input: VcsCreateWorktreeInput) =>
    Effect.succeed({
      worktree: {
        path: input.path ?? `/fresh/${input.newRefName ?? input.refName}`,
        refName: input.newRefName ?? input.refName,
      },
    }),
  );
  const reuseWorktree = vi.fn((input: GitVcsDriver.ReuseWorktreeInput) =>
    options.reuseFails
      ? Effect.fail(gitFailure("reuseWorktree"))
      : Effect.succeed({
          worktree: {
            path: input.path ?? `/claimed/${input.newRefName ?? input.refName}`,
            refName: input.newRefName ?? input.refName,
          },
        }),
  );
  const parkWorktree = vi.fn(
    (input: { readonly cwd: string; readonly path: string; readonly discardChanges?: boolean }) =>
      options.parkFails
        ? Effect.fail(gitFailure("parkWorktree"))
        : Effect.succeed({ path: parkedOf(input.path) }),
  );
  let removalsFail = false;
  const removeWorktree = vi.fn((_input: VcsRemoveWorktreeInput) =>
    removalsFail ? Effect.fail(gitFailure("removeWorktree")) : Effect.void,
  );

  const layer = WorktreeManager.layer.pipe(
    Layer.provideMerge(WorktreePool.layer),
    Layer.provideMerge(
      Layer.mergeAll(
        Layer.mock(GitWorkflow.GitWorkflowService)({
          createWorktree,
          reuseWorktree,
          parkWorktree,
          removeWorktree,
        } satisfies Partial<GitWorkflow.GitWorkflowService["Service"]>),
        ServerSettings.layerTest({ worktreeReuse: { enabled: true, ...options.reuse } }),
        NodeServices.layer,
        SqlitePersistenceMemory,
      ),
    ),
  );

  return {
    layer,
    createWorktree,
    reuseWorktree,
    parkWorktree,
    removeWorktree,
    failRemovals: (fail: boolean) => {
      removalsFail = fail;
    },
  };
}

const makeDir = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* fileSystem.makeTempDirectoryScoped({ prefix: "worktree-standby-" });
  // The mocked driver does not move anything, so the parked directory is made up front.
  yield* fileSystem.makeDirectory(parkedOf(path), { recursive: true });
  yield* Effect.addFinalizer(() =>
    fileSystem.remove(parkedOf(path), { recursive: true, force: true }).pipe(Effect.ignore),
  );
  return path;
});

const standbyPaths = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ readonly path: string }>`
    SELECT path FROM worktree_standby ORDER BY released_at_ms
  `;
  return rows.map((row) => row.path);
});

// Each release lands one second after the previous so recency order is deterministic.
const release = (path: string, cwd = repo) =>
  Effect.gen(function* () {
    const manager = yield* WorktreeManager.WorktreeManager;
    yield* TestClock.adjust("1 second");
    yield* manager.removeWorktree({ cwd, path, force: true, reuse: true });
  });

const launch = (newRefName: string, overrides: Partial<VcsCreateWorktreeInput> = {}) =>
  Effect.gen(function* () {
    const manager = yield* WorktreeManager.WorktreeManager;
    return yield* manager.createWorktree({
      cwd: repo,
      refName: "main",
      newRefName,
      baseRefName: "main",
      path: null,
      ...overrides,
    });
  });

const removedPaths = (harness: ReturnType<typeof makeHarness>) =>
  harness.removeWorktree.mock.calls.map(([input]) => input.path).toSorted();

const claimedFrom = (harness: ReturnType<typeof makeHarness>) =>
  harness.reuseWorktree.mock.calls.map(([input]) => input.standbyPath);

it.effect("parks a released worktree and hands it to the next launch", () => {
  const harness = makeHarness();
  return Effect.gen(function* () {
    const path = yield* makeDir;

    yield* release(path);
    assert.deepEqual(harness.parkWorktree.mock.calls, [
      [{ cwd: repo, path, discardChanges: true }],
    ]);
    assert.equal(harness.removeWorktree.mock.calls.length, 0);
    assert.deepEqual(yield* standbyPaths, [parkedOf(path)]);

    const reused = yield* launch("feature/next");
    assert.deepEqual(reused, {
      worktree: { path: "/claimed/feature/next", refName: "feature/next" },
    });
    assert.deepEqual(harness.reuseWorktree.mock.calls[0]?.[0], {
      cwd: repo,
      standbyPath: parkedOf(path),
      refName: "main",
      newRefName: "feature/next",
      baseRefName: "main",
      path: null,
    });
    assert.equal(harness.createWorktree.mock.calls.length, 0);
    assert.deepEqual(yield* standbyPaths, []);

    yield* launch("feature/after");
    assert.equal(harness.createWorktree.mock.calls.length, 1);
  }).pipe(Effect.provide(harness.layer));
});

it.effect("reuses the most recently released worktree of the same repository", () => {
  const harness = makeHarness();
  return Effect.gen(function* () {
    const older = yield* makeDir;
    const newer = yield* makeDir;
    const elsewhere = yield* makeDir;

    yield* release(older);
    yield* release(newer);
    yield* release(elsewhere, otherRepo);

    yield* launch("feature/a");
    yield* launch("feature/b");
    yield* launch("feature/c");
    assert.deepEqual(claimedFrom(harness), [parkedOf(newer), parkedOf(older)]);
    assert.equal(harness.createWorktree.mock.calls.length, 1);
    assert.deepEqual(yield* standbyPaths, [parkedOf(elsewhere)]);
  }).pipe(Effect.provide(harness.layer));
});

it.effect("reuses a standby worktree to check out an existing branch", () => {
  const harness = makeHarness();
  return Effect.gen(function* () {
    const path = yield* makeDir;
    yield* release(path);

    const manager = yield* WorktreeManager.WorktreeManager;
    const reused = yield* manager.createWorktree({ cwd: repo, refName: "feature/x", path: null });

    assert.deepEqual(reused, { worktree: { path: "/claimed/feature/x", refName: "feature/x" } });
    assert.deepEqual(harness.reuseWorktree.mock.calls[0]?.[0], {
      cwd: repo,
      standbyPath: parkedOf(path),
      refName: "feature/x",
      path: null,
    });
    assert.equal(harness.createWorktree.mock.calls.length, 0);
  }).pipe(Effect.provide(harness.layer));
});

it.effect("reuses a standby worktree at a location the caller chose", () => {
  const harness = makeHarness();
  return Effect.gen(function* () {
    const path = yield* makeDir;
    yield* release(path);

    const reused = yield* launch("feature/pinned", { path: "/somewhere/else" });

    assert.equal(reused.worktree.path, "/somewhere/else");
    assert.deepEqual(claimedFrom(harness), [parkedOf(path)]);
    assert.equal(harness.reuseWorktree.mock.calls[0]?.[0].path, "/somewhere/else");
    assert.equal(harness.createWorktree.mock.calls.length, 0);
  }).pipe(Effect.provide(harness.layer));
});

it.effect("removes instead of parking unless reuse is both enabled and requested", () => {
  const disabled = makeHarness({ reuse: { enabled: false } });
  const enabled = makeHarness();
  return Effect.gen(function* () {
    const path = yield* makeDir;

    yield* release(path);
    assert.equal(disabled.parkWorktree.mock.calls.length, 0);
    assert.deepEqual(removedPaths(disabled), [path]);
    assert.deepEqual(yield* standbyPaths, []);

    yield* launch("feature/fresh");
    assert.equal(disabled.reuseWorktree.mock.calls.length, 0);
    assert.equal(disabled.createWorktree.mock.calls.length, 1);
  }).pipe(
    Effect.provide(disabled.layer),
    Effect.andThen(
      Effect.gen(function* () {
        const path = yield* makeDir;
        const manager = yield* WorktreeManager.WorktreeManager;

        yield* manager.removeWorktree({ cwd: repo, path, force: true });
        assert.equal(enabled.parkWorktree.mock.calls.length, 0);
        assert.deepEqual(removedPaths(enabled), [path]);
        assert.deepEqual(yield* standbyPaths, []);
      }).pipe(Effect.provide(enabled.layer)),
    ),
  );
});

it.effect("evicts the least recently released worktrees beyond the per-repository cap", () => {
  const harness = makeHarness({ reuse: { maxStandby: 2 } });
  return Effect.gen(function* () {
    const [first, second, third, other] = [
      yield* makeDir,
      yield* makeDir,
      yield* makeDir,
      yield* makeDir,
    ];

    yield* release(first);
    yield* release(other, otherRepo);
    yield* release(second);
    assert.deepEqual(harness.removeWorktree.mock.calls.length, 0);

    yield* release(third);
    assert.deepEqual(harness.removeWorktree.mock.calls, [
      [{ cwd: repo, path: parkedOf(first), force: true }],
    ]);
    assert.deepEqual(
      (yield* standbyPaths).toSorted(),
      [other, second, third].map(parkedOf).toSorted(),
    );
  }).pipe(Effect.provide(harness.layer));
});

it.effect("sweeps worktrees that outlive the standby time", () => {
  const harness = makeHarness({ reuse: { standbyHours: 2 } });
  return Effect.gen(function* () {
    const manager = yield* WorktreeManager.WorktreeManager;
    const stale = yield* makeDir;
    const fresh = yield* makeDir;

    yield* release(stale);
    yield* TestClock.adjust("90 minutes");
    yield* release(fresh);
    yield* manager.sweep;
    assert.equal(harness.removeWorktree.mock.calls.length, 0);

    yield* TestClock.adjust("45 minutes");
    yield* manager.sweep;
    assert.deepEqual(harness.removeWorktree.mock.calls, [
      [{ cwd: repo, path: parkedOf(stale), force: true }],
    ]);
    assert.deepEqual(yield* standbyPaths, [parkedOf(fresh)]);
  }).pipe(Effect.provide(harness.layer));
});

it.effect("keeps a standby worktree that fails to remove queued and retries it", () => {
  const harness = makeHarness({ reuse: { maxStandby: 1 } });
  return Effect.gen(function* () {
    const manager = yield* WorktreeManager.WorktreeManager;
    const [first, second] = [yield* makeDir, yield* makeDir];

    yield* release(first);
    harness.failRemovals(true);
    yield* release(second);
    assert.deepEqual(removedPaths(harness), [parkedOf(first)]);
    assert.deepEqual(yield* standbyPaths, [parkedOf(first), parkedOf(second)]);

    // The failed one is out of the pool: it is never handed to a launch.
    yield* launch("feature/next");
    assert.deepEqual(claimedFrom(harness), [parkedOf(second)]);

    yield* manager.sweep;
    assert.deepEqual(removedPaths(harness), [parkedOf(first), parkedOf(first)]);
    assert.deepEqual(yield* standbyPaths, [parkedOf(first)]);

    harness.failRemovals(false);
    yield* manager.sweep;
    assert.deepEqual(removedPaths(harness), [parkedOf(first), parkedOf(first), parkedOf(first)]);
    assert.deepEqual(yield* standbyPaths, []);
  }).pipe(Effect.provide(harness.layer));
});

it.effect("queues a claimed worktree that fails both to reuse and to remove", () => {
  const harness = makeHarness({ reuseFails: true });
  return Effect.gen(function* () {
    const manager = yield* WorktreeManager.WorktreeManager;
    const path = yield* makeDir;
    yield* release(path);

    harness.failRemovals(true);
    const result = yield* launch("feature/next");
    assert.equal(result.worktree.path, "/fresh/feature/next");
    assert.deepEqual(yield* standbyPaths, [parkedOf(path)]);

    harness.failRemovals(false);
    yield* manager.sweep;
    assert.deepEqual(yield* standbyPaths, []);
    assert.equal(harness.removeWorktree.mock.calls.length, 2);
  }).pipe(Effect.provide(harness.layer));
});

it.effect("removes every standby worktree once reuse is disabled", () => {
  const harness = makeHarness();
  return Effect.gen(function* () {
    const manager = yield* WorktreeManager.WorktreeManager;
    const settings = yield* ServerSettings.ServerSettingsService;
    const a = yield* makeDir;
    const b = yield* makeDir;
    yield* release(a);
    yield* release(b, otherRepo);

    yield* manager.sweep;
    assert.equal(harness.removeWorktree.mock.calls.length, 0);

    yield* settings.updateSettings({ worktreeReuse: { enabled: false } });
    yield* manager.sweep;
    assert.deepEqual(removedPaths(harness), [a, b].map(parkedOf).toSorted());
    assert.deepEqual(yield* standbyPaths, []);
  }).pipe(Effect.provide(harness.layer));
});

it.effect("removes the worktree when it cannot be parked", () => {
  const harness = makeHarness({ parkFails: true });
  return Effect.gen(function* () {
    const path = yield* makeDir;

    yield* release(path);
    assert.deepEqual(harness.removeWorktree.mock.calls, [
      [{ cwd: repo, path, force: true, reuse: true }],
    ]);
    assert.deepEqual(yield* standbyPaths, []);
  }).pipe(Effect.provide(harness.layer));
});

it.effect("parks an unforced release without discarding changes", () => {
  const harness = makeHarness();
  return Effect.gen(function* () {
    const manager = yield* WorktreeManager.WorktreeManager;
    const path = yield* makeDir;

    yield* manager.removeWorktree({ cwd: repo, path, reuse: true });
    assert.deepEqual(harness.parkWorktree.mock.calls, [
      [{ cwd: repo, path, discardChanges: false }],
    ]);
    assert.equal(harness.removeWorktree.mock.calls.length, 0);
    assert.deepEqual(yield* standbyPaths, [parkedOf(path)]);
  }).pipe(Effect.provide(harness.layer));
});

it.effect("leaves a worktree that refuses to park to the plain removal", () => {
  const harness = makeHarness({ parkFails: true });
  return Effect.gen(function* () {
    const manager = yield* WorktreeManager.WorktreeManager;
    const path = yield* makeDir;

    yield* manager.removeWorktree({ cwd: repo, path, reuse: true });
    assert.deepEqual(harness.removeWorktree.mock.calls, [[{ cwd: repo, path, reuse: true }]]);
    assert.deepEqual(yield* standbyPaths, []);
  }).pipe(Effect.provide(harness.layer));
});

it.effect("discards a standby worktree that fails to reuse and creates a fresh one", () => {
  const harness = makeHarness({ reuseFails: true });
  return Effect.gen(function* () {
    const path = yield* makeDir;
    yield* release(path);

    const result = yield* launch("feature/next");
    assert.equal(result.worktree.path, "/fresh/feature/next");
    assert.deepEqual(harness.removeWorktree.mock.calls, [
      [{ cwd: repo, path: parkedOf(path), force: true }],
    ]);
    assert.deepEqual(yield* standbyPaths, []);
  }).pipe(Effect.provide(harness.layer));
});

it.effect("skips a standby worktree whose directory is gone", () => {
  const harness = makeHarness();
  return Effect.gen(function* () {
    const present = yield* makeDir;
    // Parked in the pool's books, but its directory was never there.
    const missing = `${present}-gone`;
    yield* release(present);
    yield* release(missing);

    yield* launch("feature/next");
    assert.deepEqual(claimedFrom(harness), [parkedOf(present)]);
    assert.deepEqual(yield* standbyPaths, []);
  }).pipe(Effect.provide(harness.layer));
});

it.effect("hands each standby worktree to exactly one concurrent launch", () => {
  const harness = makeHarness();
  return Effect.gen(function* () {
    const paths = [yield* makeDir, yield* makeDir];
    for (const path of paths) yield* release(path);

    yield* Effect.forEach([1, 2, 3, 4], (index) => launch(`feature/${index}`), {
      concurrency: "unbounded",
    });
    assert.deepEqual(claimedFrom(harness).toSorted(), paths.map(parkedOf).toSorted());
    assert.equal(harness.createWorktree.mock.calls.length, 2);
    assert.deepEqual(yield* standbyPaths, []);
  }).pipe(Effect.provide(harness.layer));
});
