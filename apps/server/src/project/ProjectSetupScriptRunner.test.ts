import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, expect, it, vi } from "@effect/vitest";
import {
  ProjectId,
  TerminalNotRunningError,
  type TerminalEvent,
  type TerminalSessionSnapshot,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import { TestClock } from "effect/testing";

import * as ServerSettings from "../serverSettings.ts";
import * as TerminalManager from "../terminal/Manager.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProjectService from "./ProjectService.ts";
import * as ProjectSetupScriptRunner from "./ProjectSetupScriptRunner.ts";

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
          Layer.mock(ProjectionStore.ProjectionStoreV2)({
            getThreadShell: () => Effect.succeed(null),
          }),
          Layer.mock(ProjectService.ProjectService)({
            getById: () => Effect.succeedSome(project),
          }),
          Layer.mock(TerminalManager.TerminalManager)({
            open,
            write,
            getShell: () => Effect.succeed("/bin/zsh"),
            subscribe: () => Effect.succeed(() => undefined),
          }),
          ServerSettings.layerTest(input.settings),
          NodeServices.layer,
        ),
      ),
    );

    const result = yield* Effect.gen(function* () {
      const runner = yield* ProjectSetupScriptRunner.ProjectSetupScriptRunner;
      const result = yield* runner.runForThread({ threadId: "thread-1", projectId, worktreePath });
      // The command is typed once the quiet-shell fallback decides the shell is ready.
      yield* TestClock.adjust("3 seconds");
      return result;
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
  // The command is typed once the quiet-shell fallback decides the shell is ready.
  const waitForWrite = () =>
    TestClock.adjust("3 seconds").pipe(
      Effect.andThen(Effect.suspend(() => Deferred.await(commandWritten))),
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
        Layer.mock(ProjectionStore.ProjectionStoreV2)({
          getThreadShell: () => Effect.succeed(null),
        }),
        Layer.mock(ProjectService.ProjectService)({
          getById: () => Effect.succeedSome(project),
        }),
        Layer.mock(TerminalManager.TerminalManager)({
          open,
          write,
          getShell: () => Effect.succeed("/bin/zsh"),
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
    assert.deepEqual(yield* Fiber.join(fiber), { exitCode: 1, durationMs: 3000 });

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
    const fiber = yield* Effect.forkChild(
      ProjectSetupScriptRunner.runForThreadSettled(runner, harness.runInput),
    );
    yield* TestClock.adjust("3 seconds");
    const exit = yield* Fiber.await(fiber);

    assert.equal(exit._tag, "Failure");
    assert.deepEqual(harness.closeCalls, [{ threadId: "thread-1", terminalId: "setup-setup" }]);
  }).pipe(Effect.provide(harness.layer));
});

const threadId = "thread-1";
const terminalId = "setup-setup";
const event = { threadId, terminalId, sequence: 1, createdAt: "2026-01-01T00:00:00.000Z" };

const openSnapshot = (history: string): TerminalSessionSnapshot => ({
  threadId,
  terminalId,
  cwd: "/repo/.t3/worktrees/feature",
  worktreePath: null,
  status: "running",
  pid: 123,
  history,
  exitCode: null,
  exitSignal: null,
  label: "zsh",
  updatedAt: "2026-01-01T00:00:00.000Z",
});

const makeHarness = Effect.fn(function* (options: {
  readonly history?: string;
  readonly opening?: Deferred.Deferred<void>;
  readonly shell?: string | null;
}) {
  const listeners = new Set<(event: TerminalEvent) => Effect.Effect<void>>();
  const writes = yield* Queue.unbounded<string>();
  const outputLines = yield* Queue.unbounded<string>();
  const terminals = Layer.mock(TerminalManager.TerminalManager)({
    open: () =>
      (options.opening
        ? Deferred.succeed(options.opening, undefined).pipe(Effect.andThen(Effect.never))
        : Effect.void
      ).pipe(Effect.as(openSnapshot(options.history ?? ""))),
    getShell: () =>
      options.shell === null
        ? Effect.fail(new TerminalNotRunningError({ threadId, terminalId }))
        : Effect.succeed(options.shell ?? "/bin/zsh"),
    subscribe: (listener) =>
      Effect.sync(() => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      }),
    write: (input) => Queue.offer(writes, input.data).pipe(Effect.asVoid),
    closeIdle: () => Effect.void,
  });
  const runner = yield* ProjectSetupScriptRunner.make.pipe(
    Effect.provide(
      Layer.mergeAll(
        terminals,
        Layer.mock(ProjectService.ProjectService)({}),
        Layer.mock(ProjectionStore.ProjectionStoreV2)({
          getThreadShell: () => Effect.succeed(null),
        }),
        ServerSettings.layerTest(),
        NodeServices.layer,
      ),
    ),
  );
  const start = runner.runForThread({
    threadId,
    worktreePath: "/repo/.t3/worktrees/feature",
    observeCompletion: { onOutputLine: (line) => Queue.offer(outputLines, line) },
    project: {
      id: ProjectId.make("project-1"),
      workspaceRoot: "/repo",
      scripts: [
        {
          id: "setup",
          name: "Setup",
          command: "vp i",
          icon: "configure",
          runOnWorktreeCreate: true,
        },
      ],
    },
  });
  const emit = (terminalEvent: TerminalEvent) =>
    Effect.forEach([...listeners], (listener) => listener(terminalEvent), { discard: true });
  return { start, listeners, writes, outputLines, emit };
});

const setup = Effect.fn(function* (
  options: {
    readonly history?: string;
    readonly shell?: string | null;
  } = {},
) {
  const harness = yield* makeHarness(options);
  const result = yield* harness.start;
  const completion = result.status === "started" ? result.completion : undefined;
  if (!completion) return yield* Effect.die("setup did not start an observed run");
  return { ...harness, result, completion };
});

describe("ProjectSetupScriptRunner", () => {
  it.effect("writes immediately when the spawned fallback is PowerShell", () =>
    Effect.gen(function* () {
      const { writes } = yield* setup({
        shell: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
      });
      expect(yield* Queue.take(writes)).toContain("$global:LASTEXITCODE");
    }),
  );

  it.effect("shows a startup prompt and types only once the line editor starts", () =>
    Effect.gen(function* () {
      const { result, writes, outputLines, emit } = yield* setup();
      expect(result).toMatchObject({ status: "started", terminalId });

      yield* emit({ ...event, type: "output", data: "Missing Node.\r\nInstall it? [y/N]: " });
      yield* emit({ ...event, type: "activity", hasRunningSubprocess: true, label: "fnm" });
      yield* TestClock.adjust("1 minute");
      expect(yield* Queue.size(writes)).toBe(0);
      expect(yield* Queue.takeAll(outputLines)).toEqual(["Missing Node.", "Install it? [y/N]:"]);

      yield* emit({ ...event, type: "activity", hasRunningSubprocess: false, label: "zsh" });
      yield* emit({ ...event, type: "output", data: "\r\n% \x1b[?2004h" });
      expect(yield* Queue.take(writes)).toMatch(/^ \( vp i\r\);/);
    }),
  );

  it.effect("types into a quiet shell that has no line editor", () =>
    Effect.gen(function* () {
      const { writes } = yield* setup();
      yield* TestClock.adjust("3 seconds");
      expect(yield* Queue.take(writes)).toMatch(/^ \( vp i\r\);/);
    }),
  );

  it.effect("ignores line editor state restored from an earlier shell", () =>
    Effect.gen(function* () {
      const { writes, emit } = yield* setup({ history: "old run\r\n% \x1b[?2004h" });
      yield* emit({ ...event, type: "activity", hasRunningSubprocess: true, label: "fnm" });
      yield* TestClock.adjust("1 minute");
      expect(yield* Queue.size(writes)).toBe(0);
    }),
  );

  it.effect("forgets a busy startup child when the shell restarts", () =>
    Effect.gen(function* () {
      const { writes, emit } = yield* setup();
      yield* emit({ ...event, type: "activity", hasRunningSubprocess: true, label: "fnm" });
      yield* TestClock.adjust("1 minute");
      expect(yield* Queue.size(writes)).toBe(0);
      yield* emit({ ...event, type: "restarted", snapshot: openSnapshot("") });
      // The restart lands inside a quiet window, so the next full window decides.
      yield* TestClock.adjust("6 seconds");
      expect(yield* Queue.take(writes)).toMatch(/^ \( vp i\r\);/);
    }),
  );

  it.effect("drops its terminal listeners when cancelled while the terminal opens", () =>
    Effect.gen(function* () {
      const opening = yield* Deferred.make<void>();
      const { start, listeners } = yield* makeHarness({ opening });
      const fiber = yield* Effect.forkChild(start);
      yield* Deferred.await(opening);
      expect(listeners.size).toBe(2);
      yield* Fiber.interrupt(fiber);
      expect(listeners.size).toBe(0);
    }),
  );

  it.effect.each([false, true])(
    "does not type into a shell that exits during startup (before shell lookup: %s)",
    (beforeShellLookup) =>
      Effect.gen(function* () {
        const { completion, writes, emit, listeners } = yield* setup(
          beforeShellLookup ? { shell: null } : {},
        );
        if (!beforeShellLookup) {
          yield* emit({ ...event, type: "exited", exitCode: 1, exitSignal: null });
        }
        expect(yield* completion).toMatchObject({ exitCode: null });
        yield* TestClock.adjust("1 minute");
        expect(yield* Queue.size(writes)).toBe(0);
        expect(listeners.size).toBe(0);
      }),
  );
});
