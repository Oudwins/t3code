import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ServerConfig from "../config.ts";
import * as PortSpaces from "../portSpace/PortSpaces.ts";
import * as PreviewManager from "../preview/Manager.ts";
import * as TerminalManager from "../terminal/Manager.ts";
import * as ResourceCleanupService from "./ResourceCleanupService.ts";

const withService = <A, E>(
  options: {
    readonly capability: typeof PortSpaces.PortSpaces.Service.capability;
    readonly releaseFails?: boolean;
  },
  use: (
    service: typeof ResourceCleanupService.ResourceCleanupService.Service,
    released: Array<string>,
  ) => Effect.Effect<A, E>,
) => {
  const released: Array<string> = [];
  const portSpaces = Layer.mock(PortSpaces.PortSpaces)({
    wrapSpawn: (_threadId, input) => ({ command: input.command, args: input.args, env: {} }),
    capability: options.capability,
    release: (threadId) =>
      options.releaseFails
        ? Effect.fail(
            new PortSpaces.PortSpaceCommandError({ operation: "release", detail: "boom" }),
          )
        : Effect.sync(() => {
            released.push(threadId);
          }),
  });
  const terminals = Layer.mock(TerminalManager.TerminalManager)({});
  const previews = Layer.mock(PreviewManager.PreviewManager)({});
  return Effect.gen(function* () {
    const service = yield* ResourceCleanupService.ResourceCleanupService;
    return yield* use(service, released);
  }).pipe(
    Effect.provide(
      ResourceCleanupService.layer.pipe(
        Layer.provideMerge(Layer.mergeAll(portSpaces, terminals, previews)),
        Layer.provideMerge(ServerConfig.layerTest("/tmp", { prefix: "t3-cleanup-" })),
        Layer.provideMerge(NodeServices.layer),
      ),
    ),
  );
};

describe("ResourceCleanupService.releasePortSpace", () => {
  it.effect("releases the thread's namespace where port spaces are set up", () =>
    withService({ capability: Effect.succeed({ available: true }) }, (service, released) =>
      Effect.gen(function* () {
        yield* service.releasePortSpace("thread-1");
        expect(released).toEqual(["thread-1"]);
      }),
    ),
  );

  it.effect("leaves hosts without port spaces alone", () =>
    withService(
      {
        capability: Effect.succeed({
          available: false,
          reason: "needs-setup",
          setupCommand: "t3 portspace setup",
        }),
      },
      (service, released) =>
        Effect.gen(function* () {
          yield* service.releasePortSpace("thread-1");
          expect(released).toEqual([]);
        }),
    ),
  );

  it.effect("reports a failed release as a port space cleanup error", () =>
    withService(
      { capability: Effect.succeed({ available: true }), releaseFails: true },
      (service) =>
        Effect.gen(function* () {
          const error = yield* service.releasePortSpace("thread-1").pipe(Effect.flip);
          expect(error.operation).toBe("portSpace");
          expect(error.threadId).toBe("thread-1");
        }),
    ),
  );
});
