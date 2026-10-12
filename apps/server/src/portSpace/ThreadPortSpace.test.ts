import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import * as ServerSettings from "../serverSettings.ts";
import { PortSpaceCommandError, PortSpaces } from "./PortSpaces.ts";
import { makeThreadSpawnWrapper } from "./ThreadPortSpace.ts";

const wrapped = { command: "helper", args: ["exec"], env: { T3_PORTSPACE_PROLOGUE: "" } };

const withWrapper = <A, E>(
  options: { readonly enabled: boolean; readonly ensureFails?: boolean },
  use: (
    wrap: Effect.Success<typeof makeThreadSpawnWrapper>,
    ensured: Array<string>,
  ) => Effect.Effect<A, E>,
) => {
  const ensured: Array<string> = [];
  const portSpaces = PortSpaces.of({
    capability: Effect.succeed({ available: true }),
    ensure: (threadId) =>
      options.ensureFails
        ? Effect.fail(new PortSpaceCommandError({ operation: "ensure", detail: "no helper" }))
        : Effect.sync(() => {
            ensured.push(threadId);
          }),
    wrapSpawn: () => wrapped,
    hostAddress: () => Effect.succeed("10.0.2.2"),
    listeners: () => Effect.succeed([]),
    release: () => Effect.void,
  });
  return Effect.gen(function* () {
    const wrap = yield* makeThreadSpawnWrapper;
    return yield* use(wrap, ensured);
  }).pipe(
    Effect.provideService(PortSpaces, portSpaces),
    Effect.provide(ServerSettings.layerTest({ enablePortSpaces: options.enabled })),
  );
};

describe("ThreadPortSpace", () => {
  it.effect("leaves the spawn alone when the environment has port spaces off", () =>
    withWrapper({ enabled: false }, (wrap, ensured) =>
      Effect.gen(function* () {
        expect(yield* wrap("thread-1", { command: "zsh", args: [] })).toBeUndefined();
        expect(ensured).toEqual([]);
      }),
    ),
  );

  it.effect("makes the namespace, then wraps the spawn into it", () =>
    withWrapper({ enabled: true }, (wrap, ensured) =>
      Effect.gen(function* () {
        expect(yield* wrap("thread-1", { command: "zsh", args: [] })).toEqual(wrapped);
        expect(ensured).toEqual(["thread-1"]);
      }),
    ),
  );

  it.effect("falls back to the host network when the namespace cannot be made", () =>
    withWrapper({ enabled: true, ensureFails: true }, (wrap) =>
      Effect.gen(function* () {
        expect(yield* wrap("thread-1", { command: "zsh", args: [] })).toBeUndefined();
      }),
    ),
  );
});
