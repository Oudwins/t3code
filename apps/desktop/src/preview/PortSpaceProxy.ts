// @effect-diagnostics nodeBuiltinImport:off -- The SOCKS listener and tunnel sockets are Node streams at the Electron main boundary.
/** A per-thread SOCKS5 proxy that sends loopback requests through the environment's port tunnel. */
import type { Session } from "electron";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as NodeNet from "node:net";
import * as NodeStream from "node:stream";

export interface PortSpaceTunnelAccess {
  readonly url: string;
  readonly ticket: string;
}

export type TunnelFamily = 4 | 6 | "localhost";

export type SocksTarget =
  | { readonly kind: "domain"; readonly host: string; readonly port: number }
  | { readonly kind: "ipv4"; readonly bytes: Uint8Array; readonly port: number }
  | { readonly kind: "ipv6"; readonly bytes: Uint8Array; readonly port: number };

export type SocksRoute =
  | { readonly kind: "tunnel"; readonly family: TunnelFamily; readonly port: number }
  | { readonly kind: "direct"; readonly host: string; readonly port: number }
  | { readonly kind: "blocked" };

const SOCKS_VERSION = 5;
const COMMAND_CONNECT = 1;
const REPLY_SUCCEEDED = 0;
const REPLY_FAILURE = 5;
const REPLY_COMMAND_UNSUPPORTED = 7;
const REPLY_ADDRESS_UNSUPPORTED = 8;
const MAX_REQUEST_BYTES = 262;

const ipv4Route = (bytes: Uint8Array, port: number): SocksRoute => {
  const [a, b, c, d] = bytes;
  if (a === 127) {
    return b === 0 && c === 0 && d === 1
      ? { kind: "tunnel", family: 4, port }
      : { kind: "blocked" };
  }
  if (a === 0) return { kind: "blocked" };
  return { kind: "direct", host: `${a}.${b}.${c}.${d}`, port };
};

const formatIpv6 = (bytes: Uint8Array): string => {
  const groups: string[] = [];
  for (let index = 0; index < 16; index += 2) {
    groups.push((((bytes[index] ?? 0) << 8) | (bytes[index + 1] ?? 0)).toString(16));
  }
  return groups.join(":");
};

/** Loopback belongs to the thread's namespace; forms the tunnel cannot express are refused, never sent to this machine. */
export const routeTarget = (target: SocksTarget): SocksRoute => {
  if (target.kind === "ipv4") return ipv4Route(target.bytes, target.port);
  if (target.kind === "ipv6") {
    const { bytes, port } = target;
    const leadingZeros = bytes.subarray(0, 10).every((byte) => byte === 0);
    if (leadingZeros && bytes[10] === 0xff && bytes[11] === 0xff) {
      return ipv4Route(bytes.subarray(12), port);
    }
    if (bytes.subarray(0, 15).every((byte) => byte === 0)) {
      return bytes[15] === 1 ? { kind: "tunnel", family: 6, port } : { kind: "blocked" };
    }
    return { kind: "direct", host: formatIpv6(bytes), port };
  }
  const host = target.host.toLowerCase().replace(/\.$/, "");
  if (host === "localhost" || host.endsWith(".localhost")) {
    return { kind: "tunnel", family: "localhost", port: target.port };
  }
  return { kind: "direct", host: target.host, port: target.port };
};

export type SocksParse<T> = "incomplete" | "invalid" | T;

const parseGreeting = (
  buffer: Uint8Array,
): SocksParse<{ readonly length: number; readonly offersNoAuth: boolean }> => {
  if (buffer.length < 2) return "incomplete";
  if (buffer[0] !== SOCKS_VERSION) return "invalid";
  const length = 2 + (buffer[1] ?? 0);
  if (buffer.length < length) return "incomplete";
  return { length, offersNoAuth: buffer.subarray(2, length).includes(0) };
};

export type SocksRequest =
  | { readonly kind: "connect"; readonly length: number; readonly target: SocksTarget }
  | { readonly kind: "unsupported"; readonly reply: number };

const parseRequest = (buffer: Uint8Array): SocksParse<SocksRequest> => {
  if (buffer.length < 4) return "incomplete";
  if (buffer[0] !== SOCKS_VERSION) return "invalid";
  if (buffer[1] !== COMMAND_CONNECT)
    return { kind: "unsupported", reply: REPLY_COMMAND_UNSUPPORTED };
  const addressType = buffer[3];
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  if (addressType === 1 || addressType === 4) {
    const size = addressType === 1 ? 4 : 16;
    const length = 4 + size + 2;
    if (buffer.length < length) return "incomplete";
    const bytes = buffer.slice(4, 4 + size);
    const port = view.getUint16(4 + size);
    return {
      kind: "connect",
      length,
      target: addressType === 1 ? { kind: "ipv4", bytes, port } : { kind: "ipv6", bytes, port },
    };
  }
  if (addressType === 3) {
    if (buffer.length < 5) return "incomplete";
    const hostLength = buffer[4] ?? 0;
    const length = 5 + hostLength + 2;
    if (buffer.length < length) return "incomplete";
    return {
      kind: "connect",
      length,
      target: {
        kind: "domain",
        host: new TextDecoder().decode(buffer.subarray(5, 5 + hostLength)),
        port: view.getUint16(5 + hostLength),
      },
    };
  }
  return { kind: "unsupported", reply: REPLY_ADDRESS_UNSUPPORTED };
};

const reply = (code: number): Buffer => Buffer.from([SOCKS_VERSION, code, 0, 1, 0, 0, 0, 0, 0, 0]);

export type SocksConnect = (target: SocksTarget) => Promise<NodeStream.Duplex>;

export interface SocksServer {
  readonly port: number;
  readonly close: () => void;
}

const serveClient = (client: NodeNet.Socket, connect: SocksConnect) => {
  let pending = Buffer.alloc(0);
  let stage: "greeting" | "request" | "connecting" = "greeting";
  let clientClosed = false;
  client.on("error", () => client.destroy());
  client.once("close", () => {
    clientClosed = true;
  });

  const refuse = (code: number) => client.end(reply(code));

  const onData = (chunk: Buffer) => {
    pending = Buffer.concat([pending, chunk]);
    if (pending.length > MAX_REQUEST_BYTES) return client.destroy();
    if (stage === "greeting") {
      const greeting = parseGreeting(pending);
      if (greeting === "incomplete") return;
      if (greeting === "invalid") return client.destroy();
      pending = pending.subarray(greeting.length);
      if (!greeting.offersNoAuth) return void client.end(Buffer.from([SOCKS_VERSION, 0xff]));
      client.write(Buffer.from([SOCKS_VERSION, 0]));
      stage = "request";
    }
    if (stage !== "request") return;
    const request = parseRequest(pending);
    if (request === "incomplete") return;
    if (request === "invalid") return client.destroy();
    if (request.kind === "unsupported") return refuse(request.reply);
    const earlyBytes = pending.subarray(request.length);
    stage = "connecting";
    client.off("data", onData);
    client.pause();
    connect(request.target).then(
      (upstream) => {
        if (clientClosed) return upstream.destroy();
        client.write(reply(REPLY_SUCCEEDED));
        if (earlyBytes.length > 0) upstream.write(earlyBytes);
        NodeStream.pipeline(client, upstream, () => {});
        NodeStream.pipeline(upstream, client, () => {});
        client.resume();
      },
      () => refuse(REPLY_FAILURE),
    );
  };
  client.on("data", onData);
};

// Chromium's SOCKS5 client cannot authenticate, so any local process can use this listener.
export const startSocksServer = (connect: SocksConnect): Promise<SocksServer> =>
  new Promise((resolve, reject) => {
    const clients = new Set<NodeNet.Socket>();
    const server = NodeNet.createServer((client) => {
      clients.add(client);
      client.once("close", () => clients.delete(client));
      serveClient(client, connect);
    });
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port: 0 }, () => {
      const address = server.address();
      resolve({
        port: typeof address === "object" && address !== null ? address.port : 0,
        close: () => {
          server.close();
          for (const client of clients) client.destroy();
        },
      });
    });
  });

export interface TunnelHandlers {
  readonly open: () => void;
  readonly message: (data: Uint8Array) => void;
  readonly close: () => void;
  readonly error: () => void;
}

export interface TunnelSocket {
  readonly send: (data: Uint8Array) => void;
  readonly close: () => void;
  readonly isOpen: () => boolean;
}

export type TunnelSocketFactory = (url: string, handlers: TunnelHandlers) => TunnelSocket;

const webSocketFactory: TunnelSocketFactory = (url, handlers) => {
  const socket = new WebSocket(url);
  socket.binaryType = "arraybuffer";
  socket.addEventListener("open", handlers.open);
  socket.addEventListener("close", handlers.close);
  socket.addEventListener("error", handlers.error);
  socket.addEventListener("message", (event) => {
    if (event.data instanceof ArrayBuffer) handlers.message(new Uint8Array(event.data));
  });
  return {
    send: (data) => socket.send(new Uint8Array(data)),
    close: () => socket.close(),
    isOpen: () => socket.readyState === WebSocket.OPEN,
  };
};

const tunnelUrl = (
  access: PortSpaceTunnelAccess,
  threadId: string,
  family: TunnelFamily,
  port: number,
): string => {
  const url = new URL(access.url);
  url.searchParams.set("threadId", threadId);
  url.searchParams.set("family", String(family));
  url.searchParams.set("port", String(port));
  url.searchParams.set("wsTicket", access.ticket);
  return url.toString();
};

/** One TCP connection in the thread's namespace, carried by one WebSocket. */
const openTunnel = (url: string, createSocket: TunnelSocketFactory): Promise<NodeStream.Duplex> =>
  new Promise((resolve, reject) => {
    let opened = false;
    const stream: NodeStream.Duplex = new NodeStream.Duplex({
      read() {},
      write(chunk: Buffer, _encoding, done) {
        if (!socket.isOpen()) return done(new Error("port tunnel closed"));
        socket.send(chunk);
        done();
      },
      final(done) {
        socket.close();
        done();
      },
      destroy(error, done) {
        socket.close();
        done(error);
      },
    });
    const socket = createSocket(url, {
      open: () => {
        opened = true;
        resolve(stream);
      },
      message: (data) => void stream.push(Buffer.from(data)),
      close: () => {
        if (opened) stream.push(null);
        else reject(new Error("port tunnel closed before it opened"));
      },
      error: () => {
        if (opened) stream.destroy(new Error("port tunnel failed"));
        else reject(new Error("port tunnel could not be opened"));
      },
    });
  });

const connectDirect = (host: string, port: number): Promise<NodeStream.Duplex> =>
  new Promise((resolve, reject) => {
    const socket = NodeNet.connect({ host, port });
    socket.once("error", reject);
    socket.once("connect", () => {
      socket.off("error", reject);
      socket.on("error", () => socket.destroy());
      resolve(socket);
    });
  });

export const makeSocksConnect =
  (input: {
    readonly threadId: string;
    readonly access: () => PortSpaceTunnelAccess | undefined;
    readonly createSocket: TunnelSocketFactory;
    readonly connectDirect?: (host: string, port: number) => Promise<NodeStream.Duplex>;
  }): SocksConnect =>
  async (target) => {
    const route = routeTarget(target);
    if (route.kind === "blocked") throw new Error("loopback target is not tunnelable");
    if (route.kind === "direct")
      return (input.connectDirect ?? connectDirect)(route.host, route.port);
    const access = input.access();
    if (access === undefined) throw new Error("the environment's port tunnel is not available");
    return openTunnel(
      tunnelUrl(access, input.threadId, route.family, route.port),
      input.createSocket,
    );
  };

export class PortSpaceProxyError extends Schema.TaggedError<PortSpaceProxyError>()(
  "PortSpaceProxyError",
  {
    environmentId: Schema.String,
    threadId: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to route the preview session for thread ${this.threadId} through its port space.`;
  }
}

export class PortSpaceProxy extends Context.Service<
  PortSpaceProxy,
  {
    /** Credentials for loopback dials in one environment; `null` makes them fail. */
    readonly setTunnel: (input: {
      readonly environmentId: string;
      readonly access: PortSpaceTunnelAccess | null;
    }) => Effect.Effect<void>;
    /** Sends every request from `session` through the thread's port space. */
    readonly attach: (
      session: Session,
      input: { readonly environmentId: string; readonly threadId: string },
    ) => Effect.Effect<void, PortSpaceProxyError>;
  }
>()("@t3tools/desktop/preview/PortSpaceProxy") {}

/** @public Service construction is part of the canonical Effect module API. */
export const make = (createSocket: TunnelSocketFactory = webSocketFactory) =>
  Effect.gen(function* PortSpaceProxyMake() {
    const tunnels = new Map<string, PortSpaceTunnelAccess>();
    const servers = new Map<string, Promise<SocksServer>>();

    yield* Effect.addFinalizer(() =>
      Effect.promise(async () => {
        for (const server of servers.values()) (await server.catch(() => null))?.close();
        servers.clear();
      }),
    );

    const listener = (environmentId: string, threadId: string): Promise<SocksServer> => {
      const key = JSON.stringify([environmentId, threadId]);
      const existing = servers.get(key);
      if (existing) return existing;
      const started = startSocksServer(
        makeSocksConnect({
          threadId,
          access: () => tunnels.get(environmentId),
          createSocket,
        }),
      );
      servers.set(key, started);
      started.catch(() => servers.delete(key));
      return started;
    };

    return PortSpaceProxy.of({
      setTunnel: ({ environmentId, access }) =>
        Effect.sync(() => {
          if (access === null) tunnels.delete(environmentId);
          else tunnels.set(environmentId, access);
        }),
      attach: Effect.fn("PortSpaceProxy.attach")(function* (session, { environmentId, threadId }) {
        yield* Effect.tryPromise({
          try: async () => {
            const { port } = await listener(environmentId, threadId);
            // `<-loopback>` removes Chromium's implicit loopback bypass so
            // `localhost` reaches the proxy instead of this machine.
            await session.setProxy({
              proxyRules: `socks5://127.0.0.1:${port}`,
              proxyBypassRules: "<-loopback>",
            });
          },
          catch: (cause) => new PortSpaceProxyError({ environmentId, threadId, cause }),
        });
      }),
    });
  });

export const layer = Layer.effect(PortSpaceProxy, make());
