import {
  HostProcessEnvironment,
  HostProcessPlatform,
  HostProcessUserId,
} from "@t3tools/shared/hostProcess";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { Command, Flag, Prompt } from "effect/unstable/cli";

import {
  PORT_SPACE_HELPER_PATH,
  PORT_SPACE_SETUP_COMMAND,
  PORT_SPACE_SUDOERS_PATH,
  portSpaceHelperScript,
  portSpaceInstallScript,
  portSpaceRemoveScript,
  portSpaceSudoersEntry,
} from "../portSpace/PortSpaceHelper.ts";
import * as PortSpaces from "../portSpace/PortSpaces.ts";
import * as ProcessRunner from "../processRunner.ts";

export class CliPortSpaceError extends Schema.TaggedError<CliPortSpaceError>()(
  "CliPortSpaceError",
  { reason: Schema.String },
) {
  override get message(): string {
    return this.reason;
  }
}

const runtimeLayer = PortSpaces.layer.pipe(Layer.provideMerge(ProcessRunner.layer));

const yesFlag = Flag.Boolean("yes").pipe(
  Flag.withAlias("y"),
  Flag.withDescription(
    "Do not ask for confirmation. Required from a script, where there is no prompt.",
  ),
  Flag.withDefault(false),
);

const describeCapability = (capability: PortSpaces.PortSpaceCapability) => {
  if (capability.available) return "Port spaces are ready.";
  switch (capability.reason) {
    case "unsupported-platform":
      return "Port spaces need Linux. Run T3 Code on a Linux machine to use them.";
    case "needs-setup":
      return `Port spaces need a one-time setup. Run: ${capability.setupCommand}`;
    case "missing-tools":
      return `Port spaces need tools this machine does not have: ${capability.tools.join(", ")}.\nInstall iproute2 (ip, ss), util-linux (nsenter, setpriv) and passt (pasta), then run: ${PORT_SPACE_SETUP_COMMAND}`;
  }
};

/**
 * Who the sudoers entry is for, and how to reach root. A normal user goes
 * through sudo (which asks for a password on the terminal). Root invoked via
 * `sudo t3 ...` installs for the user who typed it. Plain root needs no entry.
 */
const resolveInstallTarget = Effect.fn("cli.portspace.resolve_target")(function* () {
  const platform = yield* HostProcessPlatform;
  const uid = yield* HostProcessUserId;
  const environment = yield* HostProcessEnvironment;
  if (platform !== "linux" || uid === undefined) {
    return yield* new CliPortSpaceError({
      reason: "Port spaces need Linux. Run this on the Linux machine that runs your threads.",
    });
  }
  if (uid !== 0) return { sudoersUid: uid, viaSudo: true };
  const invoker = Number(environment.SUDO_UID);
  return {
    sudoersUid: Number.isInteger(invoker) && invoker > 0 ? invoker : undefined,
    viaSudo: false,
  };
});

const runAsRoot = Effect.fn("cli.portspace.run_as_root")(function* (input: {
  readonly viaSudo: boolean;
  readonly script: string;
}) {
  const runner = yield* ProcessRunner.ProcessRunner;
  const result = yield* runner
    .run({
      command: input.viaSudo ? "sudo" : "sh",
      args: input.viaSudo ? ["--", "sh", "-s"] : ["-s"],
      stdin: input.script,
      timeout: "5 minutes",
    })
    .pipe(
      Effect.mapError(
        (error) =>
          new CliPortSpaceError({ reason: `Could not run the installer: ${error.message}` }),
      ),
    );
  if (result.code !== 0) {
    return yield* new CliPortSpaceError({
      reason: result.stderr.trim() || `The installer exited with code ${result.code}.`,
    });
  }
});

const confirm = (message: string, assumeYes: boolean) =>
  assumeYes
    ? Effect.succeed(true)
    : Prompt.run(Prompt.Confirm({ message, initial: false })).pipe(
        Effect.catchTag("QuitError", () => Effect.succeed(false)),
      );

const statusCommand = Command.make("status").pipe(
  Command.withDescription("Show whether this machine can run per-thread port spaces."),
  Command.withHandler(() =>
    Effect.gen(function* () {
      const portSpaces = yield* PortSpaces.PortSpaces;
      yield* Console.log(describeCapability(yield* portSpaces.capability));
    }).pipe(Effect.provide(runtimeLayer)),
  ),
);

const setupCommand = Command.make("setup", { yes: yesFlag }).pipe(
  Command.withDescription(
    "Install the root helper that gives each thread its own network namespace. Asks for sudo.",
  ),
  Command.withHandler(({ yes }) =>
    Effect.gen(function* () {
      const target = yield* resolveInstallTarget();
      yield* Console.log(`This will install, as root:`);
      yield* Console.log(`  ${PORT_SPACE_HELPER_PATH}`);
      yield* Console.log(
        `    creates, enters and deletes per-thread network namespaces. Every argument is validated, and`,
      );
      yield* Console.log(
        `    commands run as you, never as root. It also starts one pasta process per`,
      );
      yield* Console.log(
        `    namespace, as the "nobody" user, to give the namespace internet access.`,
      );
      if (target.sudoersUid !== undefined) {
        yield* Console.log(`  ${PORT_SPACE_SUDOERS_PATH}`);
        yield* Console.log(
          `    lets uid ${target.sudoersUid} run only that helper without a password:`,
        );
        yield* Console.log("");
        yield* Console.log(portSpaceSudoersEntry(target.sudoersUid));
      }
      yield* Console.log(`The helper's source:`);
      yield* Console.log("");
      yield* Console.log(portSpaceHelperScript);
      if (!(yield* confirm("Install the port space helper?", yes))) {
        yield* Console.log("Nothing installed.");
        return;
      }
      yield* runAsRoot({
        viaSudo: target.viaSudo,
        script: portSpaceInstallScript({ sudoersUid: target.sudoersUid }),
      });
      const portSpaces = yield* PortSpaces.PortSpaces;
      yield* Console.log(describeCapability(yield* portSpaces.capability));
    }).pipe(Effect.provide(runtimeLayer)),
  ),
);

const removeCommand = Command.make("remove", { yes: yesFlag }).pipe(
  Command.withDescription(
    "Delete every thread's port space and remove the root helper and its sudoers entry.",
  ),
  Command.withHandler(({ yes }) =>
    Effect.gen(function* () {
      const target = yield* resolveInstallTarget();
      yield* Console.log("This will stop everything running in a port space, then delete:");
      yield* Console.log(`  ${PORT_SPACE_SUDOERS_PATH}`);
      yield* Console.log(`  ${PORT_SPACE_HELPER_PATH}`);
      if (!(yield* confirm("Remove the port space helper?", yes))) {
        yield* Console.log("Left as is.");
        return;
      }
      yield* runAsRoot({ viaSudo: target.viaSudo, script: portSpaceRemoveScript });
      yield* Console.log("Removed.");
    }).pipe(Effect.provide(runtimeLayer)),
  ),
);

export const portspaceCommand = Command.make("portspace").pipe(
  Command.withDescription(
    "Per-thread network namespaces (Linux), so every thread can use the same ports.",
  ),
  Command.withSubcommands([statusCommand, setupCommand, removeCommand]),
);
