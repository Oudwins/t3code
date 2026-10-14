import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerConfig from "../config.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as WorktreeManager from "./WorktreeManager.ts";
import * as WorktreePool from "./WorktreePool.ts";

// The manager, pool and git driver are real; only the moment a reuse starts can be held back.
const BaseLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3-worktree-manager-git-test-",
}).pipe(Layer.provideMerge(NodeServices.layer));

const makeLayer = (hooks: { readonly beforeReuse?: Effect.Effect<void> } = {}) =>
  WorktreeManager.layer.pipe(
    Layer.provideMerge(WorktreePool.layer),
    Layer.provideMerge(
      Layer.mergeAll(
        Layer.effect(
          GitVcsDriver.GitVcsDriver,
          Effect.gen(function* () {
            const real = yield* GitVcsDriver.GitVcsDriver;
            return GitVcsDriver.GitVcsDriver.of({
              ...real,
              reuseWorktree: (input, options) =>
                (hooks.beforeReuse ?? Effect.void).pipe(
                  Effect.andThen(real.reuseWorktree(input, options)),
                ),
            });
          }),
        ).pipe(Layer.provide(GitVcsDriver.layer.pipe(Layer.provide(BaseLayer)))),
        Layer.mock(VcsDriverRegistry.VcsDriverRegistry)({
          resolve: () => Effect.succeed({ kind: "git" } as VcsDriverRegistry.VcsDriverHandle),
        }),
        ServerSettings.layerTest({ worktreeReuse: { enabled: true } }),
        SqlitePersistence.layerMemory,
        BaseLayer,
      ),
    ),
  );

const git = (cwd: string, args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const driver = yield* GitVcsDriver.GitVcsDriver;
    const result = yield* driver.execute({
      operation: "WorktreeManager.git.test",
      cwd,
      args,
      timeoutMs: 10_000,
    });
    return result.stdout.trim();
  });

const standbyPaths = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ readonly path: string }>`
    SELECT path FROM worktree_standby ORDER BY released_at_ms
  `;
  return rows.map((row) => row.path);
});

// A repository with one worktree parked in the pool.
const parkedWorktree = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const pathService = yield* Path.Path;
  const driver = yield* GitVcsDriver.GitVcsDriver;
  const manager = yield* WorktreeManager.WorktreeManager;

  const cwd = yield* fileSystem.makeTempDirectoryScoped({ prefix: "worktree-manager-repo-" });
  yield* driver.initRepo({ cwd });
  yield* git(cwd, ["config", "user.email", "test@test.com"]);
  yield* git(cwd, ["config", "user.name", "Test"]);
  yield* fileSystem.writeFileString(pathService.join(cwd, "README.md"), "# test\n");
  yield* git(cwd, ["add", "."]);
  yield* git(cwd, ["commit", "-m", "initial commit"]);
  const initialBranch = yield* git(cwd, ["branch", "--show-current"]);

  const worktreePath = pathService.join(
    yield* fileSystem.makeTempDirectoryScoped({ prefix: "worktree-manager-wt-" }),
    "first",
  );
  yield* driver.createWorktree({
    cwd,
    path: worktreePath,
    refName: initialBranch,
    newRefName: "feature/first",
  });
  yield* manager.removeWorktree({ cwd, path: worktreePath, force: true, reuse: true });

  const [parked] = yield* standbyPaths;
  assert.isString(parked);
  assert.equal(yield* fileSystem.exists(parked!), true);
  return { cwd, initialBranch, parked: parked! };
});

it.effect("removes a claimed worktree when the launch is interrupted before the move", () => {
  const entered = Deferred.makeUnsafe<void>();
  return Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const manager = yield* WorktreeManager.WorktreeManager;
    const { cwd, initialBranch, parked } = yield* parkedWorktree;

    const launch = yield* manager
      .createWorktree({
        cwd,
        refName: initialBranch,
        newRefName: "feature/second",
        baseRefName: initialBranch,
        path: null,
      })
      .pipe(Effect.forkChild({ startImmediately: true }));
    yield* Deferred.await(entered);
    // The pool row is gone from the claim on; only the launch knows about the worktree.
    assert.deepEqual(yield* standbyPaths, []);
    yield* Fiber.interrupt(launch);

    assert.equal(yield* fileSystem.exists(parked), false);
    assert.deepEqual(yield* standbyPaths, []);
    assert.notInclude(yield* git(cwd, ["worktree", "list", "--porcelain"]), parked);
  }).pipe(
    Effect.provide(
      makeLayer({
        beforeReuse: Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never)),
      }),
    ),
  );
});

it.effect("queues the moved checkout for removal when the failed reuse cannot remove it", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const pathService = yield* Path.Path;
    const { worktreesDir } = yield* ServerConfig.ServerConfig;
    const manager = yield* WorktreeManager.WorktreeManager;
    const driver = yield* GitVcsDriver.GitVcsDriver;
    const { cwd, initialBranch, parked } = yield* parkedWorktree;

    // The checkout cannot create a branch that exists, and git refuses to remove a locked worktree.
    yield* git(cwd, ["branch", "taken"]);
    const moved = pathService.join(worktreesDir, pathService.basename(cwd), "taken");
    const exit = yield* manager
      .createWorktree(
        {
          cwd,
          refName: initialBranch,
          newRefName: "taken",
          baseRefName: initialBranch,
          path: null,
        },
        {
          progress: {
            onWorktreeClaimed: (path) =>
              driver
                .execute({
                  operation: "WorktreeManager.git.test",
                  cwd,
                  args: ["worktree", "lock", path],
                  timeoutMs: 10_000,
                })
                .pipe(Effect.orDie, Effect.asVoid),
          },
        },
      )
      .pipe(Effect.exit);

    assert.isTrue(Exit.isFailure(exit));
    assert.equal(yield* fileSystem.exists(parked), false);
    // The checkout survived the failed rollback at its new path, so that is the path queued.
    assert.equal(yield* fileSystem.exists(moved), true);
    assert.deepEqual(yield* standbyPaths, [moved]);

    yield* git(cwd, ["worktree", "unlock", moved]);
    yield* manager.sweep;
    assert.equal(yield* fileSystem.exists(moved), false);
    assert.deepEqual(yield* standbyPaths, []);
    assert.notInclude(yield* git(cwd, ["worktree", "list", "--porcelain"]), moved);
  }).pipe(Effect.provide(makeLayer())),
);
