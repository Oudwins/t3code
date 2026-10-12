// @effect-diagnostics nodeBuiltinImport:off - the SDK needs a synchronous Node ChildProcess back.
import * as NodeChildProcess from "node:child_process";

import type { Options, SpawnedProcess, SpawnOptions } from "@anthropic-ai/claude-agent-sdk";
import * as Effect from "effect/Effect";

import {
  type SpawnRewriter,
  type ThreadPortSpaceHandle,
  urlInPortSpace,
} from "@t3tools/shared/ThreadPortSpace";

const STDERR_TAIL_CHARS = 4096;

export interface ClaudeSpawnFailure {
  readonly code: number;
  readonly stderrTail: string;
}

/**
 * `spawnClaudeCodeProcess` for threads in a port space. The SDK's own spawner
 * reads stderr to build exit errors and does not run for a custom one, so the
 * tail is handed to `onFailure` instead.
 */
export const spawnClaudeInPortSpace = (
  rewrite: SpawnRewriter,
  options: SpawnOptions,
  onFailure: (failure: ClaudeSpawnFailure) => void,
): SpawnedProcess => {
  const wrapped = rewrite({
    command: options.command,
    args: options.args,
    cwd: options.cwd,
    env: options.env,
  });
  const child = NodeChildProcess.spawn(wrapped.command, [...wrapped.args], {
    env: wrapped.env,
    stdio: ["pipe", "pipe", "pipe"],
    signal: options.signal,
    windowsHide: true,
  });

  let stderrTail = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderrTail = (stderrTail + chunk).slice(-STDERR_TAIL_CHARS);
  });
  // `close`, not `exit`: stderr can still hold the last lines when `exit` fires.
  child.once("close", (code) => {
    if (code !== null && code !== 0) onFailure({ code, stderrTail });
  });
  return child;
};

/**
 * Query options for a Claude process that runs in a thread's port space: it is
 * spawned through the namespace, and T3's MCP endpoint, which points at the
 * host's loopback, is reached at the host address instead.
 */
export const claudeOptionsInPortSpace = Effect.fn("claudeOptionsInPortSpace")(function* <
  O extends Pick<Options, "mcpServers">,
>(options: O, handle: ThreadPortSpaceHandle, onFailure: (failure: ClaudeSpawnFailure) => void) {
  const hostAddress = yield* handle.hostAddress;
  const mcpServers =
    options.mcpServers === undefined
      ? options.mcpServers
      : Object.fromEntries(
          Object.entries(options.mcpServers).map(([name, config]) => [
            name,
            "url" in config ? { ...config, url: urlInPortSpace(config.url, hostAddress) } : config,
          ]),
        );
  return {
    ...options,
    ...(mcpServers === undefined ? {} : { mcpServers }),
    spawnClaudeCodeProcess: (spawnOptions: SpawnOptions) =>
      spawnClaudeInPortSpace(handle.rewrite, spawnOptions, onFailure),
  };
});
