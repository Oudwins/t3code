import { Schema } from "effect";
import { describe, expect, it } from "vite-plus/test";

import { DiscoveredLocalServer } from "./preview.ts";
import { PreviewAutomationHost, PreviewAutomationStatus } from "./previewAutomation.ts";

const decodeServer = Schema.decodeUnknownSync(DiscoveredLocalServer);
const decodeAutomationHost = Schema.decodeUnknownSync(PreviewAutomationHost);
const decodeAutomationStatus = Schema.decodeUnknownSync(PreviewAutomationStatus);

describe("PreviewAutomationHost", () => {
  it("accepts legacy hosts and current operation advertisements", () => {
    expect(decodeAutomationHost({ clientId: "legacy", environmentId: "environment-1" })).toEqual({
      clientId: "legacy",
      environmentId: "environment-1",
    });
    expect(
      decodeAutomationHost({
        clientId: "current",
        environmentId: "environment-1",
        supportedOperations: ["status", "resize"],
      }).supportedOperations,
    ).toEqual(["status", "resize"]);
  });
});

describe("PreviewAutomationStatus", () => {
  it("accepts old hosts without viewport data and exposes it from current hosts", () => {
    const base = {
      available: true,
      visible: false,
      tabId: "preview-t",
      url: "https://example.com",
      title: "Example",
      loading: false,
    };
    expect(decodeAutomationStatus(base)).toEqual(base);
    expect(
      decodeAutomationStatus({
        ...base,
        viewportSetting: { _tag: "preset", presetId: "pixel-8", width: 412, height: 915 },
        viewport: { width: 412, height: 915 },
      }).viewport,
    ).toEqual({ width: 412, height: 915 });
  });
});

describe("DiscoveredLocalServer", () => {
  it("decodes the thread whose port space a server listens in", () => {
    const server = decodeServer({
      host: "localhost",
      port: 3000,
      url: "http://localhost:3000",
      processName: "vite",
      pid: 4321,
      terminal: null,
      portSpace: { threadId: "thread-1" },
    });
    expect(server.portSpace).toEqual({ threadId: "thread-1" });
    expect(
      decodeServer({
        host: "localhost",
        port: 3000,
        url: "http://localhost:3000",
        processName: null,
        pid: null,
        terminal: null,
      }).portSpace,
    ).toBeUndefined();
  });
});
