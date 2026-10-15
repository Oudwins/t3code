import {
  CONFIGURED_LOCAL_SERVER_URLS_MAX_ITEMS,
  PREVIEW_URL_MAX_LENGTH,
  ThreadId,
  type DiscoveredLocalServer,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  boundConfiguredLocalServerUrls,
  isThreadPort,
  threadPreviewServers,
} from "./portDiscoveryState";

const threadA = ThreadId.make("thread-a");
const threadB = ThreadId.make("thread-b");

const server = (
  port: number,
  owner?: { readonly terminalThread?: ThreadId; readonly portSpaceThread?: ThreadId },
): DiscoveredLocalServer => ({
  host: "127.0.0.1",
  port,
  url: `http://127.0.0.1:${port}`,
  processName: "node",
  pid: null,
  terminal: owner?.terminalThread
    ? { threadId: owner.terminalThread, terminalId: "default" }
    : null,
  ...(owner?.portSpaceThread ? { portSpace: { threadId: owner.portSpaceThread } } : {}),
});

describe("isThreadPort", () => {
  it("claims servers by terminal while port spaces are off", () => {
    expect(isThreadPort(server(3000, { terminalThread: threadA }), threadA, false)).toBe(true);
    expect(isThreadPort(server(3000, { portSpaceThread: threadA }), threadA, false)).toBe(false);
    expect(isThreadPort(server(5000), threadA, false)).toBe(false);
  });

  it("claims only the thread's own namespace servers once port spaces are on", () => {
    expect(isThreadPort(server(3000, { portSpaceThread: threadA }), threadA, true)).toBe(true);
    expect(isThreadPort(server(3000, { portSpaceThread: threadB }), threadA, true)).toBe(false);
    expect(isThreadPort(server(3000, { terminalThread: threadA }), threadA, true)).toBe(false);
  });
});

describe("threadPreviewServers", () => {
  const own = server(3000, { portSpaceThread: threadA });
  const other = server(3000, { portSpaceThread: threadB });
  const plain = server(5173);

  it("lists only the thread's namespace servers when port spaces are on", () => {
    expect(threadPreviewServers([own, other, plain], threadA, true)).toEqual([own]);
  });

  it("drops namespace servers and keeps host servers when port spaces are off", () => {
    expect(threadPreviewServers([own, other, plain], threadA, false)).toEqual([plain]);
  });
});

describe("boundConfiguredLocalServerUrls", () => {
  it("keeps subscription payloads within the discovery RPC bounds", () => {
    const urls = Array.from(
      { length: CONFIGURED_LOCAL_SERVER_URLS_MAX_ITEMS + 1 },
      (_, index) => `http://localhost:${3_000 + index}`,
    );
    urls.unshift(
      "https://example.com",
      "not a URL",
      `http://localhost/${"a".repeat(PREVIEW_URL_MAX_LENGTH)}`,
    );

    const bounded = boundConfiguredLocalServerUrls(urls);

    expect(bounded).toHaveLength(CONFIGURED_LOCAL_SERVER_URLS_MAX_ITEMS);
    expect(bounded.every((url) => url.startsWith("http://localhost:"))).toBe(true);
  });

  it("does not let fragment-only variants crowd out another server", () => {
    const fragments = Array.from(
      { length: CONFIGURED_LOCAL_SERVER_URLS_MAX_ITEMS },
      (_, index) => `http://localhost:3000/docs#section-${index}`,
    );

    expect(boundConfiguredLocalServerUrls([...fragments, "http://localhost:4000/app"])).toEqual([
      "http://localhost:3000/docs#section-0",
      "http://localhost:4000/app",
    ]);
  });
});
