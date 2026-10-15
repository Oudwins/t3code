import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  OrchestrationV2AppThreadJson,
  OrchestrationV2ProviderSessionJson,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ThreadId,
  type OrchestrationV2AppThread,
  type OrchestrationV2ProviderSession,
  type OrchestrationV2ThreadShell,
  type TerminalSummary,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerConfig from "./config.ts";
import * as GitManager from "./git/GitManager.ts";
import * as WorktreeManager from "./git/WorktreeManager.ts";
import * as WorktreePool from "./git/WorktreePool.ts";
import { CodexProviderCapabilitiesV2 } from "./orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as Orchestrator from "./orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "./orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "./orchestration-v2/ProjectStore.ts";
import * as ProviderSessionManager from "./orchestration-v2/ProviderSessionManager.ts";
import * as SqlitePersistence from "./persistence/Sqlite.ts";
import * as ServerSettings from "./serverSettings.ts";
import * as StorageCleanup from "./storageCleanup.ts";
import * as TerminalManager from "./terminal/Manager.ts";
import * as GitVcsDriver from "./vcs/GitVcsDriver.ts";
import * as VcsDriverRegistry from "./vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "./vcs/VcsProcess.ts";

const DAY_MS = 86_400_000;
const projectId = ProjectId.make("project-1");
const threadId = ThreadId.make("thread-1");
const sessionId = ProviderSessionId.make("session-1");
const encodeSession = Schema.encodeEffect(
  Schema.fromJsonString(OrchestrationV2ProviderSessionJson),
);
const encodeThread = Schema.encodeEffect(Schema.fromJsonString(OrchestrationV2AppThreadJson));

const withScratch = <A, E, R>(
  body: (input: { readonly baseDir: string }) => Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    // Cleanup refuses a worktree whose real path differs, and macOS temp dirs are symlinks.
    const baseDir = yield* fileSystem
      .makeTempDirectoryScoped({ prefix: "t3-storage-cleanup-" })
      .pipe(Effect.flatMap(fileSystem.realPath));
    return yield* body({ baseDir });
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

/**
 * Sweeps one 30-day-old thread whose worktree has uncommitted changes, an
 * ignored file, an open terminal and a live provider session, with a 7-day rule.
 * `busy: false` leaves it clean and idle. A "deleted" thread is no longer in the
 * shell snapshot and only survives as a tombstoned projection row.
 */
const sweepWorktree = (options: {
  readonly force: boolean;
  readonly threadState: "open" | "settled" | "archived" | "deleted";
  readonly threadStatus?: OrchestrationV2ThreadShell["status"];
  readonly busy?: boolean;
  readonly reuse?: boolean;
}) =>
  withScratch(({ baseDir }) =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const git = yield* GitVcsDriver.GitVcsDriver;
      const sql = yield* SqlClient.SqlClient;
      const repo = path.join(baseDir, "repo");
      const worktree = path.join(baseDir, "worktrees", "feature");
      const run = (cwd: string, ...args: ReadonlyArray<string>) =>
        git.execute({
          operation: "StorageCleanup.test",
          cwd,
          args: ["-c", "user.name=T3", "-c", "user.email=t3@example.test", ...args],
        });

      yield* fileSystem.makeDirectory(repo, { recursive: true });
      yield* run(repo, "init", "-b", "main");
      yield* fileSystem.writeFileString(path.join(repo, ".gitignore"), "secrets.env\n");
      yield* fileSystem.writeFileString(path.join(repo, "tracked.txt"), "one\n");
      yield* run(repo, "add", ".");
      yield* run(repo, "-c", "commit.gpgsign=false", "commit", "-m", "init");
      yield* run(repo, "worktree", "add", "-b", "feature", worktree);
      const busy = options.busy ?? true;
      if (busy) {
        yield* fileSystem.writeFileString(path.join(worktree, "tracked.txt"), "changed\n");
        yield* fileSystem.writeFileString(path.join(worktree, "secrets.env"), "TOKEN=1\n");
      }

      const nowMs = yield* Clock.currentTimeMillis;
      const now = DateTime.makeUnsafe(nowMs);
      const session = {
        id: sessionId,
        driver: ProviderDriverKind.make("codex"),
        providerInstanceId: ProviderInstanceId.make("codex"),
        status: "ready",
        cwd: worktree,
        model: null,
        capabilities: CodexProviderCapabilitiesV2,
        createdAt: now,
        updatedAt: now,
        lastError: null,
      } satisfies OrchestrationV2ProviderSession;
      if (busy) {
        yield* sql`
          INSERT INTO orchestration_v2_projection_provider_sessions
            (provider_session_id, thread_id, provider, status, model, updated_at, payload_json)
          VALUES (
            ${sessionId}, ${threadId}, 'codex', 'ready', NULL, ${DateTime.formatIso(now)},
            ${yield* encodeSession(session)}
          )
        `;
      }
      if (options.threadState === "deleted") {
        const providerInstanceId = ProviderInstanceId.make("codex");
        const deletedThread = {
          createdBy: "user",
          creationSource: "web",
          id: threadId,
          projectId,
          title: "Deleted thread",
          providerInstanceId,
          modelSelection: { instanceId: providerInstanceId, model: "gpt-5" },
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: "feature",
          worktreePath: worktree,
          activeProviderThreadId: null,
          lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
          forkedFrom: null,
          createdAt: DateTime.makeUnsafe(nowMs - 30 * DAY_MS),
          updatedAt: now,
          archivedAt: null,
          settledOverride: null,
          settledAt: null,
          lastVisitedAt: null,
          deletedAt: now,
        } satisfies OrchestrationV2AppThread;
        yield* sql`
          INSERT INTO projection_projects (
            project_id, title, workspace_root, default_model_selection_json,
            scripts_json, created_at, updated_at, deleted_at
          ) VALUES (
            ${projectId}, 'Project', ${repo}, NULL,
            '[]', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', NULL
          )
        `;
        yield* sql`
          INSERT INTO orchestration_v2_projection_threads (
            thread_id, project_id, title, default_provider, runtime_mode, interaction_mode,
            created_at, updated_at, archived_at, deleted_at, payload_json
          ) VALUES (
            ${threadId}, ${projectId}, 'Deleted thread', 'codex', 'full-access', 'default',
            ${DateTime.formatIso(deletedThread.createdAt)}, ${DateTime.formatIso(now)}, NULL,
            ${DateTime.formatIso(now)}, ${yield* encodeThread(deletedThread)}
          )
        `;
      }

      // Only the fields cleanup reads.
      const thread = {
        id: threadId,
        projectId,
        branch: "feature",
        worktreePath: worktree,
        status: options.threadStatus ?? "idle",
        settledOverride: options.threadState === "settled" ? "settled" : null,
        settledAt:
          options.threadState === "settled" ? DateTime.makeUnsafe(nowMs - 30 * DAY_MS) : null,
        archivedAt: options.threadState === "archived" ? now : null,
        activeRunId: null,
        pendingBackgroundTasks: [],
        pendingRuntimeRequest: null,
        latestRunId: null,
        latestRunRequestedAt: null,
        latestRunStartedAt: null,
        latestRunCompletedAt: null,
        latestUserMessageAt: null,
        createdAt: DateTime.makeUnsafe(nowMs - 30 * DAY_MS),
        updatedAt: DateTime.makeUnsafe(nowMs - 30 * DAY_MS),
      } satisfies Partial<OrchestrationV2ThreadShell>;
      const terminal = {
        threadId,
        terminalId: "terminal-1",
        cwd: worktree,
        worktreePath: worktree,
        status: "running",
        pid: null,
        exitCode: null,
        exitSignal: null,
        hasRunningSubprocess: true,
        label: "dev server",
        updatedAt: DateTime.formatIso(now),
      } satisfies TerminalSummary;

      const closedTerminals: Array<string> = [];
      const closedSessions: Array<string> = [];
      const sweepStarted = yield* Deferred.make<void>();
      // The real manager and pool sit over the real driver; only the repository
      // routing and status cache they reach for are faked.
      const gitManager = Layer.mock(GitManager.GitManager)({ invalidateStatus: () => Effect.void });
      const registry = Layer.mock(VcsDriverRegistry.VcsDriverRegistry)({
        resolve: () => Effect.succeed({ kind: "git" } as never),
      });
      const manager = WorktreeManager.layer.pipe(
        Layer.provide(WorktreePool.layer),
        Layer.provide(registry),
      );
      const fakes = Layer.mergeAll(
        Layer.mock(ProjectStore.ProjectStoreV2)({
          listShells: () => Effect.succeed([{ id: projectId, workspaceRoot: repo } as never]),
        }),
        Layer.mock(ProjectionStore.ProjectionStoreV2)({
          getThreadWorktreePaths: () =>
            Effect.succeed(
              options.threadState === "deleted" ? [] : [{ threadId, worktreePath: worktree }],
            ),
          getThreadShell: () => Effect.succeed(thread as unknown as OrchestrationV2ThreadShell),
          getShellSnapshot: (snapshotOptions) =>
            Deferred.succeed(sweepStarted, undefined).pipe(
              Effect.as({
                threads:
                  options.threadState === "deleted" ||
                  (snapshotOptions?.location === "archive") !== (options.threadState === "archived")
                    ? []
                    : [thread],
              } as never),
            ),
        }),
        Layer.mock(Orchestrator.OrchestratorV2)({ streamDomainEvents: Stream.empty }),
        gitManager,
        manager,
        Layer.mock(TerminalManager.TerminalManager)({
          subscribeMetadata: (listener) =>
            listener({ type: "snapshot", terminals: busy ? [terminal] : [] }).pipe(
              Effect.as(() => {}),
            ),
          close: (input) => Effect.sync(() => closedTerminals.push(`${input.terminalId}`)),
        }),
        Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({
          close: (id) => Effect.sync(() => closedSessions.push(id)),
        }),
      );
      const context = yield* Layer.build(StorageCleanup.layer).pipe(Effect.provide(fakes));
      const cleanup = Context.get(context, StorageCleanup.StorageCleanup);
      const report = yield* cleanup.runNow;

      const removed = !(yield* fileSystem.exists(worktree));
      const standby = (yield* sql<{ path: string }>`SELECT path FROM worktree_standby`).map(
        (row) => row.path,
      );
      // What is left on disk when the worktree was kept or parked.
      const kept = standby[0] ?? (removed ? undefined : worktree);
      const checkout =
        kept === undefined
          ? null
          : {
              branch: (yield* run(kept, "branch", "--show-current")).stdout.trim(),
              tracked: yield* fileSystem.readFileString(path.join(kept, "tracked.txt")),
              ignoredFileKept: yield* fileSystem.exists(path.join(kept, "secrets.env")),
            };
      // Resuming the thread recreates its checkout at the path it recorded.
      const resumedBranch =
        standby.length === 0
          ? null
          : yield* run(repo, "worktree", "add", worktree, "feature").pipe(
              Effect.andThen(run(worktree, "branch", "--show-current")),
              Effect.map((result) => result.stdout.trim()),
            );
      return {
        report,
        removed,
        branches: (yield* run(repo, "branch", "--list", "feature")).stdout,
        closedTerminals,
        closedSessions,
        standby,
        standbyDirectories: standby.map((parked) => path.dirname(parked)),
        parkedDirectory: path.join(baseDir, "worktrees", "parked-wt"),
        checkout,
        resumedBranch,
      };
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          ServerSettings.layerTest({
            storageCleanup: {
              worktreeAfterDays: 7,
              worktreeForce: options.force,
              worktreeOnDelete: options.threadState === "deleted",
            },
            worktreeReuse: { enabled: options.reuse ?? false },
          }),
          GitVcsDriver.layer.pipe(Layer.provide(VcsProcess.layer)),
        ).pipe(
          Layer.provideMerge(SqlitePersistence.layerMemory),
          Layer.provideMerge(ServerConfig.layerTest(baseDir, baseDir)),
        ),
      ),
    ),
  );

it.live("keeps a worktree with uncommitted changes, ignored files, a terminal or a session", () =>
  Effect.gen(function* () {
    const result = yield* sweepWorktree({ force: false, threadState: "settled" });
    assert.isFalse(result.removed);
    assert.deepStrictEqual(result.closedTerminals, []);
    assert.deepStrictEqual(result.closedSessions, []);
  }),
);

it.live("force removal stops a settled thread's terminals and sessions and keeps the branch", () =>
  Effect.gen(function* () {
    const result = yield* sweepWorktree({ force: true, threadState: "settled" });
    assert.isTrue(result.removed);
    assert.deepStrictEqual(result.closedTerminals, ["terminal-1"]);
    assert.deepStrictEqual(result.closedSessions, [sessionId]);
    assert.include(result.branches, "feature");
  }),
);

it.live("force removal also applies to an archived thread", () =>
  Effect.gen(function* () {
    const result = yield* sweepWorktree({ force: true, threadState: "archived" });
    assert.isTrue(result.removed);
  }),
);

it.live("force removal keeps the worktree of a thread that is neither settled nor archived", () =>
  Effect.gen(function* () {
    const result = yield* sweepWorktree({ force: true, threadState: "open" });
    assert.isFalse(result.removed);
    assert.deepStrictEqual(result.closedTerminals, []);
    assert.deepStrictEqual(result.closedSessions, []);
  }),
);

it.live("force removal still keeps a worktree whose thread is running", () =>
  Effect.gen(function* () {
    const result = yield* sweepWorktree({
      force: true,
      threadState: "settled",
      threadStatus: "running",
    });
    assert.isFalse(result.removed);
    assert.deepStrictEqual(result.closedTerminals, []);
    assert.deepStrictEqual(result.closedSessions, []);
  }),
);

it.live("parks a deleted thread's worktree for reuse instead of removing it", () =>
  Effect.gen(function* () {
    const result = yield* sweepWorktree({ force: true, threadState: "deleted", reuse: true });
    assert.isTrue(result.removed);
    assert.deepStrictEqual(result.standbyDirectories, [result.parkedDirectory]);
    assert.strictEqual(result.report.bytesFreed, 0);
    assert.match(result.report.entries[0]!.reason, /released for reuse/);
    // Detached, reset to the commit, ignored files kept, branch kept for the next claim.
    assert.deepStrictEqual(result.checkout, {
      branch: "",
      tracked: "one\n",
      ignoredFileKept: true,
    });
    assert.deepStrictEqual(result.closedTerminals, ["terminal-1"]);
    assert.deepStrictEqual(result.closedSessions, [sessionId]);
    assert.include(result.branches, "feature");
  }),
);

it.live("parks a clean deleted thread's worktree without forcing", () =>
  Effect.gen(function* () {
    const result = yield* sweepWorktree({
      force: false,
      threadState: "deleted",
      reuse: true,
      busy: false,
    });
    assert.isTrue(result.removed);
    assert.strictEqual(result.standby.length, 1);
    assert.strictEqual(result.checkout?.branch, "");
  }),
);

it.live("removes a deleted thread's worktree when reuse is off", () =>
  Effect.gen(function* () {
    const result = yield* sweepWorktree({ force: true, threadState: "deleted", reuse: false });
    assert.isTrue(result.removed);
    assert.deepStrictEqual(result.standby, []);
    assert.include(result.branches, "feature");
  }),
);

it.live("parks a live thread's worktree, which resume recreates on its own branch", () =>
  Effect.gen(function* () {
    const result = yield* sweepWorktree({ force: true, threadState: "settled", reuse: true });
    assert.isTrue(result.removed);
    assert.deepStrictEqual(result.standbyDirectories, [result.parkedDirectory]);
    assert.strictEqual(result.report.bytesFreed, 0);
    assert.match(result.report.entries[0]!.reason, /released for reuse/);
    assert.strictEqual(result.checkout?.branch, "");
    assert.deepStrictEqual(result.closedTerminals, ["terminal-1"]);
    assert.deepStrictEqual(result.closedSessions, [sessionId]);
    assert.strictEqual(result.resumedBranch, "feature");
  }),
);

it.live("keeps a live thread's worktree with uncommitted changes when cleanup may not force", () =>
  Effect.gen(function* () {
    const result = yield* sweepWorktree({ force: false, threadState: "settled", reuse: true });
    assert.isFalse(result.removed);
    assert.deepStrictEqual(result.standby, []);
  }),
);
