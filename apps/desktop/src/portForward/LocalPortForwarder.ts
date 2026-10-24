// @effect-diagnostics nodeBuiltinImport:off -- Local listeners and tunnel sockets are Node streams at the Electron main boundary.
/**
 * Makes one thread's port space listeners reachable at their own ports on this
 * machine's loopback, so `curl localhost:3000` or an ordinary browser reaches
 * that thread's app. Each accepted connection opens one port tunnel into the
 * thread it was accepted for; a switch closes those connections instead of
 * reassigning them.
 */
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as NodeNet from "node:net";
import * as NodeStream from "node:stream";

import * as PortSpaceProxy from "../preview/PortSpaceProxy.ts";

/** A TCP listener inside the thread's namespace, as `ss` reports its address. */
export interface ForwardListener {
  readonly address: string;
  readonly port: number;
}

/** Opens one TCP connection to `port` in the selected thread's namespace. */
export type ForwardDial = (family: 4 | 6, port: number) => Promise<NodeStream.Duplex>;

export interface ForwardSelection {
  /** Identifies the thread; connections survive a re-apply only while it is unchanged. */
  readonly key: string;
  readonly listeners: ReadonlyArray<ForwardListener>;
  readonly dial: ForwardDial;
}

type LocalHost = "127.0.0.1" | "::1";

export interface LocalEndpoint {
  readonly host: LocalHost;
  readonly port: number;
  readonly family: 4 | 6;
}

export interface ForwardedPort {
  readonly host: LocalHost;
  readonly port: number;
  /** `conflict`: something on this machine already serves the address, so it is left alone. */
  readonly state: "forwarding" | "conflict";
}

/** Ports below this need root to bind on most machines; they are not forwarded. */
const FIRST_UNPRIVILEGED_PORT = 1024;
const IPV4: LocalEndpoint["host"] = "127.0.0.1";
const IPV6: LocalEndpoint["host"] = "::1";

/**
 * Where a namespace listener is reachable through the tunnel, which only dials
 * `127.0.0.1` and `::1`. `ss` prints a dual-stack socket as `*` and a
 * v6-only one as `::`, so only `*` is reachable on both families.
 */
const familiesFor = (address: string): ReadonlyArray<4 | 6> => {
  if (address === "*") return [4, 6];
  if (address === "127.0.0.1" || address === "0.0.0.0") return [4];
  if (address === "::1" || address === "::") return [6];
  return [];
};

export const localEndpoints = (
  listeners: ReadonlyArray<ForwardListener>,
): ReadonlyArray<LocalEndpoint> => {
  const endpoints = new Map<string, LocalEndpoint>();
  for (const { address, port } of listeners) {
    if (port < FIRST_UNPRIVILEGED_PORT || port > 65535) continue;
    for (const family of familiesFor(address)) {
      const host = family === 4 ? IPV4 : IPV6;
      endpoints.set(`${host} ${port}`, { host, port, family });
    }
  }
  return [...endpoints.values()].toSorted((a, b) => a.port - b.port || a.family - b.family);
};

const endpointKey = (endpoint: { readonly host: string; readonly port: number }) =>
  `${endpoint.host} ${endpoint.port}`;

/**
 * Whether something already accepts connections at the address. Binding alone
 * cannot tell: macOS lets `127.0.0.1:3000` be bound over another process's
 * `0.0.0.0:3000` and would silently take its loopback traffic.
 */
const isAddressServed = (host: string, port: number): Promise<boolean> =>
  new Promise((resolve) => {
    const socket = NodeNet.connect({ host, port });
    const settle = (served: boolean) => {
      socket.destroy();
      resolve(served);
    };
    socket.setTimeout(1_000, () => settle(true));
    socket.once("connect", () => settle(true));
    socket.once("error", () => settle(false));
  });

type ListenResult =
  | { readonly kind: "bound"; readonly server: NodeNet.Server }
  | { readonly kind: "in-use" }
  | { readonly kind: "unavailable" };

const listen = (
  host: string,
  port: number,
  onConnection: (socket: NodeNet.Socket) => void,
): Promise<ListenResult> =>
  new Promise((resolve) => {
    const server = NodeNet.createServer({ pauseOnConnect: true }, onConnection);
    server.once("error", (error: NodeJS.ErrnoException) => {
      server.close();
      resolve(error.code === "EADDRINUSE" ? { kind: "in-use" } : { kind: "unavailable" });
    });
    server.listen({ host, port, exclusive: true }, () => {
      server.removeAllListeners("error");
      server.on("error", () => server.close());
      resolve({ kind: "bound", server });
    });
  });

interface BoundEndpoint extends LocalEndpoint {
  readonly server: NodeNet.Server;
  readonly connections: Set<NodeNet.Socket>;
  /** Where new connections go; changes only through `apply`. */
  target: Pick<ForwardSelection, "key" | "dial">;
}

export interface PortForwarder {
  /**
   * Forwards exactly `selection`'s listeners, or nothing for `null`. Calls
   * apply in order. Re-applying the same selection retries conflicted ports.
   */
  readonly apply: (selection: ForwardSelection | null) => Promise<ReadonlyArray<ForwardedPort>>;
  /** Closes every listener and connection. */
  readonly close: () => Promise<void>;
}

export const makePortForwarder = (
  isServed: (host: string, port: number) => Promise<boolean> = isAddressServed,
): PortForwarder => {
  const bound = new Map<string, BoundEndpoint>();
  let queue: Promise<unknown> = Promise.resolve();

  const dropConnections = (endpoint: BoundEndpoint) => {
    for (const socket of endpoint.connections) socket.destroy();
    endpoint.connections.clear();
  };

  const release = (endpoint: BoundEndpoint) => {
    bound.delete(endpointKey(endpoint));
    endpoint.server.close();
    dropConnections(endpoint);
  };

  const connect = (endpoint: BoundEndpoint, client: NodeNet.Socket) => {
    // The destination is fixed at accept time; a later switch closes this
    // connection rather than pointing it at another thread.
    const { target, family, port } = endpoint;
    endpoint.connections.add(client);
    client.once("close", () => endpoint.connections.delete(client));
    client.on("error", () => client.destroy());
    target.dial(family, port).then(
      (upstream) => {
        if (client.destroyed) return void upstream.destroy();
        // The tunnel carries no half-close, so either side ending ends both.
        NodeStream.pipeline(client, upstream, () => client.destroy());
        NodeStream.pipeline(upstream, client, () => upstream.destroy());
        client.resume();
      },
      () => client.destroy(),
    );
  };

  const bind = async (
    endpoint: LocalEndpoint,
    target: BoundEndpoint["target"],
  ): Promise<ForwardedPort | null> => {
    const key = endpointKey(endpoint);
    const conflict = { host: endpoint.host, port: endpoint.port, state: "conflict" } as const;
    if (await isServed(endpoint.host, endpoint.port)) return conflict;
    const result = await listen(endpoint.host, endpoint.port, (client) => {
      const current = bound.get(key);
      if (current === undefined) client.destroy();
      else connect(current, client);
    });
    // `unavailable` is a family this machine does not have, such as IPv6 turned off.
    if (result.kind === "unavailable") return null;
    if (result.kind === "in-use") return conflict;
    bound.set(key, { ...endpoint, target, server: result.server, connections: new Set() });
    return { host: endpoint.host, port: endpoint.port, state: "forwarding" };
  };

  const applyNow = async (selection: ForwardSelection | null) => {
    const desired = selection === null ? [] : localEndpoints(selection.listeners);
    const desiredKeys = new Set(desired.map(endpointKey));
    // Release and retarget before any await, so no connection accepted from
    // here on reaches the previous thread.
    for (const endpoint of bound.values()) {
      if (selection === null || !desiredKeys.has(endpointKey(endpoint))) {
        release(endpoint);
      } else {
        if (endpoint.target.key !== selection.key) dropConnections(endpoint);
        endpoint.target = { key: selection.key, dial: selection.dial };
      }
    }
    if (selection === null) return [];
    const ports: Array<ForwardedPort> = [];
    for (const endpoint of desired) {
      if (bound.has(endpointKey(endpoint))) {
        ports.push({ host: endpoint.host, port: endpoint.port, state: "forwarding" });
        continue;
      }
      const port = await bind(endpoint, { key: selection.key, dial: selection.dial });
      if (port !== null) ports.push(port);
    }
    return ports;
  };

  const enqueue = <A>(run: () => Promise<A>): Promise<A> => {
    const next = queue.then(run, run);
    queue = next.catch(() => undefined);
    return next;
  };

  return {
    apply: (selection) => enqueue(() => applyNow(selection)),
    close: () => enqueue(() => applyNow(null)).then(() => undefined),
  };
};

export interface LocalPortForwardingInput {
  readonly environmentId: string;
  readonly threadId: string;
  readonly listeners: ReadonlyArray<ForwardListener>;
}

export interface PortForwardingStatus {
  readonly environmentId: string;
  readonly threadId: string;
  readonly ports: ReadonlyArray<ForwardedPort>;
}

const CONFLICT_RETRY_INTERVAL = Duration.seconds(5);

/**
 * Which window's selection is forwarded: the most recently focused window that
 * has one. Focusing another app changes nothing, so the user's own browser
 * keeps reaching the thread they last selected in T3.
 */
export const activeSelection = <A>(
  selections: ReadonlyMap<number, A>,
  focusOrder: ReadonlyArray<number>,
): A | null => {
  for (let index = focusOrder.length - 1; index >= 0; index -= 1) {
    const selection = selections.get(focusOrder[index]!);
    if (selection !== undefined) return selection;
  }
  return null;
};

export class LocalPortForwarder extends Context.Service<
  LocalPortForwarder,
  {
    /**
     * Records the thread a window has selected, or `null` for none. Tunnels
     * use the credential `PortSpaceProxy` holds for the environment.
     */
    readonly set: (windowId: number, input: LocalPortForwardingInput | null) => Effect.Effect<void>;
    /**
     * The saved setting. Each window reads its own copy of settings, so a
     * window that has not seen a change must not keep forwarding.
     */
    readonly setEnabled: (enabled: boolean) => Effect.Effect<void>;
    readonly focus: (windowId: number) => Effect.Effect<void>;
    /** Drops a closed window's selection. */
    readonly forget: (windowId: number) => Effect.Effect<void>;
    /** What is forwarded now, or `null` when nothing is. */
    readonly status: SubscriptionRef.SubscriptionRef<PortForwardingStatus | null>;
  }
>()("@t3tools/desktop/portForward/LocalPortForwarder") {}

export const make = Effect.gen(function* LocalPortForwarderMake() {
  const proxy = yield* PortSpaceProxy.PortSpaceProxy;
  const context = yield* Effect.context<never>();
  const forwarder = makePortForwarder();
  yield* Effect.addFinalizer(() => Effect.promise(forwarder.close));

  const selections = new Map<number, LocalPortForwardingInput>();
  /** Window ids, least recently focused first. */
  let focusOrder: ReadonlyArray<number> = [];
  let enabled = false;
  const status = yield* SubscriptionRef.make<PortForwardingStatus | null>(null);

  const reconcile = Effect.gen(function* () {
    const input = enabled ? activeSelection(selections, focusOrder) : null;
    const ports = yield* Effect.promise(() =>
      forwarder.apply(
        input === null
          ? null
          : {
              // Thread ids are only unique within an environment.
              key: `${input.environmentId}\u0000${input.threadId}`,
              listeners: input.listeners,
              dial: (family, port) =>
                Effect.runPromiseWith(context)(proxy.openTunnel({ ...input, family, port })),
            },
      ),
    );
    yield* SubscriptionRef.set(
      status,
      input === null
        ? null
        : { environmentId: input.environmentId, threadId: input.threadId, ports },
    );
  });

  // A conflicting port is taken as soon as the other process lets it go.
  yield* SubscriptionRef.get(status).pipe(
    Effect.flatMap((current) =>
      current?.ports.some((port) => port.state === "conflict") ? reconcile : Effect.void,
    ),
    Effect.repeat(Schedule.spaced(CONFLICT_RETRY_INTERVAL)),
    Effect.forkScoped,
  );

  return LocalPortForwarder.of({
    set: (windowId, input) =>
      Effect.suspend(() => {
        if (input === null) selections.delete(windowId);
        else selections.set(windowId, input);
        // A window that has not been focused since it started ranks last.
        if (!focusOrder.includes(windowId)) focusOrder = [windowId, ...focusOrder];
        return reconcile;
      }),
    setEnabled: (next) =>
      Effect.suspend(() => {
        if (enabled === next) return Effect.void;
        enabled = next;
        return reconcile;
      }),
    focus: (windowId) =>
      Effect.suspend(() => {
        focusOrder = [...focusOrder.filter((id) => id !== windowId), windowId];
        return selections.has(windowId) ? reconcile : Effect.void;
      }),
    forget: (windowId) =>
      Effect.suspend(() => {
        selections.delete(windowId);
        focusOrder = focusOrder.filter((id) => id !== windowId);
        return reconcile;
      }),
    status,
  });
});

export const layer = Layer.effect(LocalPortForwarder, make);
