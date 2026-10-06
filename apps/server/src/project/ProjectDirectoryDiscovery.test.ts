import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { CommandId, ProjectId } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import type * as Scope from "effect/Scope";

import * as ServerConfig from "../config.ts";
import { ProjectServiceLayerLive } from "../orchestration-v2/runtimeLayer.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import * as ProjectDirectoryDiscovery from "./ProjectDirectoryDiscovery.ts";
import * as ProjectEnrichmentService from "./ProjectEnrichmentService.ts";
import * as ProjectFaviconResolver from "./ProjectFaviconResolver.ts";
import * as ProjectService from "./ProjectService.ts";
import * as RepositoryIdentityResolver from "./RepositoryIdentityResolver.ts";

const enrichmentLayer = ProjectEnrichmentService.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      Layer.succeed(RepositoryIdentityResolver.RepositoryIdentityResolver, {
        resolve: () => Effect.succeed(null),
      }),
      Layer.succeed(ProjectFaviconResolver.ProjectFaviconResolver, {
        resolvePath: () => Effect.succeed(null),
      }),
    ),
  ),
);

const configLayer = (
  baseDir: string,
  dirs: {
    readonly projectParentDirs: ReadonlyArray<string>;
    readonly projectDirs: ReadonlyArray<string>;
  },
) =>
  Layer.effect(
    ServerConfig.ServerConfig,
    ServerConfig.ServerConfig.pipe(
      Effect.map((config) => ServerConfig.ServerConfig.of({ ...config, ...dirs })),
    ),
  ).pipe(Layer.provide(ServerConfig.layerTest(baseDir, baseDir)));

type Services =
  | ProjectService.ProjectService
  | ProjectDirectoryDiscovery.ProjectDirectoryDiscovery
  | ServerConfig.ServerConfig
  | Crypto.Crypto
  | FileSystem.FileSystem
  | Path.Path
  | Scope.Scope;

/** A server run's first pass: a new service instance, so it has seen nothing yet. */
const firstPass = Effect.flatMap(
  ProjectDirectoryDiscovery.ProjectDirectoryDiscovery,
  (discovery) => discovery.sync,
).pipe(Effect.provide(Layer.fresh(ProjectDirectoryDiscovery.layer)));

const run = <A, E>(
  body: (root: string) => Effect.Effect<A, E, Services>,
  options: {
    /** Folders to configure, relative to the temp root. */
    readonly parents?: ReadonlyArray<string>;
    readonly projects?: ReadonlyArray<string>;
  },
) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-discovery-" });
    const resolve = (entry: string) => path.join(root, entry);
    const layer = ProjectDirectoryDiscovery.layer.pipe(
      Layer.provideMerge(ProjectServiceLayerLive),
      Layer.provideMerge(enrichmentLayer),
      Layer.provideMerge(WorkspacePaths.layer),
      Layer.provideMerge(SqlitePersistenceMemory),
      Layer.provideMerge(
        configLayer(path.join(root, "data"), {
          projectParentDirs: (options.parents ?? []).map(resolve),
          projectDirs: (options.projects ?? []).map(resolve),
        }),
      ),
      Layer.provideMerge(NodeServices.layer),
    );
    return yield* body(root).pipe(Effect.provide(layer));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

const makeRepository = (directory: string) =>
  FileSystem.FileSystem.pipe(
    Effect.flatMap((fileSystem) =>
      fileSystem.makeDirectory(`${directory}/.git`, { recursive: true }),
    ),
  );

const titles = ProjectService.ProjectService.pipe(
  Effect.flatMap((projects) => projects.listShells()),
  Effect.map((shells) => shells.map((shell) => shell.title).sort()),
);

it.effect("makes a project for each repository directly inside a parent folder", () =>
  run(
    (root) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        yield* makeRepository(`${root}/code/alpha`);
        // A linked worktree has a `.git` file, not a folder.
        yield* fileSystem.makeDirectory(`${root}/code/beta`, { recursive: true });
        yield* fileSystem.writeFileString(`${root}/code/beta/.git`, "gitdir: elsewhere\n");
        yield* fileSystem.makeDirectory(`${root}/code/plain`, { recursive: true });
        yield* makeRepository(`${root}/code/.hidden`);
        yield* makeRepository(`${root}/code/nested/inner`);
        yield* fileSystem.writeFileString(`${root}/code/notes.txt`, "not a folder\n");

        yield* firstPass;

        assert.deepEqual(yield* titles, ["alpha", "beta"]);
      }),
    { parents: ["code"] },
  ),
);

it.effect("makes a project for each CODE_PROJECTS folder that exists, repository or not", () =>
  run(
    (root) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        yield* fileSystem.makeDirectory(`${root}/solo`, { recursive: true });

        yield* firstPass;

        assert.deepEqual(yield* titles, ["solo"]);
      }),
    { projects: ["solo", "never-created"], parents: ["no-such-parent"] },
  ),
);

it.effect("picks up a repository added later without duplicating the others", () =>
  run(
    (root) =>
      Effect.gen(function* () {
        const discovery = yield* ProjectDirectoryDiscovery.ProjectDirectoryDiscovery;
        yield* makeRepository(`${root}/code/alpha`);
        yield* discovery.sync;
        yield* makeRepository(`${root}/code/gamma`);
        yield* discovery.sync;
        yield* discovery.sync;

        assert.deepEqual(yield* titles, ["alpha", "gamma"]);
      }),
    { parents: ["code"] },
  ),
);

it.effect("keeps a project the user already added for the folder", () =>
  run(
    (root) =>
      Effect.gen(function* () {
        const projects = yield* ProjectService.ProjectService;
        yield* makeRepository(`${root}/code/alpha`);
        yield* projects.create({
          commandId: CommandId.make("user-added"),
          projectId: ProjectId.make("user-added"),
          title: "My alpha",
          workspaceRoot: `${root}/code/alpha`,
        });

        yield* firstPass;

        assert.deepEqual(yield* titles, ["My alpha"]);
      }),
    { parents: ["code"] },
  ),
);

it.effect("does not bring back a deleted project until the next server run", () =>
  run(
    (root) =>
      Effect.gen(function* () {
        const projects = yield* ProjectService.ProjectService;
        const discovery = yield* ProjectDirectoryDiscovery.ProjectDirectoryDiscovery;
        yield* makeRepository(`${root}/code/alpha`);
        yield* discovery.sync;
        const [shell] = yield* projects.listShells();
        assert.isDefined(shell);
        yield* projects.delete({ commandId: CommandId.make("delete-alpha"), projectId: shell!.id });

        yield* discovery.sync;
        assert.deepEqual(yield* titles, []);

        yield* firstPass;
        assert.deepEqual(yield* titles, ["alpha"]);
      }),
    { parents: ["code"] },
  ),
);
