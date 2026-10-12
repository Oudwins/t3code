/**
 * PortSpaces - per-thread network namespaces, so every thread can bind the
 * same ports (several dev servers on :3000) without colliding.
 *
 * Linux only. The namespaces are made and entered by a root-owned helper
 * (`PortSpaceHelper.ts`) that `t3 portspace setup` installs. A port space has
 * its own loopback and reaches the internet through pasta. The host's
 * loopback (T3's own server, a local Postgres) is only reachable at
 * `hostAddress`, so spawning into one is opt-in.
 *
 * @module PortSpaces
 */

import type { ThreadId } from "@t3tools/contracts";
import { HostProcessPlatform, HostProcessUserId } from "@t3tools/shared/hostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as NodeCrypto from "node:crypto";

import * as ProcessRunner from "../processRunner.ts";
import {
  PORT_SPACE_HELPER_PATH,
  PORT_SPACE_PROTOCOL,
  PORT_SPACE_SETUP_COMMAND,
} from "./PortSpaceHelper.ts";

export type PortSpaceCapability =
  | { readonly available: true }
  | { readonly available: false; readonly reason: "unsupported-platform" }
  | {
      readonly available: false;
      readonly reason: "needs-setup";
      readonly setupCommand: string;
    }
  | {
      readonly available: false;
      readonly reason: "missing-tools";
      readonly tools: ReadonlyArray<string>;
    };

export interface PortSpaceListener {
  readonly address: string;
  readonly port: number;
  readonly process: { readonly name: string; readonly pid: number } | undefined;
}

export interface PortSpaceSpawn {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  /** The complete environment to spawn with. The caller's own variables travel inside the helper's prologue. */
  readonly env: Record<string, string>;
}

export class PortSpaceCommandError extends Schema.TaggedError<PortSpaceCommandError>()(
  "PortSpaceCommandError",
  {
    operation: Schema.Literals(["ensure", "hostAddress", "listeners", "release"]),
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Port space ${this.operation} failed: ${this.detail}`;
  }
}

export class PortSpaces extends Context.Service<
  PortSpaces,
  {
    /** Whether this environment can run port spaces, and how to enable them when it cannot. */
    readonly capability: Effect.Effect<PortSpaceCapability>;
    /** Creates the thread's namespace if it does not exist. Idempotent. */
    readonly ensure: (threadId: ThreadId) => Effect.Effect<void, PortSpaceCommandError>;
    /**
     * Rewrites a command so it runs inside the thread's namespace as the
     * current user, with the given environment and working directory.
     * Variables whose names a shell cannot export are dropped.
     */
    readonly wrapSpawn: (
      threadId: ThreadId,
      input: {
        readonly command: string;
        readonly args: ReadonlyArray<string>;
        readonly cwd?: string | undefined;
        readonly env?: Readonly<Record<string, string | undefined>> | undefined;
      },
    ) => PortSpaceSpawn;
    /**
     * The address that means "the host's loopback" from inside the thread's
     * namespace. Use it in place of 127.0.0.1 for anything on the host.
     */
    readonly hostAddress: (threadId: ThreadId) => Effect.Effect<string, PortSpaceCommandError>;
    /** TCP listeners inside the thread's namespace, with the process that owns each. */
    readonly listeners: (
      threadId: ThreadId,
    ) => Effect.Effect<ReadonlyArray<PortSpaceListener>, PortSpaceCommandError>;
    /** Kills everything in the thread's namespace and deletes it. Idempotent. */
    readonly release: (threadId: ThreadId) => Effect.Effect<void, PortSpaceCommandError>;
  }
>()("t3/portSpace/PortSpaces") {}

/**
 * Namespace ids are `[a-z0-9-]{1,32}`; thread ids are not guaranteed to be.
 * Namespaces are machine-global, so the environment is part of the id: a dev
 * server holding a copy of a thread must not share, or release, its namespace.
 */
const portSpaceId = (environmentId: string, threadId: ThreadId) =>
  NodeCrypto.createHash("sha256")
    .update(`${environmentId}\0${threadId}`)
    .digest("hex")
    .slice(0, 16);

const shellQuote = (value: string) => `'${value.replaceAll("'", `'"'"'`)}'`;

const EXPORTABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

const buildPrologue = (input: {
  readonly cwd: string | undefined;
  readonly env: Readonly<Record<string, string | undefined>>;
}) => {
  const lines: Array<string> = [];
  for (const [name, value] of Object.entries(input.env)) {
    if (value !== undefined && EXPORTABLE_NAME.test(name)) {
      lines.push(`export ${name}=${shellQuote(value)}`);
    }
  }
  if (input.cwd !== undefined) lines.push(`cd -- ${shellQuote(input.cwd)} || exit 1`);
  return lines.join("\n");
};

/** `ss -H -tlnp` rows: `LISTEN 0 511 127.0.0.1:3000 0.0.0.0:* users:(("node",pid=12,fd=19))`. */
const parseListeners = (output: string): ReadonlyArray<PortSpaceListener> => {
  const listeners: Array<PortSpaceListener> = [];
  for (const line of output.split("\n")) {
    const fields = line.trim().split(/\s+/);
    const local = fields[3];
    if (fields[0] !== "LISTEN" || local === undefined) continue;
    const separator = local.lastIndexOf(":");
    const port = Number(local.slice(separator + 1));
    if (separator < 0 || !Number.isInteger(port)) continue;
    const owner = /\(\("([^"]*)",pid=(\d+)/.exec(fields.slice(5).join(" "));
    listeners.push({
      address: local.slice(0, separator).replace(/^\[(.*)\]$/, "$1"),
      port,
      process: owner === null ? undefined : { name: owner[1] ?? "", pid: Number(owner[2]) },
    });
  }
  return listeners.toSorted((a, b) => a.port - b.port || a.address.localeCompare(b.address));
};

export const make = Effect.fn("PortSpaces.make")(function* (environmentId: string) {
  const runner = yield* ProcessRunner.ProcessRunner;
  const platform = yield* HostProcessPlatform;
  const uid = yield* HostProcessUserId;

  // `-n` makes a missing sudoers entry fail fast instead of prompting.
  const helperPrefix =
    uid === 0
      ? { command: PORT_SPACE_HELPER_PATH, args: [] }
      : { command: "sudo", args: ["-n", PORT_SPACE_HELPER_PATH] };

  const helper = (args: ReadonlyArray<string>) =>
    runner.run({
      command: helperPrefix.command,
      args: [...helperPrefix.args, ...args],
      timeout: "30 seconds",
    });

  const runHelper = Effect.fn("PortSpaces.runHelper")(function* (
    operation: PortSpaceCommandError["operation"],
    args: ReadonlyArray<string>,
  ) {
    const result = yield* helper(args).pipe(
      Effect.mapError(
        (cause) => new PortSpaceCommandError({ operation, detail: cause.message, cause }),
      ),
    );
    if (result.code !== 0) {
      return yield* new PortSpaceCommandError({
        operation,
        detail: result.stderr.trim() || `exit code ${result.code}`,
      });
    }
    return result.stdout;
  });

  const capability = Effect.gen(function* () {
    if (platform !== "linux") {
      return { available: false, reason: "unsupported-platform" } as const;
    }
    const needsSetup = {
      available: false,
      reason: "needs-setup",
      setupCommand: PORT_SPACE_SETUP_COMMAND,
    } as const;
    const version = yield* helper(["version"]).pipe(Effect.option);
    if (
      version._tag === "None" ||
      version.value.code !== 0 ||
      version.value.stdout.trim() !== String(PORT_SPACE_PROTOCOL)
    ) {
      return needsSetup;
    }
    const check = yield* helper(["check"]).pipe(Effect.option);
    if (check._tag === "None" || check.value.code !== 0) return needsSetup;
    const tools = check.value.stdout.split("\n").filter((tool) => tool.length > 0);
    return tools.length > 0
      ? ({ available: false, reason: "missing-tools", tools } as const)
      : ({ available: true } as const);
  }).pipe(Effect.withSpan("PortSpaces.capability"));

  const ensure = Effect.fn("PortSpaces.ensure")(function* (threadId: ThreadId) {
    yield* runHelper("ensure", ["create", portSpaceId(environmentId, threadId)]);
  });

  const wrapSpawn: PortSpaces["Service"]["wrapSpawn"] = (threadId, input) => {
    const env = input.env ?? {};
    return {
      command: helperPrefix.command,
      args: [
        ...helperPrefix.args,
        "exec",
        portSpaceId(environmentId, threadId),
        "--",
        input.command,
        ...input.args,
      ],
      env: {
        ...(env.PATH === undefined ? {} : { PATH: env.PATH }),
        T3_PORTSPACE_PROLOGUE: buildPrologue({ cwd: input.cwd, env }),
      },
    };
  };

  const hostAddress = Effect.fn("PortSpaces.hostAddress")(function* (threadId: ThreadId) {
    const address = (yield* runHelper("hostAddress", [
      "gateway",
      portSpaceId(environmentId, threadId),
    ])).trim();
    if (address.length === 0) {
      return yield* new PortSpaceCommandError({
        operation: "hostAddress",
        detail: "the helper returned no address",
      });
    }
    return address;
  });

  const listeners = Effect.fn("PortSpaces.listeners")(function* (threadId: ThreadId) {
    return parseListeners(
      yield* runHelper("listeners", ["listeners", portSpaceId(environmentId, threadId)]),
    );
  });

  const release = Effect.fn("PortSpaces.release")(function* (threadId: ThreadId) {
    yield* runHelper("release", ["delete", portSpaceId(environmentId, threadId)]);
  });

  return PortSpaces.of({ capability, ensure, wrapSpawn, hostAddress, listeners, release });
});
