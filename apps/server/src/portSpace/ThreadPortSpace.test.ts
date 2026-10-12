import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import * as ServerSettings from "../serverSettings.ts";
import { PortSpaceCommandError, PortSpaces } from "./PortSpaces.ts";
import { makeThreadPortSpace, makeThreadSpawnWrapper, urlInPortSpace } from "./ThreadPortSpace.ts";

const wrapped = { command: "helper", args: ["exec"], env: { T3_PORTSPACE_PROLOGUE: "" } };

const stubPortSpaces = (ensure: (threadId: string) => Effect.Effect<void, PortSpaceCommandError>) =>
  PortSpaces.of({
    capability: Effect.succeed({ available: true }),
    ensure,
    wrapSpawn: () => wrapped,
    hostAddress: () => Effect.succeed("10.0.2.2"),
    listeners: () => Effect.succeed([]),
    release: () => Effect.void,
  });

const withWrapper = <A, E>(
  options: { readonly enabled: boolean; readonly ensureFails?: boolean },
  use: (
    wrap: Effect.Success<typeof makeThreadSpawnWrapper>,
    ensured: Array<string>,
  ) => Effect.Effect<A, E>,
) => {
  const ensured: Array<string> = [];
  const portSpaces = stubPortSpaces((threadId) =>
    options.ensureFails
      ? Effect.fail(new PortSpaceCommandError({ operation: "ensure", detail: "no helper" }))
      : Effect.sync(() => {
          ensured.push(threadId);
        }),
  );
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

describe("ThreadPortSpace.resolve", () => {
  it.effect("hands adapters a handle that rewrites spawns and finds the host", () =>
    Effect.gen(function* () {
      const { resolve } = yield* makeThreadPortSpace;
      const handle = yield* resolve("thread-1");
      expect(handle?.rewrite({ command: "claude", args: [] })).toEqual(wrapped);
      expect(yield* handle!.hostAddress).toBe("10.0.2.2");
    }).pipe(
      Effect.provideService(
        PortSpaces,
        stubPortSpaces(() => Effect.void),
      ),
      Effect.provide(ServerSettings.layerTest({ enablePortSpaces: true })),
    ),
  );

  it.effect("hands out nothing when the environment has port spaces off", () =>
    Effect.gen(function* () {
      const { resolve } = yield* makeThreadPortSpace;
      expect(yield* resolve("thread-1")).toBeUndefined();
    }).pipe(
      Effect.provideService(
        PortSpaces,
        stubPortSpaces(() => Effect.void),
      ),
      Effect.provide(ServerSettings.layerTest({ enablePortSpaces: false })),
    ),
  );
});

describe("urlInPortSpace", () => {
  it("points loopback URLs at the host address", () => {
    expect(urlInPortSpace("http://127.0.0.1:4120/mcp/abc", "192.168.5.2")).toBe(
      "http://192.168.5.2:4120/mcp/abc",
    );
    expect(urlInPortSpace("http://localhost:4120/mcp?x=1", "192.168.5.2")).toBe(
      "http://192.168.5.2:4120/mcp?x=1",
    );
    expect(urlInPortSpace("http://[::1]:4120/mcp", "192.168.5.2")).toBe(
      "http://192.168.5.2:4120/mcp",
    );
  });

  it("leaves other hosts and unparseable values alone", () => {
    expect(urlInPortSpace("https://example.com/mcp", "192.168.5.2")).toBe(
      "https://example.com/mcp",
    );
    expect(urlInPortSpace("not a url", "192.168.5.2")).toBe("not a url");
  });
});
