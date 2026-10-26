// A TCP relay is raw bytes in and out; there is nothing for Effect to model here, and
// `t3 portspace-relay` is on the startup path of every port space (see bin.ts).
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeNet from "node:net";

/**
 * `t3 portspace-relay <socket>` runs inside a namespace; a path-based unix socket is visible from
 * every namespace, so the host can dial it. Each connection sends `<4|6|L> <port>` (`L` is
 * `localhost`), gets one status byte, then the proxied stream. Only the T3 user can read the
 * socket's directory, which is what limits who can ask this process to connect somewhere.
 */

export const PORT_RELAY_COMMAND = "portspace-relay";
export const PORT_RELAY_READY_LINE = "t3-portspace-relay-ready";

export const RELAY_STATUS_CONNECTED = 0;
const RELAY_STATUS_FAILED = 1;

export type RelayFamily = 4 | 6 | "localhost";

const MAX_HEADER_BYTES = 16;

const FAMILY_TOKEN = { 4: "4", 6: "6", localhost: "L" } as const;

export const encodeRelayTarget = (family: RelayFamily, port: number): string =>
  `${FAMILY_TOKEN[family]} ${port}\n`;

const UPSTREAM_HOST = { "4": "127.0.0.1", "6": "::1", L: "localhost" } as const;

const connectThrough = (client: NodeNet.Socket) => {
  let buffered = Buffer.alloc(0);

  const fail = () => {
    if (client.writable) client.end(Buffer.from([RELAY_STATUS_FAILED]));
    else client.destroy();
  };

  const onData = (chunk: Buffer) => {
    buffered = Buffer.concat([buffered, chunk]);
    const end = buffered.indexOf(10);
    if (end < 0) {
      if (buffered.length > MAX_HEADER_BYTES) client.destroy();
      return;
    }
    client.off("data", onData);
    client.pause();
    const target = /^([46L]) (\d{1,5})$/.exec(buffered.subarray(0, end).toString("latin1"));
    const port = target === null ? 0 : Number(target[2]);
    if (target === null || port < 1 || port > 65535) {
      fail();
      return;
    }
    const rest = buffered.subarray(end + 1);
    const upstream = NodeNet.connect({
      host: UPSTREAM_HOST[target[1] as keyof typeof UPSTREAM_HOST],
      port,
      allowHalfOpen: true,
    });
    const close = () => {
      client.destroy();
      upstream.destroy();
    };
    client.on("error", close);
    upstream.once("error", () => {
      upstream.destroy();
      fail();
    });
    upstream.once("connect", () => {
      upstream.on("error", close);
      client.write(Buffer.from([RELAY_STATUS_CONNECTED]));
      if (rest.length > 0) upstream.write(rest);
      client.pipe(upstream);
      upstream.pipe(client);
      client.resume();
    });
  };

  client.on("data", onData);
  client.on("error", () => client.destroy());
};

/** Serves until stdin closes, which is how the host says it is gone. */
export const runPortRelay = (socketPath: string): Promise<never> =>
  new Promise((_, reject) => {
    const server = NodeNet.createServer({ allowHalfOpen: true }, connectThrough);
    server.once("error", reject);
    server.listen(socketPath, () => {
      process.stdout.write(`${PORT_RELAY_READY_LINE}\n`);
    });
    process.stdin.on("data", () => {});
    process.stdin.once("close", () => process.exit(0));
    process.once("SIGTERM", () => process.exit(0));
  });
