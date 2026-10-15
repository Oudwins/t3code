import type { Options, SpawnOptions } from "@anthropic-ai/claude-agent-sdk";
import {
  type SpawnRewriter,
  type ThreadPortSpaceHandle,
  urlInPortSpace,
} from "@t3tools/shared/ThreadPortSpace";
import * as Effect from "effect/Effect";

/**
 * The SDK's spawn options run through a thread's namespace. The working
 * directory travels inside the rewritten spawn, so the helper starts without one.
 */
export const claudeSpawnInPortSpace = (
  options: SpawnOptions,
  rewrite: SpawnRewriter,
): SpawnOptions => {
  const wrapped = rewrite({
    command: options.command,
    args: options.args,
    cwd: options.cwd,
    env: options.env,
  });
  const { cwd: _cwd, ...rest } = options;
  return { ...rest, command: wrapped.command, args: [...wrapped.args], env: wrapped.env };
};

/**
 * MCP servers for a Claude process in a thread's port space: T3's endpoint,
 * which points at the host's loopback, is reached at the host address instead.
 */
export const claudeMcpServersInPortSpace = Effect.fn("claudeMcpServersInPortSpace")(function* (
  mcpServers: NonNullable<Options["mcpServers"]>,
  handle: ThreadPortSpaceHandle,
) {
  const hostAddress = yield* handle.hostAddress;
  return Object.fromEntries(
    Object.entries(mcpServers).map(([name, config]) => [
      name,
      "url" in config ? { ...config, url: urlInPortSpace(config.url, hostAddress) } : config,
    ]),
  );
});
