import type { Options, SpawnOptions } from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import type { SpawnRewriter, ThreadPortSpaceHandle } from "@t3tools/shared/ThreadPortSpace";
import { claudeOptionsInPortSpace, spawnClaudeInPortSpace } from "./ClaudePortSpace.ts";

const spawnOptions = (overrides: Partial<SpawnOptions> = {}): SpawnOptions => ({
  command: "claude",
  args: ["--print"],
  cwd: "/work",
  env: { FOO: "bar" },
  signal: new AbortController().signal,
  ...overrides,
});

const readAll = (stream: NodeJS.ReadableStream) =>
  new Promise<string>((resolve) => {
    let data = "";
    stream.setEncoding("utf8");
    stream.on("data", (chunk: string) => {
      data += chunk;
    });
    stream.on("end", () => resolve(data));
  });

const closed = (child: ReturnType<typeof spawnClaudeInPortSpace>) =>
  new Promise<void>((resolve) => {
    if (child.exitCode !== null || child.signalCode != null) return resolve();
    child.once("exit", () => resolve());
  });

describe("spawnClaudeInPortSpace", () => {
  it("runs what the port space rewrites the spawn to and speaks stdio through it", async () => {
    const seen: Array<Parameters<SpawnRewriter>[0]> = [];
    const rewrite: SpawnRewriter = (input) => {
      seen.push(input);
      return { command: "cat", args: [], env: {} };
    };

    const child = spawnClaudeInPortSpace(rewrite, spawnOptions(), () => {});
    const output = readAll(child.stdout);
    child.stdin.end('{"type":"user"}\n');

    expect(await output).toBe('{"type":"user"}\n');
    await closed(child);
    expect(child.exitCode).toBe(0);
    expect(seen).toEqual([
      { command: "claude", args: ["--print"], cwd: "/work", env: { FOO: "bar" } },
    ]);
  });

  it("hands a failed exit and the end of stderr to the caller", async () => {
    const rewrite: SpawnRewriter = () => ({
      command: "sh",
      args: ["-c", "echo first >&2; echo last >&2; exit 3"],
      env: {},
    });
    const failure = Promise.withResolvers<{ code: number; stderrTail: string }>();

    spawnClaudeInPortSpace(rewrite, spawnOptions(), failure.resolve);

    const { code, stderrTail } = await failure.promise;
    expect(code).toBe(3);
    expect(stderrTail).toBe("first\nlast\n");
  });

  it("does not report a clean exit or a kill as a failure", async () => {
    const failures: Array<unknown> = [];
    const clean = spawnClaudeInPortSpace(
      () => ({ command: "true", args: [], env: {} }),
      spawnOptions(),
      (failure) => failures.push(failure),
    );
    await closed(clean);

    const killed = spawnClaudeInPortSpace(
      () => ({ command: "cat", args: [], env: {} }),
      spawnOptions(),
      (failure) => failures.push(failure),
    );
    const exit = closed(killed);
    expect(killed.kill("SIGTERM")).toBe(true);
    await exit;

    expect(killed.signalCode).toBe("SIGTERM");
    expect(failures).toEqual([]);
  });
});

describe("claudeOptionsInPortSpace", () => {
  const mcpServers = {
    "t3-code": { type: "http", url: "http://127.0.0.1:4120/mcp/abc" },
    elsewhere: { type: "sse", url: "https://example.com/sse" },
    local: { type: "stdio", command: "mcp-server" },
  } satisfies NonNullable<Options["mcpServers"]>;

  const rewritten: Array<string> = [];
  const handle = (hostAddress: ThreadPortSpaceHandle["hostAddress"]): ThreadPortSpaceHandle => ({
    rewrite: (input) => {
      rewritten.push(input.command);
      return { command: "cat", args: [], env: {} };
    },
    hostAddress,
  });

  it.effect("reaches T3's MCP endpoint through the host address and spawns in the namespace", () =>
    Effect.gen(function* () {
      const options = yield* claudeOptionsInPortSpace(
        { mcpServers },
        handle(Effect.succeed("192.168.5.2")),
        () => {},
      );

      expect(options.mcpServers).toEqual({
        ...mcpServers,
        "t3-code": { type: "http", url: "http://192.168.5.2:4120/mcp/abc" },
      });
      const child = options.spawnClaudeCodeProcess({
        command: "claude",
        args: [],
        env: {},
        signal: new AbortController().signal,
      });
      const exit = closed(child);
      child.kill("SIGKILL");
      yield* Effect.promise(() => exit);
      expect(rewritten).toEqual(["claude"]);
    }),
  );

  it.effect("keeps the MCP URLs when the host address cannot be found", () =>
    Effect.gen(function* () {
      const options = yield* claudeOptionsInPortSpace(
        { mcpServers },
        handle(Effect.succeed(undefined)),
        () => {},
      );

      expect(options.mcpServers).toEqual(mcpServers);
      expect(options.spawnClaudeCodeProcess).toBeTypeOf("function");
    }),
  );
});
