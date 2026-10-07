import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it, vi } from "@effect/vitest";
import { ProjectId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import * as TerminalManager from "../terminal/Manager.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ProjectService from "./ProjectService.ts";
import * as ProjectSetupScriptRunner from "./ProjectSetupScriptRunner.ts";

it.effect("resolves setup scripts through the standalone project service", () => {
  const open = vi.fn((input: Parameters<TerminalManager.TerminalManager["Service"]["open"]>[0]) =>
    Effect.succeed({
      threadId: input.threadId,
      terminalId: input.terminalId,
      cwd: input.cwd,
      worktreePath: input.worktreePath ?? null,
      status: "running" as const,
      pid: 123,
      history: "",
      exitCode: null,
      exitSignal: null,
      label: "Shell",
      updatedAt: "2026-06-20T00:00:00.000Z",
    }),
  );
  const write = vi.fn(
    (_input: Parameters<TerminalManager.TerminalManager["Service"]["write"]>[0]) => Effect.void,
  );
  const listeners: Array<Parameters<TerminalManager.TerminalManager["Service"]["subscribe"]>[0]> =
    [];
  const subscribe: TerminalManager.TerminalManager["Service"]["subscribe"] = (listener) =>
    Effect.sync(() => {
      listeners.push(listener);
      return () => undefined;
    });
  const projectId = ProjectId.make("project:setup-runner-v2");
  const project = {
    id: projectId,
    title: "Project",
    workspaceRoot: "/repo",
    repositoryIdentity: null,
    faviconPath: null,
    defaultModelSelection: null,
    scripts: [
      {
        id: "setup",
        name: "Setup",
        command: "vp install",
        icon: "configure" as const,
        runOnWorktreeCreate: true,
      },
    ],
    createdAt: "2026-06-20T00:00:00.000Z",
    updatedAt: "2026-06-20T00:00:00.000Z",
    deletedAt: null,
  };
  const layer = ProjectSetupScriptRunner.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(ProjectService.ProjectService)({
          getById: () => Effect.succeed(Option.some(project)),
        }),
        Layer.mock(TerminalManager.TerminalManager)({ open, write, subscribe }),
        ServerSettings.layerTest(),
        NodeServices.layer,
      ),
    ),
  );

  return Effect.gen(function* () {
    const runner = yield* ProjectSetupScriptRunner.ProjectSetupScriptRunner;
    const result = yield* runner.runForThread({
      threadId: "thread-1",
      projectId,
      worktreePath: "/repo-worktree",
    });
    assert.deepEqual(result, {
      status: "started",
      async: true,
      scriptId: "setup",
      scriptName: "Setup",
      scriptCommand: "vp install",
      terminalId: "setup-setup",
      cwd: "/repo-worktree",
    });
    assert.equal(open.mock.calls[0]?.[0].cwd, "/repo-worktree");
    assert.deepEqual(open.mock.calls[0]?.[0].env, {
      T3CODE_PROJECT_ROOT: "/repo",
      T3CODE_WORKTREE_PATH: "/repo-worktree",
      COLORTERM: "",
      NO_COLOR: "1",
      FORCE_COLOR: "0",
    });
    assert.equal(write.mock.calls[0]?.[0].data, "vp install\r");
    const lines: string[] = [];
    const observed = yield* runner.runForThread({
      threadId: "thread-1",
      projectId,
      worktreePath: "/repo-worktree",
      observeCompletion: {
        onOutputLine: (line) =>
          Effect.sync(() => {
            lines.push(line);
          }),
      },
    });
    assert.equal(observed.status, "started");
    const listener = listeners[0]!;
    yield* listener({
      type: "output",
      threadId: "thread-1",
      terminalId: "setup-setup",
      data: "Downloading 10%\rDownloading 20%\r\nDone\n",
    });
    assert.deepEqual(lines, ["Downloading 10%", "Downloading 20%", "Done"]);
    yield* listener({ type: "closed", threadId: "thread-1", terminalId: "setup-setup" });
  }).pipe(Effect.provide(layer));
});

const SETUP_SCRIPT = {
  id: "setup",
  name: "Setup",
  command: "vp install",
  icon: "configure" as const,
  runOnWorktreeCreate: true,
};

/**
 * Runs the setup script for a project in a real temp worktree whose
 * `.cursor/worktrees.json` holds `cursorFile`, and reports what reached the
 * terminal.
 */
const runWithCursorFile = (input: {
  readonly cursorFile: string;
  readonly settings: Parameters<typeof ServerSettings.layerTest>[0];
}) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const worktreePath = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3code-setup-" });
    yield* fileSystem.makeDirectory(path.join(worktreePath, ".cursor"));
    yield* fileSystem.writeFileString(
      path.join(worktreePath, ".cursor", "worktrees.json"),
      input.cursorFile,
    );

    const open = vi.fn(
      (openInput: Parameters<TerminalManager.TerminalManager["Service"]["open"]>[0]) =>
        Effect.succeed({
          threadId: openInput.threadId,
          terminalId: openInput.terminalId,
          cwd: openInput.cwd,
          worktreePath: openInput.worktreePath ?? null,
          status: "running" as const,
          pid: 123,
          history: "",
          exitCode: null,
          exitSignal: null,
          label: "Shell",
          updatedAt: "2026-06-20T00:00:00.000Z",
        }),
    );
    const write = vi.fn(
      (_input: Parameters<TerminalManager.TerminalManager["Service"]["write"]>[0]) => Effect.void,
    );
    const projectId = ProjectId.make("project:cursor-setup");
    const project = {
      id: projectId,
      title: "Project",
      workspaceRoot: "/repo",
      repositoryIdentity: null,
      faviconPath: null,
      defaultModelSelection: null,
      scripts: [],
      createdAt: "2026-06-20T00:00:00.000Z",
      updatedAt: "2026-06-20T00:00:00.000Z",
      deletedAt: null,
    };
    const layer = ProjectSetupScriptRunner.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.mock(ProjectService.ProjectService)({
            getById: () => Effect.succeed(Option.some(project)),
          }),
          Layer.mock(TerminalManager.TerminalManager)({ open, write }),
          ServerSettings.layerTest(input.settings),
          NodeServices.layer,
        ),
      ),
    );

    const result = yield* Effect.gen(function* () {
      const runner = yield* ProjectSetupScriptRunner.ProjectSetupScriptRunner;
      return yield* runner.runForThread({ threadId: "thread-1", projectId, worktreePath });
    }).pipe(Effect.provide(layer));
    return { result, open, write };
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped);

it.effect("runs the Cursor worktree config ahead of the environment default", () =>
  Effect.gen(function* () {
    const { result, open, write } = yield* runWithCursorFile({
      cursorFile: JSON.stringify({
        "setup-worktree": ["cp $ROOT_WORKTREE_PATH/.env .env", "pnpm i"],
      }),
      settings: { defaultProjectScripts: [SETUP_SCRIPT] },
    });

    assert.equal(result.status, "started");
    if (result.status !== "started") return;
    assert.equal(result.scriptId, "cursor-worktree-setup");
    assert.equal(write.mock.calls[0]?.[0].data, "cp $ROOT_WORKTREE_PATH/.env .env\npnpm i\r");
    assert.equal(open.mock.calls[0]?.[0].env?.ROOT_WORKTREE_PATH, "/repo");
    assert.equal(open.mock.calls[0]?.[0].env?.T3CODE_PROJECT_ROOT, "/repo");
  }),
);

it.effect("falls back to the environment default when the Cursor file has no setup", () =>
  Effect.gen(function* () {
    const { result, open } = yield* runWithCursorFile({
      cursorFile: JSON.stringify({ "setup-worktree": [] }),
      settings: { defaultProjectScripts: [SETUP_SCRIPT] },
    });

    assert.equal(result.status, "started");
    if (result.status !== "started") return;
    assert.equal(result.scriptId, "setup");
    assert.equal(open.mock.calls[0]?.[0].env?.ROOT_WORKTREE_PATH, undefined);
  }),
);

it.effect("ignores the Cursor worktree config when the project has its own actions", () =>
  Effect.gen(function* () {
    const projectId = ProjectId.make("project:cursor-setup");
    const { result } = yield* runWithCursorFile({
      cursorFile: JSON.stringify({ "setup-worktree": ["echo from cursor"] }),
      settings: {
        defaultProjectScripts: [SETUP_SCRIPT],
        projectSettingsOverrides: { [projectId]: { defaultProjectScripts: [] } },
      },
    });

    assert.equal(result.status, "no-script");
  }),
);
