import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  OrchestrationV2ProviderSessionJson,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ThreadId,
  type OrchestrationV2ProviderSession,
  type OrchestrationV2ThreadShell,
  type TerminalSummary,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as ServerConfig from "./config.ts";
import * as GitManager from "./git/GitManager.ts";
import { CodexProviderCapabilitiesV2 } from "./orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as Orchestrator from "./orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "./orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "./orchestration-v2/ProjectStore.ts";
import * as ProviderSessionManager from "./orchestration-v2/ProviderSessionManager.ts";
import { SqlitePersistenceMemory } from "./persistence/Layers/Sqlite.ts";
import * as ServerSettings from "./serverSettings.ts";
import * as StorageCleanup from "./storageCleanup.ts";
import * as TerminalManager from "./terminal/Manager.ts";
import * as GitVcsDriver from "./vcs/GitVcsDriver.ts";
import * as VcsProcess from "./vcs/VcsProcess.ts";

const DAY_MS = 86_400_000;
const projectId = ProjectId.make("project-1");
const threadId = ThreadId.make("thread-1");
const sessionId = ProviderSessionId.make("session-1");
const encodeSession = Schema.encodeEffect(
  Schema.fromJsonString(OrchestrationV2ProviderSessionJson),
);

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
 */
const sweepBusyWorktree = (options: {
  readonly force: boolean;
  readonly threadState: "open" | "settled" | "archived";
  readonly threadStatus?: OrchestrationV2ThreadShell["status"];
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
      yield* fileSystem.writeFileString(path.join(worktree, "tracked.txt"), "changed\n");
      yield* fileSystem.writeFileString(path.join(worktree, "secrets.env"), "TOKEN=1\n");

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
      yield* sql`
        INSERT INTO orchestration_v2_projection_provider_sessions
          (provider_session_id, thread_id, provider, status, model, updated_at, payload_json)
        VALUES (
          ${sessionId}, ${threadId}, 'codex', 'ready', NULL, ${DateTime.formatIso(now)},
          ${yield* encodeSession(session)}
        )
      `;

      // Only the fields cleanup reads.
      const thread = {
        id: threadId,
        projectId,
        branch: "feature",
        worktreePath: worktree,
        status: options.threadStatus ?? "idle",
        settledOverride: options.threadState === "settled" ? "settled" : null,
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
      const fakes = Layer.mergeAll(
        Layer.mock(ProjectStore.ProjectStoreV2)({
          listShells: () => Effect.succeed([{ id: projectId, workspaceRoot: repo } as never]),
        }),
        Layer.mock(ProjectionStore.ProjectionStoreV2)({
          getShellSnapshot: (snapshotOptions) =>
            Deferred.succeed(sweepStarted, undefined).pipe(
              Effect.as({
                threads: snapshotOptions?.location === "archive" ? [] : [thread],
              } as never),
            ),
        }),
        Layer.mock(Orchestrator.OrchestratorV2)({ streamDomainEvents: Stream.empty }),
        Layer.mock(GitManager.GitManager)({ invalidateStatus: () => Effect.void }),
        Layer.mock(TerminalManager.TerminalManager)({
          subscribeMetadata: (listener) =>
            listener({ type: "snapshot", terminals: [terminal] }).pipe(Effect.as(() => {})),
          close: (input) => Effect.sync(() => closedTerminals.push(`${input.terminalId}`)),
        }),
        Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({
          close: (id) => Effect.sync(() => closedSessions.push(id)),
        }),
      );
      const cleanup = yield* StorageCleanup.make.pipe(Effect.provide(fakes));
      yield* cleanup.start();
      // The first sweep is queued by `start`; reading threads proves it began.
      yield* Deferred.await(sweepStarted);
      yield* cleanup.drain;

      return {
        removed: !(yield* fileSystem.exists(worktree)),
        branches: (yield* run(repo, "branch", "--list", "feature")).stdout,
        closedTerminals,
        closedSessions,
      };
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          ServerSettings.layerTest({
            storageCleanup: { worktreeAfterDays: 7, worktreeForce: options.force },
          }),
          GitVcsDriver.layer.pipe(Layer.provide(VcsProcess.layer)),
        ).pipe(
          Layer.provideMerge(SqlitePersistenceMemory),
          Layer.provideMerge(ServerConfig.layerTest(baseDir, baseDir)),
        ),
      ),
    ),
  );

it.live("keeps a worktree with uncommitted changes, ignored files, a terminal or a session", () =>
  Effect.gen(function* () {
    const result = yield* sweepBusyWorktree({ force: false, threadState: "settled" });
    assert.isFalse(result.removed);
    assert.deepStrictEqual(result.closedTerminals, []);
    assert.deepStrictEqual(result.closedSessions, []);
  }),
);

it.live("force removal stops a settled thread's terminals and sessions and keeps the branch", () =>
  Effect.gen(function* () {
    const result = yield* sweepBusyWorktree({ force: true, threadState: "settled" });
    assert.isTrue(result.removed);
    assert.deepStrictEqual(result.closedTerminals, ["terminal-1"]);
    assert.deepStrictEqual(result.closedSessions, [sessionId]);
    assert.include(result.branches, "feature");
  }),
);

it.live("force removal also applies to an archived thread", () =>
  Effect.gen(function* () {
    const result = yield* sweepBusyWorktree({ force: true, threadState: "archived" });
    assert.isTrue(result.removed);
  }),
);

it.live("force removal keeps the worktree of a thread that is neither settled nor archived", () =>
  Effect.gen(function* () {
    const result = yield* sweepBusyWorktree({ force: true, threadState: "open" });
    assert.isFalse(result.removed);
    assert.deepStrictEqual(result.closedTerminals, []);
    assert.deepStrictEqual(result.closedSessions, []);
  }),
);

it.live("force removal still keeps a worktree whose thread is running", () =>
  Effect.gen(function* () {
    const result = yield* sweepBusyWorktree({
      force: true,
      threadState: "settled",
      threadStatus: "running",
    });
    assert.isFalse(result.removed);
    assert.deepStrictEqual(result.closedTerminals, []);
    assert.deepStrictEqual(result.closedSessions, []);
  }),
);
