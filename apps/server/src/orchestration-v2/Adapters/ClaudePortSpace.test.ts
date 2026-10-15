import type { Options, SpawnOptions } from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it } from "@effect/vitest";
import type { SpawnRewriter, ThreadPortSpaceHandle } from "@t3tools/shared/ThreadPortSpace";
import * as Effect from "effect/Effect";

import { claudeMcpServersInPortSpace, claudeSpawnInPortSpace } from "./ClaudePortSpace.ts";

describe("claudeSpawnInPortSpace", () => {
  it("runs what the port space rewrites the spawn to, carrying the cwd and env inside it", () => {
    const signal = new AbortController().signal;
    const seen: Array<Parameters<SpawnRewriter>[0]> = [];
    const rewrite: SpawnRewriter = (input) => {
      seen.push(input);
      return {
        command: "sudo",
        args: ["helper", "exec", "--", input.command, ...input.args],
        env: { T3_PORTSPACE_PROLOGUE: "prologue" },
      };
    };
    const options: SpawnOptions = {
      command: "claude",
      args: ["--print"],
      cwd: "/work",
      env: { FOO: "bar" },
      signal,
    };

    expect(claudeSpawnInPortSpace(options, rewrite)).toEqual({
      command: "sudo",
      args: ["helper", "exec", "--", "claude", "--print"],
      env: { T3_PORTSPACE_PROLOGUE: "prologue" },
      signal,
    });
    expect(seen).toEqual([
      { command: "claude", args: ["--print"], cwd: "/work", env: { FOO: "bar" } },
    ]);
  });
});

describe("claudeMcpServersInPortSpace", () => {
  const mcpServers = {
    "t3-code": { type: "http", url: "http://127.0.0.1:4120/mcp/abc" },
    elsewhere: { type: "sse", url: "https://example.com/sse" },
    local: { type: "stdio", command: "mcp-server" },
  } satisfies NonNullable<Options["mcpServers"]>;

  const handle = (hostAddress: ThreadPortSpaceHandle["hostAddress"]): ThreadPortSpaceHandle => ({
    rewrite: (input) => ({ command: input.command, args: input.args, env: {} }),
    hostAddress,
  });

  it.effect("reaches T3's MCP endpoint through the host address", () =>
    Effect.gen(function* () {
      expect(
        yield* claudeMcpServersInPortSpace(mcpServers, handle(Effect.succeed("192.168.5.2"))),
      ).toEqual({
        ...mcpServers,
        "t3-code": { type: "http", url: "http://192.168.5.2:4120/mcp/abc" },
      });
    }),
  );

  it.effect("keeps the MCP URLs when the host address cannot be found", () =>
    Effect.gen(function* () {
      expect(
        yield* claudeMcpServersInPortSpace(mcpServers, handle(Effect.succeed(undefined))),
      ).toEqual(mcpServers);
    }),
  );
});
