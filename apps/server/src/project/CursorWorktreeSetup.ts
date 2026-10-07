/**
 * Reads the setup entry of Cursor's `.cursor/worktrees.json` and turns it into
 * a worktree setup script, so a repository that already configures worktree
 * setup for Cursor needs no second config here.
 *
 * Like Cursor, the worktree is searched first and the project root second.
 * Missing, unreadable, or invalid files are treated as absent.
 *
 * @module CursorWorktreeSetup
 */
import type { ProjectScript } from "@t3tools/contracts";
import { fromLenientJson } from "@t3tools/shared/schemaJson";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

export const CURSOR_SETUP_SCRIPT_ID = "cursor-worktree-setup";

// Either an array of shell commands or the path of a script, relative to the file.
const SetupEntry = Schema.Union([Schema.Array(Schema.String), Schema.String]);

const CursorWorktreesFile = Schema.Struct({
  "setup-worktree": Schema.optionalKey(SetupEntry),
  "setup-worktree-unix": Schema.optionalKey(SetupEntry),
  "setup-worktree-windows": Schema.optionalKey(SetupEntry),
});

const decodeCursorWorktreesFile = Schema.decodeEffect(fromLenientJson(CursorWorktreesFile));

export interface CursorSetupScriptInput {
  readonly worktreePath: string;
  readonly projectRoot: string;
  readonly platform: NodeJS.Platform;
  /** The shell the setup terminal will run; decides how a script path is quoted. */
  readonly shell: "posix" | "fish" | "powershell";
}

export const makeCursorSetupLoader = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const warn = (operation: "read" | "decode", filePath: string, cause: unknown) =>
    Effect.logWarning(`Failed to ${operation} ${filePath}; ignoring it.`).pipe(
      Effect.annotateLogs({ operation, filePath, cause: String(cause) }),
    );

  const commandFor = (
    file: typeof CursorWorktreesFile.Type,
    filePath: string,
    input: CursorSetupScriptInput,
  ): string | null => {
    const entry =
      file[input.platform === "win32" ? "setup-worktree-windows" : "setup-worktree-unix"] ??
      file["setup-worktree"];
    if (entry === undefined) return null;
    if (typeof entry === "string") {
      if (entry.trim().length === 0) return null;
      const scriptPath = path.resolve(path.dirname(filePath), entry);
      return input.shell === "powershell"
        ? `& '${scriptPath.replaceAll("'", "''")}'`
        : `sh '${scriptPath.replaceAll("'", "'\\''")}'`;
    }
    const commands = entry.filter((command) => command.trim().length > 0);
    return commands.length > 0 ? commands.join("\n") : null;
  };

  return Effect.fn("loadCursorSetupScript")(function* (input: CursorSetupScriptInput) {
    for (const directory of [input.worktreePath, input.projectRoot]) {
      const filePath = path.join(directory, ".cursor", "worktrees.json");
      const raw = yield* fileSystem.readFileString(filePath).pipe(
        Effect.asSome,
        Effect.catchTags({
          PlatformError: (error) =>
            error.reason._tag === "NotFound"
              ? Effect.succeedNone
              : warn("read", filePath, error).pipe(Effect.as(Option.none<string>())),
        }),
      );
      if (Option.isNone(raw)) continue;
      const file = yield* decodeCursorWorktreesFile(raw.value).pipe(
        Effect.asSome,
        Effect.catchTags({
          SchemaError: (error) => warn("decode", filePath, error).pipe(Effect.as(Option.none())),
        }),
      );
      if (Option.isNone(file)) continue;
      const command = commandFor(file.value, filePath, input);
      if (command === null) continue;
      return Option.some<ProjectScript>({
        id: CURSOR_SETUP_SCRIPT_ID,
        name: "Cursor worktree setup",
        command,
        icon: "configure",
        runOnWorktreeCreate: true,
      });
    }
    return Option.none<ProjectScript>();
  });
});
