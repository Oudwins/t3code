import { SourceControlProviderError, SourceControlProviderKind } from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as ServerConfig from "../config.ts";
import * as GitManager from "../git/GitManager.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as VcsProjectConfig from "../vcs/VcsProjectConfig.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ProjectSetupScriptRunner from "../project/ProjectSetupScriptRunner.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as SourceControlProviderRegistry from "../sourceControl/SourceControlProviderRegistry.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProjectStore from "./ProjectStore.ts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as GitWorkflow from "../git/GitWorkflowService.ts";
import * as WorktreeManager from "../git/WorktreeManager.ts";
import * as ProjectService from "../project/ProjectService.ts";

export const layer = Layer.mergeAll(
  Layer.mock(GitWorkflow.GitWorkflowService)({
    pruneWorktrees: () => Effect.void,
  }),
  Layer.mock(WorktreeManager.WorktreeManager)({
    createWorktree: () => Effect.succeed({} as never),
  }),
  Layer.mock(ProjectService.ProjectService)({
    getById: () => Effect.succeedNone,
  }),
  Layer.mock(ProjectSetupScriptRunner.ProjectSetupScriptRunner)({
    runForThread: () => Effect.succeed({ status: "no-script" }),
  }),
);

// Keep repository detection, branch selection and worktree creation on the real Git path.
export const layerRealGit = GitWorkflow.layer.pipe(
  Layer.provide(GitManager.layer),
  Layer.provide(
    Layer.mergeAll(
      Layer.mock(SourceControlProviderRegistry.SourceControlProviderRegistry)({
        resolveLink: () => undefined,
        resolve: ({ cwd }) =>
          Effect.fail(
            new SourceControlProviderError({
              provider: SourceControlProviderKind.make("unknown"),
              operation: "resolve",
              cwd,
              detail: "No source control provider in tests",
            }),
          ),
      }),
      Layer.mock(TextGeneration.TextGeneration)({}),
      Layer.mock(ProviderRegistry.ProviderRegistry)({}),
      Layer.mock(ProjectSetupScriptRunner.ProjectSetupScriptRunner)({}),
      // The fork's GitManager creates worktrees through the manager; keep them on real Git.
      Layer.effect(
        WorktreeManager.WorktreeManager,
        Effect.gen(function* () {
          const driver = yield* GitVcsDriver.GitVcsDriver;
          return WorktreeManager.WorktreeManager.of({
            createWorktree: driver.createWorktree,
            removeWorktree: driver.removeWorktree,
            sweep: Effect.void,
          });
        }),
      ),
      Layer.mock(ProjectionStore.ProjectionStoreV2)({}),
      Layer.mock(ProjectStore.ProjectStoreV2)({}),
      ServerSettings.layerTest(),
    ),
  ),
  Layer.provide(VcsDriverRegistry.layer.pipe(Layer.provide(VcsProjectConfig.layer))),
  Layer.provideMerge(GitVcsDriver.layer),
  Layer.provideMerge(VcsProcess.layer),
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-recreate-" })),
  Layer.provideMerge(NodeServices.layer),
);
