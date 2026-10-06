/**
 * ProjectDirectoryDiscovery - makes projects out of the folders the server is
 * pointed at, so a code directory needs no clicking through "Add project":
 *
 * - `CODE_PROJECTS_PARENT_DIRS`: every Git repository directly inside each
 *   listed folder becomes a project, including ones cloned later;
 * - `CODE_PROJECTS`: each listed folder becomes a project.
 *
 * A folder gets a project once per server run. Deleting one keeps it deleted
 * until the server restarts and finds the folder again.
 *
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
    /**
     * Runs `sync` now and every 30 seconds for the life of the scope, so a
     * repository cloned later shows up without a restart. Does nothing when no
     * folders are configured.
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
  // Only the sync loop touches either.
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
    const id = yield* crypto.randomUUIDv4;
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

  const sync = Effect.gen(function* () {
    const roots = new Set(config.projectDirs.map((directory) => path.resolve(directory)));
    for (const parent of config.projectParentDirs) {
      for (const repository of yield* repositoriesIn(path.resolve(parent))) {
        roots.add(repository);
      }
    }
    for (const workspaceRoot of roots) {
      if (settled.has(workspaceRoot)) continue;
      yield* ensureProject(workspaceRoot).pipe(
        Effect.tap(() => Effect.sync(() => settled.add(workspaceRoot))),
        Effect.catch((cause) =>
          warnOnce(workspaceRoot, "Failed to create a project from a configured folder.", cause),
        ),
      );
    }
  });

  const start = Effect.fn("ProjectDirectoryDiscovery.start")(function* () {
    if (config.projectParentDirs.length === 0 && config.projectDirs.length === 0) return;
    yield* forkParked(
      sync.pipe(
        Effect.ignoreCause({ log: true }),
        Effect.repeat(Schedule.spaced(RESCAN_INTERVAL)),
        Effect.asVoid,
      ),
    );
  });

  return ProjectDirectoryDiscovery.of({ sync, start });
});

export const layer = Layer.effect(ProjectDirectoryDiscovery, make);
