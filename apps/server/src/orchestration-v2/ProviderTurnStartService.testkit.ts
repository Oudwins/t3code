import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as GitWorkflow from "../git/GitWorkflowService.ts";
import * as WorktreeManager from "../git/WorktreeManager.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProjectSetupScriptRunner from "../project/ProjectSetupScriptRunner.ts";

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
