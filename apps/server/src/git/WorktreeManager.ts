import type {
  GitCommandError,
  VcsCreateWorktreeInput,
  VcsCreateWorktreeResult,
  VcsRemoveWorktreeInput,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Equal from "effect/Equal";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";

import { forkParked } from "../serverActivation.ts";
import * as Settings from "../serverSettings.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as GitWorkflow from "./GitWorkflowService.ts";
import * as WorktreePool from "./WorktreePool.ts";

const HOUR_MS = 3_600_000;

/**
 * The one way to get and give back a worktree. Callers ask for a worktree the
 * way they would ask git for one and never learn whether it was created or
 * claimed from standby. It never blocks a launch or a removal: any failure
 * degrades to creating or removing the worktree directly.
 */
export class WorktreeManager extends Context.Service<
  WorktreeManager,
  {
    /**
     * Same contract as `git worktree add`: `newRefName` set creates that
     * branch from `refName`, otherwise `refName` is checked out as is;
     * `path` set pins the location, otherwise it is derived. With reuse
     * enabled a standby worktree is moved there and checked out instead.
     */
    readonly createWorktree: (
      input: VcsCreateWorktreeInput,
      options?: GitVcsDriver.CreateWorktreeOptions,
    ) => Effect.Effect<VcsCreateWorktreeResult, GitCommandError>;
    /**
     * Moves the worktree to standby when `reuse` is set and reuse is enabled;
     * otherwise removes it. A thread that still records the path recreates its
     * checkout there on resume, because parking vacates it. Parking discards
     * uncommitted changes only with `force`; without it a dirty worktree is
     * removed the plain way, which git refuses. A worktree git cannot move,
     * such as one with submodules, is removed the plain way as well.
     */
    readonly removeWorktree: (
      input: VcsRemoveWorktreeInput,
    ) => Effect.Effect<void, GitCommandError>;
    /** Removes standby worktrees past their time or count limit, or all of them once reuse is disabled. */
    readonly sweep: Effect.Effect<void>;
  }
>()("t3/git/WorktreeManager") {}

const make = Effect.gen(function* () {
  const git = yield* GitWorkflow.GitWorkflowService;
  const pool = yield* WorktreePool.WorktreePool;
  const fileSystem = yield* FileSystem.FileSystem;
  const settings = yield* Settings.ServerSettingsService;

  const reuseEnabled = settings.getSettings.pipe(
    Effect.map((current) => current.worktreeReuse.enabled),
    Effect.orElseSucceed(() => false),
  );

  const discard = (cwd: string, path: string) =>
    git
      .removeWorktree({ cwd, path, force: true })
      .pipe(
        Effect.catch((error) =>
          Effect.logWarning("failed to remove standby worktree", { path, error }),
        ),
      );

  const sweep = Effect.gen(function* () {
    const { enabled, maxStandby, standbyHours } = (yield* settings.getSettings).worktreeReuse;
    const evicted = yield* enabled
      ? pool.evict({ maxAgeMs: standbyHours * HOUR_MS, maxPerRepo: maxStandby })
      : pool.evictAll;
    yield* Effect.forEach(evicted, ({ path, repoRoot }) => discard(repoRoot, path), {
      discard: true,
    });
  }).pipe(Effect.catch((error) => Effect.logWarning("worktree standby sweep failed", { error })));

  const claimStandby = Effect.fn("WorktreeManager.claimStandby")(function* (
    input: VcsCreateWorktreeInput,
    options: GitVcsDriver.CreateWorktreeOptions | undefined,
  ) {
    for (;;) {
      const standbyPath = Option.getOrUndefined(
        yield* pool.claim(input.cwd).pipe(Effect.orElseSucceed(() => Option.none<string>())),
      );
      if (standbyPath === undefined) return null;
      // Someone may have deleted the directory outside the app.
      if (!(yield* fileSystem.exists(standbyPath).pipe(Effect.orElseSucceed(() => false)))) {
        continue;
      }

      const reused = yield* git
        .reuseWorktree({ ...input, standbyPath }, options)
        .pipe(Effect.option);
      if (Option.isSome(reused)) return reused.value;

      yield* Effect.logWarning("standby worktree could not be reused; removing it", {
        path: standbyPath,
      });
      yield* discard(input.cwd, standbyPath);
      return null;
    }
  });

  const createWorktree: WorktreeManager["Service"]["createWorktree"] = Effect.fn(
    "WorktreeManager.createWorktree",
  )(function* (input, options) {
    if (yield* reuseEnabled) {
      const reused = yield* claimStandby(input, options);
      if (reused !== null) return reused;
    }
    return yield* git.createWorktree(input, options);
  });

  /** False when the worktree could not be moved aside and is still at `input.path`. */
  const park = Effect.fn("WorktreeManager.park")(function* (input: VcsRemoveWorktreeInput) {
    const parked = yield* git
      .parkWorktree({ cwd: input.cwd, path: input.path, discardChanges: input.force === true })
      .pipe(Effect.option);
    if (Option.isNone(parked)) {
      yield* Effect.logDebug("worktree not parked; removing it instead", { path: input.path });
      return false;
    }
    const { path } = parked.value;
    yield* pool.release({ path, repoRoot: input.cwd }).pipe(
      // Untracked, a parked worktree would sit on disk forever.
      Effect.catch((error) =>
        Effect.logWarning("failed to record standby worktree; removing it", { path, error }).pipe(
          Effect.andThen(discard(input.cwd, path)),
        ),
      ),
    );
    return true;
  });

  const removeWorktree: WorktreeManager["Service"]["removeWorktree"] = Effect.fn(
    "WorktreeManager.removeWorktree",
  )(function* (input) {
    if (input.reuse === true && (yield* reuseEnabled)) {
      if (yield* park(input)) {
        yield* sweep;
        return;
      }
    }
    yield* git.removeWorktree(input);
  });

  return WorktreeManager.of({ createWorktree, removeWorktree, sweep });
});

export const layer = Layer.effect(WorktreeManager, make);

/** Evicts expired standby worktrees on a timer and whenever the reuse settings change. */
export const reaperLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    const manager = yield* WorktreeManager;
    const changes = yield* (yield* Settings.ServerSettingsService).subscribeChanges;
    yield* forkParked(manager.sweep.pipe(Effect.repeat(Schedule.spaced("10 minutes"))));
    yield* forkParked(
      changes.pipe(
        Stream.changesWith((a, b) => Equal.equals(a.worktreeReuse, b.worktreeReuse)),
        Stream.runForEach(() => manager.sweep),
      ),
    );
  }),
);
