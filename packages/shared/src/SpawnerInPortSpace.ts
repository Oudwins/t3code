import * as Redacted from "effect/Redacted";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import type { SpawnRewriter } from "./ThreadPortSpace.ts";

/**
 * `command` run through the namespace. The environment and working directory
 * travel inside the rewritten spawn, so the process itself starts with neither.
 */
export const commandInPortSpace = (
  command: ChildProcess.Command,
  rewrite: SpawnRewriter,
): ChildProcess.Command => {
  if (command._tag === "PipedCommand") {
    return ChildProcess.pipeTo(
      commandInPortSpace(command.left, rewrite),
      commandInPortSpace(command.right, rewrite),
      command.options,
    );
  }
  const { options } = command;
  // The helper's prologue needs plain text; the rewritten process is spawned like any other.
  const reveal = (word: string | Redacted.Redacted<string>) =>
    Redacted.isRedacted(word) ? Redacted.value(word) : word;
  const args = command.args.map(reveal);
  const env = Object.fromEntries(
    Object.entries(
      options.extendEnv ? { ...process.env, ...options.env } : (options.env ?? process.env),
    ).map(([key, value]) => [key, value === undefined ? undefined : reveal(value)]),
  );
  // The shell is what Node would have run, now started by the helper instead.
  const target = options.shell
    ? {
        command: options.shell === true ? "/bin/sh" : options.shell,
        args: ["-c", [command.command, ...args].join(" ")],
      }
    : { command: command.command, args };
  const wrapped = rewrite({
    ...target,
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    env,
  });
  return ChildProcess.make(wrapped.command, wrapped.args, {
    ...options,
    cwd: undefined,
    env: wrapped.env,
    extendEnv: false,
    shell: false,
  });
};

/** A spawner whose every process starts in the namespace `rewrite` targets. */
export const spawnerInPortSpace = (
  spawner: ChildProcessSpawner.ChildProcessSpawner["Service"],
  rewrite: SpawnRewriter,
): ChildProcessSpawner.ChildProcessSpawner["Service"] =>
  ChildProcessSpawner.make((command) => spawner.spawn(commandInPortSpace(command, rewrite)));
