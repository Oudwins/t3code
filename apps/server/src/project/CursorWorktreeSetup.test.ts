import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import * as CursorWorktreeSetup from "./CursorWorktreeSetup.ts";

const makeTempDir = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  return yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3code-cursor-worktrees-" });
});

const writeCursorFile = Effect.fn("writeCursorFile")(function* (cwd: string, contents: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fileSystem
    .makeDirectory(path.join(cwd, ".cursor"), { recursive: true })
    .pipe(Effect.orDie);
  yield* fileSystem
    .writeFileString(path.join(cwd, ".cursor", "worktrees.json"), contents)
    .pipe(Effect.orDie);
});

const load = Effect.fn("loadCursorSetup")(function* (input: {
  readonly worktreePath: string;
  readonly projectRoot: string;
  readonly platform?: NodeJS.Platform;
  readonly shell?: "posix" | "fish" | "powershell";
}) {
  const loadCursorSetupScript = yield* CursorWorktreeSetup.makeCursorSetupLoader;
  return yield* loadCursorSetupScript({ platform: "darwin", shell: "posix", ...input });
});

describe("loadCursorSetupScript", () => {
  it.effect("joins the setup commands into one script and tolerates JSONC", () =>
    Effect.gen(function* () {
      const worktree = yield* makeTempDir;
      const root = yield* makeTempDir;
      yield* writeCursorFile(
        worktree,
        `{
          // Cursor files are plain JSON, but comments should not break us
          "setup-worktree": ["cp $ROOT_WORKTREE_PATH/.env ./.env", "", "pnpm i"],
        }`,
      );

      const script = yield* load({ worktreePath: worktree, projectRoot: root });

      expect(Option.getOrThrow(script)).toEqual({
        id: CursorWorktreeSetup.CURSOR_SETUP_SCRIPT_ID,
        name: "Cursor worktree setup",
        command: "cp $ROOT_WORKTREE_PATH/.env ./.env\npnpm i",
        icon: "configure",
        runOnWorktreeCreate: true,
      });
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("prefers the worktree's file and falls back to the project root", () =>
    Effect.gen(function* () {
      const worktree = yield* makeTempDir;
      const root = yield* makeTempDir;
      yield* writeCursorFile(root, `{ "setup-worktree": ["echo root"] }`);

      const fromRoot = yield* load({ worktreePath: worktree, projectRoot: root });
      expect(Option.getOrThrow(fromRoot).command).toBe("echo root");

      yield* writeCursorFile(worktree, `{ "setup-worktree": ["echo worktree"] }`);
      const fromWorktree = yield* load({ worktreePath: worktree, projectRoot: root });
      expect(Option.getOrThrow(fromWorktree).command).toBe("echo worktree");
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("picks the OS-specific key over the generic one", () =>
    Effect.gen(function* () {
      const worktree = yield* makeTempDir;
      yield* writeCursorFile(
        worktree,
        `{
          "setup-worktree": ["echo generic"],
          "setup-worktree-unix": ["echo unix"],
          "setup-worktree-windows": ["echo windows"]
        }`,
      );

      const unix = yield* load({ worktreePath: worktree, projectRoot: worktree });
      const windows = yield* load({
        worktreePath: worktree,
        projectRoot: worktree,
        platform: "win32",
        shell: "powershell",
      });

      expect(Option.getOrThrow(unix).command).toBe("echo unix");
      expect(Option.getOrThrow(windows).command).toBe("echo windows");
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("runs a script path relative to the file, quoted for the shell", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const worktree = yield* makeTempDir;
      yield* writeCursorFile(worktree, `{ "setup-worktree": "setup it's.sh" }`);
      const scriptPath = path.join(worktree, ".cursor", "setup it's.sh");

      const posix = yield* load({ worktreePath: worktree, projectRoot: worktree });
      const powershell = yield* load({
        worktreePath: worktree,
        projectRoot: worktree,
        shell: "powershell",
      });

      expect(Option.getOrThrow(posix).command).toBe(`sh '${scriptPath.replaceAll("'", "'\\''")}'`);
      expect(Option.getOrThrow(powershell).command).toBe(`& '${scriptPath.replaceAll("'", "''")}'`);
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("ignores missing, invalid, and empty files", () =>
    Effect.gen(function* () {
      const worktree = yield* makeTempDir;
      const root = yield* makeTempDir;

      expect(Option.isNone(yield* load({ worktreePath: worktree, projectRoot: root }))).toBe(true);

      yield* writeCursorFile(worktree, `{ "setup-worktree": 42 }`);
      expect(Option.isNone(yield* load({ worktreePath: worktree, projectRoot: root }))).toBe(true);

      yield* writeCursorFile(worktree, `{ "setup-worktree": [] }`);
      expect(Option.isNone(yield* load({ worktreePath: worktree, projectRoot: root }))).toBe(true);

      yield* writeCursorFile(worktree, `{ "other": ["echo hi"] }`);
      expect(Option.isNone(yield* load({ worktreePath: worktree, projectRoot: root }))).toBe(true);
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );
});
