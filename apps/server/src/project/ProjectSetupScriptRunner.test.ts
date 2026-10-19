import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it, vi } from "@effect/vitest";
import { ProjectId, TerminalNotRunningError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

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
  const closeIdle = vi.fn(
    (_input: Parameters<TerminalManager.TerminalManager["Service"]["closeIdle"]>[0]) => Effect.void,
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
      {
        id: "clean",
        name: "Clean",
        command: "cargo clean",
        icon: "build" as const,
        runOnWorktreeCreate: false,
        runOnSettle: true,
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
        Layer.mock(TerminalManager.TerminalManager)({ open, write, subscribe, closeIdle }),
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
    assert.equal(write.mock.calls[0]?.[0].data, " vp install\r");
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
    assert.match(write.mock.calls[1]?.[0].data ?? "", /^ \S/);
    const listener = listeners[0]!;
    yield* listener({
      type: "output",
      threadId: "thread-1",
      terminalId: "setup-setup",
      data: "Downloading 10%\rDownloading 20%\r\nDone\n",
    });
    assert.deepEqual(lines, ["Downloading 10%", "Downloading 20%", "Done"]);
    yield* listener({ type: "closed", threadId: "thread-1", terminalId: "setup-setup" });

    const settle = yield* runner.runForThread({
      threadId: "thread-1",
      projectId,
      worktreePath: "/repo-worktree",
      trigger: "settle",
    });
    const settleTerminalId = settle.status === "started" ? settle.terminalId : "";
    assert.match(settleTerminalId, /^settle-clean-/);
    assert.equal(write.mock.calls.at(-1)?.[0].data, " cargo clean\r");

    const observedSettle = yield* runner.runForThread({
      threadId: "thread-1",
      projectId,
      worktreePath: "/repo-worktree",
      trigger: "settle",
      observeCompletion: {},
    });
    const observedTerminalId = observedSettle.status === "started" ? observedSettle.terminalId : "";
    assert.notEqual(observedTerminalId, settleTerminalId);
    assert.match(write.mock.calls.at(-1)?.[0].data ?? "", /^ \S/);
    const token = /__T3_SETUP_DONE___(\w+):/.exec(write.mock.calls.at(-1)?.[0].data ?? "")?.[1];
    const settleListener = listeners.at(-1)!;
    const completion = yield* Effect.forkChild(
      observedSettle.status === "started" && observedSettle.completion
        ? observedSettle.completion
        : Effect.die("no completion"),
    );
    yield* settleListener({
      type: "output",
      threadId: "thread-1",
      terminalId: observedTerminalId,
      data: `\r\n__T3_SETUP_DONE___${token}:0\r\n`,
    });
    yield* Effect.yieldNow;
    assert.equal(closeIdle.mock.calls.length, 0);
    yield* settleListener({
      type: "output",
      threadId: "thread-1",
      terminalId: observedTerminalId,
      data: "$ ",
    });
    assert.deepEqual((yield* Fiber.join(completion)).exitCode, 0);
    assert.deepEqual(closeIdle.mock.calls[0]?.[0], {
      threadId: "thread-1",
      terminalId: observedTerminalId,
    });
  }).pipe(Effect.provide(layer));
});

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

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
      cursorFile: encodeJson({
        "setup-worktree": ["cp $ROOT_WORKTREE_PATH/.env .env", "pnpm i"],
      }),
      settings: { defaultProjectScripts: [SETUP_SCRIPT] },
    });

    assert.equal(result.status, "started");
    if (result.status !== "started") return;
    assert.equal(result.scriptId, "cursor-worktree-setup");
    assert.equal(write.mock.calls[0]?.[0].data, " cp $ROOT_WORKTREE_PATH/.env .env\npnpm i\r");
    assert.equal(open.mock.calls[0]?.[0].env?.ROOT_WORKTREE_PATH, "/repo");
    assert.equal(open.mock.calls[0]?.[0].env?.T3CODE_PROJECT_ROOT, "/repo");
  }),
);

it.effect("falls back to the environment default when the Cursor file has no setup", () =>
  Effect.gen(function* () {
    const { result, open } = yield* runWithCursorFile({
      cursorFile: encodeJson({ "setup-worktree": [] }),
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
      cursorFile: encodeJson({ "setup-worktree": ["echo from cursor"] }),
      settings: {
        defaultProjectScripts: [SETUP_SCRIPT],
        projectSettingsOverrides: { [projectId]: { defaultProjectScripts: [] } },
      },
    });

    assert.equal(result.status, "no-script");
  }),
);

/** The runner over a mocked terminal whose script is blocking or async, recording closes. */
const makeReleaseHarness = (input: { readonly async: boolean; readonly writeFails?: boolean }) => {
  // Like the real manager, opening a terminal that is still open returns its running shell.
  const shells = new Map<string, { readonly pid: number }>();
  const opened: Array<{ readonly pid: number; readonly cwd: string }> = [];
  let nextPid = 100;
  const open = (openInput: Parameters<TerminalManager.TerminalManager["Service"]["open"]>[0]) =>
    Effect.sync(() => {
      const key = `${openInput.threadId}:${openInput.terminalId}`;
      const shell = shells.get(key) ?? { pid: nextPid++ };
      shells.set(key, shell);
      opened.push({ pid: shell.pid, cwd: openInput.cwd });
      return {
        threadId: openInput.threadId,
        terminalId: openInput.terminalId,
        cwd: openInput.cwd,
        worktreePath: openInput.worktreePath ?? null,
        status: "running" as const,
        pid: shell.pid,
        history: "",
        exitCode: null,
        exitSignal: null,
        label: "Shell",
        updatedAt: "2026-06-20T00:00:00.000Z",
      };
    });
  let commandWritten = Deferred.makeUnsafe<void>();
  const waitForWrite = () =>
    Deferred.await(commandWritten).pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          commandWritten = Deferred.makeUnsafe<void>();
        }),
      ),
    );
  const write = vi.fn(
    (_input: Parameters<TerminalManager.TerminalManager["Service"]["write"]>[0]) =>
      input.writeFails
        ? Effect.fail(
            new TerminalNotRunningError({ threadId: "thread-1", terminalId: "setup-setup" }),
          )
        : Deferred.succeed(commandWritten, undefined).pipe(Effect.asVoid),
  );
  // Recorded when the effect runs, not when it is built.
  const closeCalls: Array<Parameters<TerminalManager.TerminalManager["Service"]["close"]>[0]> = [];
  const closeIdleCalls: Array<
    Parameters<TerminalManager.TerminalManager["Service"]["closeIdle"]>[0]
  > = [];
  const close = (input: Parameters<TerminalManager.TerminalManager["Service"]["close"]>[0]) =>
    Effect.sync(() => {
      closeCalls.push(input);
      shells.delete(`${input.threadId}:${input.terminalId}`);
    });
  const closeIdle = (
    input: Parameters<TerminalManager.TerminalManager["Service"]["closeIdle"]>[0],
  ) =>
    Effect.sync(() => {
      closeIdleCalls.push(input);
    });
  const listeners: Array<Parameters<TerminalManager.TerminalManager["Service"]["subscribe"]>[0]> =
    [];
  const subscribe: TerminalManager.TerminalManager["Service"]["subscribe"] = (listener) =>
    Effect.sync(() => {
      listeners.push(listener);
      return () => undefined;
    });
  const projectId = ProjectId.make("project:setup-release");
  const project = {
    id: projectId,
    title: "Project",
    workspaceRoot: "/repo",
    repositoryIdentity: null,
    faviconPath: null,
    defaultModelSelection: null,
    scripts: [{ ...SETUP_SCRIPT, async: input.async }],
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
        Layer.mock(TerminalManager.TerminalManager)({
          open,
          write,
          close,
          closeIdle,
          subscribe,
        }),
        ServerSettings.layerTest(),
        NodeServices.layer,
      ),
    ),
  );
  const runInput = {
    threadId: "thread-1",
    projectId,
    worktreePath: "/repo-worktree",
  };
  /** Prints the sentinel the run's wrapper would print when the script exits with `exitCode`. */
  const finishScript = (exitCode: number) =>
    Effect.gen(function* () {
      const written = write.mock.calls[0]?.[0].data ?? "";
      const token = /__T3_SETUP_DONE___([0-9a-f]{32}):/.exec(written)?.[1];
      assert.isDefined(token);
      yield* listeners[0]!({
        type: "output",
        threadId: "thread-1",
        terminalId: "setup-setup",
        data: `__T3_SETUP_DONE___${token}:${exitCode}\n$ `,
      });
    });
  return { layer, runInput, opened, closeCalls, closeIdleCalls, finishScript, waitForWrite };
};

it.effect("closes a blocking setup terminal, keeping its output, when the script fails", () => {
  const harness = makeReleaseHarness({ async: false });
  return Effect.gen(function* () {
    const runner = yield* ProjectSetupScriptRunner.ProjectSetupScriptRunner;
    const failure = yield* Effect.gen(function* () {
      const fiber = yield* Effect.forkChild(
        ProjectSetupScriptRunner.runForThreadSettled(runner, harness.runInput),
      );
      yield* harness.waitForWrite();
      yield* harness.finishScript(3);
      return yield* Fiber.join(fiber);
    }).pipe(Effect.flip);

    assert.equal(failure._tag, "ProjectSetupScriptFailedError");
    assert.deepEqual(harness.closeCalls, [{ threadId: "thread-1", terminalId: "setup-setup" }]);
    assert.equal(harness.closeIdleCalls.length, 0);
  }).pipe(Effect.provide(harness.layer));
});

it.effect("runs a retry after a failed blocking setup in a fresh shell", () => {
  const harness = makeReleaseHarness({ async: false });
  return Effect.gen(function* () {
    const runner = yield* ProjectSetupScriptRunner.ProjectSetupScriptRunner;
    const first = yield* Effect.forkChild(
      ProjectSetupScriptRunner.runForThreadSettled(runner, harness.runInput),
    );
    yield* harness.waitForWrite();
    yield* harness.finishScript(3);
    yield* Fiber.join(first).pipe(Effect.flip);

    // The failed checkout is removed and recreated at the same path, so the
    // retry would reuse the first run's shell if it were still open.
    const retry = yield* Effect.forkChild(
      ProjectSetupScriptRunner.runForThreadSettled(runner, harness.runInput),
    );
    yield* harness.waitForWrite();
    yield* Fiber.interrupt(retry);

    assert.equal(harness.opened.length, 2);
    assert.notEqual(harness.opened[0]!.pid, harness.opened[1]!.pid);
    assert.equal(harness.opened[1]!.cwd, "/repo-worktree");
  }).pipe(Effect.provide(harness.layer));
});

it.effect("only closes an idle blocking setup terminal when the script succeeds", () => {
  const harness = makeReleaseHarness({ async: false });
  return Effect.gen(function* () {
    const runner = yield* ProjectSetupScriptRunner.ProjectSetupScriptRunner;
    const fiber = yield* Effect.forkChild(
      ProjectSetupScriptRunner.runForThreadSettled(runner, harness.runInput),
    );
    yield* harness.waitForWrite();
    yield* harness.finishScript(0);
    yield* Fiber.join(fiber);

    assert.equal(harness.closeCalls.length, 0);
    assert.equal(harness.closeIdleCalls.length, 1);
  }).pipe(Effect.provide(harness.layer));
});

it.effect("leaves an async setup terminal open when the script fails", () => {
  const harness = makeReleaseHarness({ async: true });
  return Effect.gen(function* () {
    const runner = yield* ProjectSetupScriptRunner.ProjectSetupScriptRunner;
    const result = yield* runner.runForThread({
      ...harness.runInput,
      observeCompletion: { releaseOnFailure: true },
    });
    assert.equal(result.status, "started");
    if (result.status !== "started") return;
    const fiber = yield* Effect.forkChild(result.completion!);
    yield* harness.waitForWrite();
    yield* harness.finishScript(1);
    assert.deepEqual(yield* Fiber.join(fiber), { exitCode: 1, durationMs: 0 });

    assert.equal(harness.closeCalls.length, 0);
  }).pipe(Effect.provide(harness.layer));
});

it.effect("closes a blocking setup terminal when the wait is interrupted", () => {
  const harness = makeReleaseHarness({ async: false });
  return Effect.gen(function* () {
    const runner = yield* ProjectSetupScriptRunner.ProjectSetupScriptRunner;
    const fiber = yield* Effect.forkChild(
      ProjectSetupScriptRunner.runForThreadSettled(runner, harness.runInput),
    );
    yield* harness.waitForWrite();
    yield* Fiber.interrupt(fiber);

    assert.deepEqual(harness.closeCalls, [{ threadId: "thread-1", terminalId: "setup-setup" }]);
  }).pipe(Effect.provide(harness.layer));
});

it.effect("closes the setup terminal when the command cannot be written", () => {
  const harness = makeReleaseHarness({ async: false, writeFails: true });
  return Effect.gen(function* () {
    const runner = yield* ProjectSetupScriptRunner.ProjectSetupScriptRunner;
    const exit = yield* ProjectSetupScriptRunner.runForThreadSettled(runner, harness.runInput).pipe(
      Effect.exit,
    );

    assert.equal(exit._tag, "Failure");
    assert.deepEqual(harness.closeCalls, [{ threadId: "thread-1", terminalId: "setup-setup" }]);
  }).pipe(Effect.provide(harness.layer));
});
