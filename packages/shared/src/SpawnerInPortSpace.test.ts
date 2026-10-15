import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import { commandInPortSpace, spawnerInPortSpace } from "./SpawnerInPortSpace.ts";
import type { SpawnRewriter } from "./ThreadPortSpace.ts";

type RewriteInput = Parameters<SpawnRewriter>[0];

const recordingRewriter = (seen: Array<RewriteInput>): SpawnRewriter => {
  return (input) => {
    seen.push(input);
    return {
      command: "helper",
      args: ["exec", "--", input.command, ...input.args],
      env: { PATH: "/usr/bin", T3_PORTSPACE_PROLOGUE: "" },
    };
  };
};

const standard = (command: ChildProcess.Command) => {
  if (command._tag !== "StandardCommand") throw new Error("expected a standard command");
  return command;
};

describe("commandInPortSpace", () => {
  it("moves cwd and env into the rewrite and starts the process with neither", () => {
    const seen: Array<RewriteInput> = [];
    const wrapped = standard(
      commandInPortSpace(
        ChildProcess.make("agent", ["--acp"], {
          cwd: "/work",
          env: { TOKEN: "x" },
          extendEnv: false,
          detached: true,
        }),
        recordingRewriter(seen),
      ),
    );

    expect(seen).toEqual([
      { command: "agent", args: ["--acp"], cwd: "/work", env: { TOKEN: "x" } },
    ]);
    expect(wrapped.command).toBe("helper");
    expect(wrapped.args).toEqual(["exec", "--", "agent", "--acp"]);
    expect(wrapped.options.cwd).toBeUndefined();
    expect(wrapped.options.env).toEqual({ PATH: "/usr/bin", T3_PORTSPACE_PROLOGUE: "" });
    expect(wrapped.options.extendEnv).toBe(false);
    expect(wrapped.options.detached).toBe(true);
  });

  it("hands the rewrite the host environment the spawner would have used", () => {
    const seen: Array<RewriteInput> = [];
    commandInPortSpace(
      ChildProcess.make("agent", [], { env: { ONLY_ME: "1" }, extendEnv: true }),
      recordingRewriter(seen),
    );
    commandInPortSpace(ChildProcess.make("agent", []), recordingRewriter(seen));

    expect(seen[0]?.env).toEqual({ ...process.env, ONLY_ME: "1" });
    expect(seen[0]).not.toHaveProperty("cwd");
    expect(seen[1]?.env).toEqual(process.env);
  });

  it("starts the shell itself for a shell command", () => {
    const seen: Array<RewriteInput> = [];
    const wrapped = standard(
      commandInPortSpace(
        ChildProcess.make("npm run dev && echo done", [], { shell: true }),
        recordingRewriter(seen),
      ),
    );

    expect(seen[0]).toMatchObject({ command: "/bin/sh", args: ["-c", "npm run dev && echo done"] });
    expect(wrapped.options.shell).toBe(false);
  });

  it("wraps both sides of a pipeline", () => {
    const seen: Array<RewriteInput> = [];
    const piped = commandInPortSpace(
      ChildProcess.pipeTo(ChildProcess.make("producer", []), ChildProcess.make("consumer", ["-"]), {
        from: "stderr",
      }),
      recordingRewriter(seen),
    );

    if (piped._tag !== "PipedCommand") throw new Error("expected a piped command");
    expect(standard(piped.left).args).toEqual(["exec", "--", "producer"]);
    expect(standard(piped.right).args).toEqual(["exec", "--", "consumer", "-"]);
    expect(piped.options.from).toBe("stderr");
    expect(seen.map((input) => input.command)).toEqual(["producer", "consumer"]);
  });
});

describe("spawnerInPortSpace", () => {
  it.effect("spawns the rewritten command", () =>
    Effect.gen(function* () {
      const spawned: Array<ChildProcess.Command> = [];
      const base = ChildProcessSpawner.make((command) => {
        spawned.push(command);
        return Effect.die("stub spawner");
      });
      const spawner = spawnerInPortSpace(base, recordingRewriter([]));

      yield* Effect.exit(Effect.scoped(spawner.spawn(ChildProcess.make("agent", ["--acp"]))));

      expect(spawned.map((command) => standard(command).command)).toEqual(["helper"]);
      expect(standard(spawned[0]!).args).toEqual(["exec", "--", "agent", "--acp"]);
    }),
  );
});
