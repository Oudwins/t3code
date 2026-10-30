/**
 * Projects for `CODE_PROJECTS_PARENT_DIRS` repositories and `CODE_PROJECTS` folders. A folder
 * gets a project once per server run, so a deleted one returns only after a restart. At startup,
 * projects outside those folders that have no threads are removed.
 * @module ProjectDirectoryDiscovery
 */
import { CommandId, ProjectId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schedule from "effect/Schedule";
import type * as Scope from "effect/Scope";

import * as ServerConfig from "../config.ts";
import { forkParked } from "../serverActivation.ts";
import * as ProjectService from "./ProjectService.ts";

const RESCAN_INTERVAL = "30 seconds";

export class ProjectDirectoryDiscovery extends Context.Service<
  ProjectDirectoryDiscovery,
  {
    /** One pass: makes a project for each configured folder that has none. Never fails. */
    readonly sync: Effect.Effect<void>;
    /** Removes each project outside the configured folders that has no threads. Never fails. */
    readonly prune: Effect.Effect<void>;
    /**
     * Runs `prune` once, then `sync` now and every 30 seconds for the life of the
     * scope, so a repository cloned later shows up without a restart. Does nothing
     * when no folders are configured.
     */
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
  }
>()("t3/project/ProjectDirectoryDiscovery") {}

const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const projects = yield* ProjectService.ProjectService;
  const crypto = yield* Crypto.Crypto;

  // Roots that have a project, so a pass only looks at what is new, and roots
  // already reported, so a bad folder is one warning rather than one per pass.
  // Only the discovery fiber touches either.
  const settled = new Set<string>();
  const warned = new Set<string>();

  const warnOnce = (workspaceRoot: string, message: string, cause: unknown) =>
    Effect.suspend(() => {
      if (warned.has(workspaceRoot)) return Effect.void;
      warned.add(workspaceRoot);
      return Effect.logWarning(message, { workspaceRoot, cause });
    });

  const repositoriesIn = (parent: string) =>
    fileSystem.readDirectory(parent).pipe(
      Effect.flatMap((names) =>
        Effect.filter(
          names
            .filter((name) => !name.startsWith("."))
            .sort()
            .map((name) => path.join(parent, name)),
          (directory) =>
            fileSystem.exists(path.join(directory, ".git")).pipe(Effect.orElseSucceed(() => false)),
          { concurrency: 16 },
        ),
      ),
      Effect.catch((cause) =>
        warnOnce(parent, "Failed to list a project parent directory.", cause).pipe(
          Effect.as([] as Array<string>),
        ),
      ),
    );

  const ensureProject = Effect.fn("ProjectDirectoryDiscovery.ensureProject")(function* (
    workspaceRoot: string,
  ) {
    const id = yield* crypto.randomUUIDv4();
    const { created } = yield* projects.bootstrap({
      commandId: CommandId.make(`discovered-project:${id}`),
      projectId: ProjectId.make(id),
      title: path.basename(workspaceRoot) || workspaceRoot,
      workspaceRoot,
    });
    if (created) {
      yield* Effect.logInfo("Created a project from a configured folder", { workspaceRoot });
    }
  });

  const configuredRoots = Effect.gen(function* () {
    const roots = new Set(config.projectDirs.map((directory) => path.resolve(directory)));
    for (const parent of config.projectParentDirs) {
      for (const repository of yield* repositoriesIn(path.resolve(parent))) {
        roots.add(repository);
      }
    }
    return roots;
  });

  const sync = Effect.gen(function* () {
    for (const workspaceRoot of yield* configuredRoots) {
      if (settled.has(workspaceRoot)) continue;
      yield* ensureProject(workspaceRoot).pipe(
        Effect.tap(() => Effect.sync(() => settled.add(workspaceRoot))),
        Effect.catch((cause) =>
          warnOnce(workspaceRoot, "Failed to create a project from a configured folder.", cause),
        ),
      );
    }
  });

  const removeProject = Effect.fn("ProjectDirectoryDiscovery.removeProject")(function* (
    projectId: ProjectId,
    workspaceRoot: string,
  ) {
    const id = yield* crypto.randomUUIDv4();
    // Without `force`, delete refuses a project that still has threads.
    yield* projects.delete({ commandId: CommandId.make(`pruned-project:${id}`), projectId });
    yield* Effect.logInfo("Removed a project outside the configured folders", { workspaceRoot });
  });

  const prune = Effect.gen(function* () {
    if (config.projectParentDirs.length === 0 && config.projectDirs.length === 0) return;
    const roots = yield* configuredRoots;
    for (const { id, workspaceRoot } of yield* projects.listShells()) {
      if (roots.has(workspaceRoot)) continue;
      yield* removeProject(id, workspaceRoot).pipe(
        Effect.catchTags({ ProjectNotEmptyError: () => Effect.void }),
        Effect.catch((cause) =>
          Effect.logWarning("Failed to remove a project outside the configured folders.", {
            workspaceRoot,
            cause,
          }),
        ),
      );
    }
  }).pipe(Effect.ignoreCause({ log: true }));

  const start = Effect.fn("ProjectDirectoryDiscovery.start")(function* () {
    if (config.projectParentDirs.length === 0 && config.projectDirs.length === 0) return;
    yield* forkParked(
      prune.pipe(
        Effect.andThen(
          sync.pipe(
            Effect.ignoreCause({ log: true }),
            Effect.repeat(Schedule.spaced(RESCAN_INTERVAL)),
          ),
        ),
        Effect.asVoid,
      ),
    );
  });

  return ProjectDirectoryDiscovery.of({ sync, prune, start });
});

export const layer = Layer.effect(ProjectDirectoryDiscovery, make);
