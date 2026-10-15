// @effect-diagnostics nodeBuiltinImport:off - the helper scripts are checked by running a real sh.
import { describe, expect, it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import type { PortSpaceSpawn } from "@t3tools/shared/ThreadPortSpace";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import { ChildProcessSpawner } from "effect/process";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as ProcessRunner from "../processRunner.ts";
import {
  PORT_SPACE_HELPER_PATH,
  PORT_SPACE_PROTOCOL,
  PORT_SPACE_SETUP_COMMAND,
  portSpaceHelperScript,
  portSpaceInstallScript,
  portSpaceRemoveScript,
} from "./PortSpaceHelper.ts";
import * as PortSpaces from "./PortSpaces.ts";

const windowsHost = HostProcess.Platform.defaultValue() === "win32";

const threadA = ThreadId.make("thread-a");
const threadB = ThreadId.make("thread-b/with:odd chars");

interface Call {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
}

const output = (code: number, stdout = "", stderr = "") => ({
  stdout,
  stderr,
  code: ChildProcessSpawner.ExitCode(code),
  timedOut: false,
  stdoutTruncated: false,
  stderrTruncated: false,
  stdoutInvalidUtf8: false,
  stderrInvalidUtf8: false,
});

/** Runs `PortSpaces` against a scripted helper; `reply` answers by the helper's subcommand. */
const withPortSpaces = <A, E>(
  options: {
    readonly environmentId?: string;
    readonly platform?: NodeJS.Platform;
    readonly uid?: number | undefined;
    readonly reply?: (subcommand: string, args: ReadonlyArray<string>) => ReturnType<typeof output>;
  },
  use: (portSpaces: PortSpaces.PortSpaces["Service"], calls: Array<Call>) => Effect.Effect<A, E>,
) => {
  const calls: Array<Call> = [];
  const runner = ProcessRunner.ProcessRunner.of({
    run: (input) =>
      Effect.sync(() => {
        calls.push({ command: input.command, args: input.args });
        const rest = input.args.filter((arg) => arg !== "-n" && arg !== PORT_SPACE_HELPER_PATH);
        return (options.reply ?? (() => output(0)))(rest[0] ?? "", rest.slice(1));
      }),
  });
  return Effect.gen(function* () {
    const portSpaces = yield* PortSpaces.make(options.environmentId ?? "environment-a");
    return yield* use(portSpaces, calls);
  }).pipe(
    Effect.provideService(ProcessRunner.ProcessRunner, runner),
    Effect.provideService(HostProcess.Platform, options.platform ?? "linux"),
    Effect.provideService(HostProcess.UserId, "uid" in options ? options.uid : 1000),
  );
};

const namespaceIdOf = (spawn: PortSpaceSpawn) => spawn.args[spawn.args.indexOf("exec") + 1];

describe("PortSpaces.capability", () => {
  it.effect("is unsupported off Linux without touching the helper", () =>
    withPortSpaces({ platform: "darwin" }, (portSpaces, calls) =>
      Effect.gen(function* () {
        expect(yield* portSpaces.capability).toEqual({
          available: false,
          reason: "unsupported-platform",
        });
        expect(calls).toEqual([]);
      }),
    ),
  );

  it.effect("asks for setup when the helper is missing or not allowed", () =>
    withPortSpaces({ reply: () => output(1, "", "sudo: a password is required") }, (portSpaces) =>
      Effect.gen(function* () {
        expect(yield* portSpaces.capability).toEqual({
          available: false,
          reason: "needs-setup",
          setupCommand: PORT_SPACE_SETUP_COMMAND,
        });
      }),
    ),
  );

  it.effect("asks for setup when the installed helper speaks another protocol", () =>
    withPortSpaces(
      { reply: (subcommand) => output(0, subcommand === "version" ? "0\n" : "") },
      (portSpaces) =>
        Effect.gen(function* () {
          expect(yield* portSpaces.capability).toMatchObject({ reason: "needs-setup" });
        }),
    ),
  );

  it.effect("lists the tools the machine is missing", () =>
    withPortSpaces(
      {
        reply: (subcommand) =>
          subcommand === "version"
            ? output(0, `${PORT_SPACE_PROTOCOL}\n`)
            : output(0, "nsenter\npasta\n"),
      },
      (portSpaces) =>
        Effect.gen(function* () {
          expect(yield* portSpaces.capability).toEqual({
            available: false,
            reason: "missing-tools",
            tools: ["nsenter", "pasta"],
          });
        }),
    ),
  );

  it.effect("is available when the helper answers and no tool is missing", () =>
    withPortSpaces(
      {
        reply: (subcommand) =>
          output(0, subcommand === "version" ? `${PORT_SPACE_PROTOCOL}\n` : ""),
      },
      (portSpaces) =>
        Effect.gen(function* () {
          expect(yield* portSpaces.capability).toEqual({ available: true });
        }),
    ),
  );
});

describe("PortSpaces.wrapSpawn", () => {
  it.effect("derives a valid, stable, per-thread namespace id", () =>
    withPortSpaces({}, (portSpaces) =>
      Effect.sync(() => {
        const spawn = (threadId: ThreadId) =>
          portSpaces.wrapSpawn(threadId, { command: "node", args: ["server.js"] });
        const idA = namespaceIdOf(spawn(threadA));
        const idB = namespaceIdOf(spawn(threadB));
        expect(idA).toMatch(/^[a-z0-9-]{1,32}$/);
        expect(idB).toMatch(/^[a-z0-9-]{1,32}$/);
        expect(idA).toBe(namespaceIdOf(spawn(threadA)));
        expect(idA).not.toBe(idB);
      }),
    ),
  );

  it.effect("gives the same thread a different namespace in each environment", () =>
    Effect.gen(function* () {
      const idIn = (environmentId: string) =>
        withPortSpaces({ environmentId }, (portSpaces) =>
          Effect.succeed(
            namespaceIdOf(portSpaces.wrapSpawn(threadA, { command: "node", args: [] })),
          ),
        );
      const first = yield* idIn("environment-a");
      const second = yield* idIn("environment-b");
      expect(first).toMatch(/^[a-z0-9-]{1,32}$/);
      expect(second).toMatch(/^[a-z0-9-]{1,32}$/);
      expect(first).not.toBe(second);
      expect(yield* idIn("environment-a")).toBe(first);
    }),
  );

  it.effect("goes through sudo for a normal user and runs the helper directly as root", () =>
    Effect.gen(function* () {
      const input = { command: "vite", args: ["--port", "3000"] };
      const user = yield* withPortSpaces({ uid: 1000 }, (portSpaces) =>
        Effect.succeed(portSpaces.wrapSpawn(threadA, input)),
      );
      const root = yield* withPortSpaces({ uid: 0 }, (portSpaces) =>
        Effect.succeed(portSpaces.wrapSpawn(threadA, input)),
      );
      const id = namespaceIdOf(user);
      expect(user.command).toBe("sudo");
      expect(user.args).toEqual([
        "-n",
        PORT_SPACE_HELPER_PATH,
        "exec",
        id,
        "--",
        "vite",
        "--port",
        "3000",
      ]);
      expect(root.command).toBe(PORT_SPACE_HELPER_PATH);
      expect(root.args).toEqual(["exec", id, "--", "vite", "--port", "3000"]);
    }),
  );

  it.effect(
    "keeps the caller's PATH for resolving the command and carries the rest in the prologue",
    () =>
      withPortSpaces({}, (portSpaces) =>
        Effect.sync(() => {
          const spawn = portSpaces.wrapSpawn(threadA, {
            command: "vite",
            args: [],
            env: { PATH: "/opt/bin:/usr/bin", NODE_ENV: "development" },
          });
          expect(Object.keys(spawn.env).toSorted()).toEqual(["PATH", "T3_PORTSPACE_PROLOGUE"]);
          expect(spawn.env.PATH).toBe("/opt/bin:/usr/bin");
          expect(spawn.env.T3_PORTSPACE_PROLOGUE).toContain("export NODE_ENV='development'");
        }),
      ),
  );

  // The prologue is the only thing that carries env and cwd across sudo, so
  // its quoting is checked by letting a real shell evaluate it.
  describe.skipIf(windowsHost)("prologue evaluated by sh", () => {
    const evaluate = (
      input: { readonly cwd?: string; readonly env?: Record<string, string | undefined> },
      script: string,
    ) =>
      withPortSpaces({}, (portSpaces) =>
        Effect.sync(() => {
          const { env } = portSpaces.wrapSpawn(threadA, { command: "x", args: [], ...input });
          return NodeChildProcess.spawnSync(
            "sh",
            ["-c", `eval "$T3_PORTSPACE_PROLOGUE"; ${script}`],
            {
              env: {
                PATH: process.env.PATH ?? "",
                T3_PORTSPACE_PROLOGUE: env.T3_PORTSPACE_PROLOGUE ?? "",
              },
              encoding: "utf8",
            },
          );
        }),
      );

    it.effect("round-trips values containing quotes, spaces, newlines and shell syntax", () =>
      Effect.gen(function* () {
        const nasty = 'a\'b "c" $(touch pwned) `id` ; $HOME\nline two \\';
        const result = yield* evaluate({ env: { NASTY: nasty } }, 'printf %s "$NASTY"');
        expect(result.stdout).toBe(nasty);
      }),
    );

    it.effect("drops variables whose names a shell cannot export", () =>
      Effect.gen(function* () {
        const result = yield* evaluate(
          {
            env: {
              "BAD-NAME": "x",
              ok_name: "y",
              "9starts": "z",
              "x; touch pwned": "w",
              UNSET: undefined,
            },
          },
          'printf "%s|%s" "$ok_name" "${UNSET-unset}"',
        );
        expect(result.status).toBe(0);
        expect(result.stdout).toBe("y|unset");
      }),
    );

    it.effect("changes directory, and stops the command when the directory is gone", () =>
      Effect.gen(function* () {
        const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-prologue it's-"));
        const ok = yield* evaluate({ cwd: dir }, "pwd -P");
        expect(ok.stdout.trim()).toBe(NodeFS.realpathSync(dir));
        NodeFS.rmdirSync(dir);
        const gone = yield* evaluate({ cwd: dir }, "echo ran");
        expect(gone.status).not.toBe(0);
        expect(gone.stdout).toBe("");
      }),
    );
  });
});

describe("PortSpaces.listeners", () => {
  const ss = [
    'LISTEN 0 511     127.0.0.1:3000      0.0.0.0:*    users:(("node",pid=12,fd=19))',
    'LISTEN 0 511         [::1]:3000         [::]:*    users:(("node",pid=12,fd=20))',
    'LISTEN 0 128             *:8080            *:*    users:(("python3",pid=40,fd=3),("python3",pid=41,fd=3))',
    "LISTEN 0 4096     127.0.0.1:5432      0.0.0.0:*",
    "",
  ].join("\n");

  it.effect("parses addresses, ports and owning processes, ordered by port", () =>
    withPortSpaces(
      { reply: (subcommand) => (subcommand === "listeners" ? output(0, ss) : output(0)) },
      (portSpaces, calls) =>
        Effect.gen(function* () {
          const listeners = yield* portSpaces.listeners(threadA);
          expect(listeners).toEqual([
            { address: "::1", port: 3000, process: { name: "node", pid: 12 } },
            { address: "127.0.0.1", port: 3000, process: { name: "node", pid: 12 } },
            { address: "127.0.0.1", port: 5432, process: undefined },
            { address: "*", port: 8080, process: { name: "python3", pid: 40 } },
          ]);
          expect(calls[0]?.args.slice(-2)).toEqual([
            "listeners",
            expect.stringMatching(/^[a-z0-9-]+$/),
          ]);
        }),
    ),
  );

  it.effect("is empty for an empty namespace", () =>
    withPortSpaces({}, (portSpaces) =>
      Effect.gen(function* () {
        expect(yield* portSpaces.listeners(threadA)).toEqual([]);
      }),
    ),
  );
});

describe("PortSpaces.hostAddress", () => {
  it.effect("asks the helper for the thread's gateway and trims the answer", () =>
    withPortSpaces(
      {
        reply: (subcommand) => (subcommand === "gateway" ? output(0, "192.168.5.2\n") : output(0)),
      },
      (portSpaces, calls) =>
        Effect.gen(function* () {
          expect(yield* portSpaces.hostAddress(threadA)).toBe("192.168.5.2");
          const id = namespaceIdOf(portSpaces.wrapSpawn(threadA, { command: "x", args: [] }));
          expect(calls[0]?.args.slice(-2)).toEqual(["gateway", id]);
        }),
    ),
  );

  it.effect("fails when the helper prints nothing", () =>
    withPortSpaces({}, (portSpaces) =>
      Effect.gen(function* () {
        const exit = yield* Effect.exit(portSpaces.hostAddress(threadA));
        expect(String(Exit.isFailure(exit) ? exit.cause : "")).toContain(
          "Port space hostAddress failed",
        );
      }),
    ),
  );
});

describe("PortSpaces.ensure and release", () => {
  it.effect("create and delete the same namespace the thread's commands run in", () =>
    withPortSpaces({}, (portSpaces, calls) =>
      Effect.gen(function* () {
        yield* portSpaces.ensure(threadA);
        yield* portSpaces.release(threadA);
        const id = namespaceIdOf(portSpaces.wrapSpawn(threadA, { command: "x", args: [] }));
        expect(calls.map((call) => call.args.slice(-2))).toEqual([
          ["create", id],
          ["delete", id],
        ]);
      }),
    ),
  );

  it.effect("track the threads that have a namespace", () =>
    withPortSpaces({}, (portSpaces) =>
      Effect.gen(function* () {
        expect(yield* portSpaces.threads).toEqual([]);
        yield* portSpaces.ensure(threadA);
        yield* portSpaces.ensure(threadA);
        yield* portSpaces.ensure(threadB);
        expect(yield* portSpaces.threads).toEqual([threadA, threadB]);
        yield* portSpaces.release(threadA);
        expect(yield* portSpaces.threads).toEqual([threadB]);
      }),
    ),
  );

  it.effect("do not track a thread whose namespace could not be created", () =>
    withPortSpaces({ reply: () => output(2, "", "refused") }, (portSpaces) =>
      Effect.gen(function* () {
        yield* Effect.exit(portSpaces.ensure(threadA));
        expect(yield* portSpaces.threads).toEqual([]);
      }),
    ),
  );

  it.effect("surface the helper's stderr when it refuses", () =>
    withPortSpaces(
      { reply: () => output(2, "", "t3-portspace: invalid port space id\n") },
      (portSpaces) =>
        Effect.gen(function* () {
          const exit = yield* Effect.exit(portSpaces.ensure(threadA));
          expect(Exit.isFailure(exit)).toBe(true);
          if (Exit.isFailure(exit)) {
            expect(String(exit.cause)).toContain(
              "Port space ensure failed: t3-portspace: invalid port space id",
            );
          }
        }),
    ),
  );

  it.effect("never run two helper commands for one thread at once", () => {
    const active = new Map<string, number>();
    let overlapped = false;
    let otherThreadOverlapped = false;
    const runner = ProcessRunner.ProcessRunner.of({
      run: (input) =>
        Effect.gen(function* () {
          const id = input.args.at(-1) ?? "";
          if ((active.get(id) ?? 0) > 0) overlapped = true;
          if ([...active].some(([other, count]) => other !== id && count > 0)) {
            otherThreadOverlapped = true;
          }
          active.set(id, (active.get(id) ?? 0) + 1);
          yield* Effect.yieldNow;
          yield* Effect.yieldNow;
          active.set(id, (active.get(id) ?? 1) - 1);
          return output(0);
        }),
    });
    return Effect.gen(function* () {
      const portSpaces = yield* PortSpaces.make("environment-a");
      yield* Effect.all(
        [
          portSpaces.ensure(threadA),
          portSpaces.ensure(threadA),
          portSpaces.release(threadA),
          portSpaces.ensure(threadB),
        ],
        { concurrency: "unbounded" },
      );
      expect(overlapped).toBe(false);
      // Threads do not wait on each other.
      expect(otherThreadOverlapped).toBe(true);
    }).pipe(
      Effect.provideService(ProcessRunner.ProcessRunner, runner),
      Effect.provideService(HostProcess.Platform, "linux"),
      Effect.provideService(HostProcess.UserId, 1000),
    );
  });

  it.effect("report a spawn failure as a port space error", () => {
    const runner = ProcessRunner.ProcessRunner.of({
      run: () =>
        Effect.fail(
          new ProcessRunner.ProcessSpawnError({
            command: "sudo",
            argumentCount: 3,
            cause: new Error("ENOENT"),
          }),
        ),
    });
    return Effect.gen(function* () {
      const portSpaces = yield* PortSpaces.make("environment-a");
      const exit = yield* Effect.exit(portSpaces.release(threadA));
      expect(String(Exit.isFailure(exit) ? exit.cause : "")).toContain("Port space release failed");
    }).pipe(
      Effect.provideService(ProcessRunner.ProcessRunner, runner),
      Effect.provideService(HostProcess.Platform, "linux"),
      Effect.provideService(HostProcess.UserId, 1000),
    );
  });
});

// The scripts below only ever run as root on a Linux machine; these checks
// cover what is safe to run anywhere: that they parse, and the helper's
// argument validation, which dies before touching any namespace tooling.
describe.skipIf(windowsHost)("helper scripts", () => {
  const scratch = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-portspace-"));
  const write = (name: string, body: string) => {
    const file = NodePath.join(scratch, name);
    NodeFS.writeFileSync(file, body, { mode: 0o755 });
    return file;
  };
  const helper = write("t3-portspace", portSpaceHelperScript);
  const runHelper = (...args: ReadonlyArray<string>) =>
    NodeChildProcess.spawnSync("sh", [helper, ...args], { encoding: "utf8" });

  it("all parse as POSIX sh", () => {
    for (const [name, body] of [
      ["helper", portSpaceHelperScript],
      ["install-user", portSpaceInstallScript({ sudoersUid: 1000 })],
      ["install-root", portSpaceInstallScript({ sudoersUid: undefined })],
      ["remove", portSpaceRemoveScript],
    ] as const) {
      const result = NodeChildProcess.spawnSync("sh", ["-n", write(name, body)], {
        encoding: "utf8",
      });
      expect({ name, status: result.status, stderr: result.stderr }).toEqual({
        name,
        status: 0,
        stderr: "",
      });
    }
  });

  it("reports its protocol version", () => {
    expect(runHelper("version").stdout.trim()).toBe("2");
  });

  it("refuses ids that are not [a-z0-9-]{1,32}", () => {
    for (const id of [
      "",
      "../etc",
      "-flag",
      "UPPER",
      "has space",
      "semi;colon",
      "a".repeat(33),
      "$(id)",
    ]) {
      for (const subcommand of ["create", "delete", "gateway", "listeners"]) {
        const result = runHelper(subcommand, id);
        expect({ subcommand, id, status: result.status }).toEqual({ subcommand, id, status: 2 });
        expect(result.stderr).toContain("invalid port space id");
      }
    }
  });

  it("refuses exec without the separator or a command", () => {
    expect(runHelper("exec", "abc", "true").stderr).toContain("usage: exec");
    expect(runHelper("exec", "abc", "--").stderr).toContain("missing command");
  });

  it("refuses to enter or inspect a namespace that does not exist", () => {
    for (const args of [
      ["exec", "no-such-space", "--", "true"],
      ["gateway", "no-such-space"],
      ["listeners", "no-such-space"],
    ]) {
      const result = runHelper(...args);
      expect({ args, status: result.status }).toEqual({ args, status: 2 });
      expect(result.stderr).toContain("no such port space");
    }
  });

  it("rejects unknown subcommands", () => {
    expect(runHelper("rm", "-rf").status).toBe(2);
    expect(runHelper().status).toBe(2);
  });
});
