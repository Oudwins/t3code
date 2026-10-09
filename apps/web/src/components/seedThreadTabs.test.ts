import { describe, expect, it } from "vite-plus/test";

import { seedThreadTabs } from "./seedThreadTabs";

function recorder() {
  const opened: string[] = [];
  const open = {
    terminal: (terminalId: string) => void opened.push(`terminal:${terminalId}`),
    files: () => void opened.push("files"),
    diff: () => void opened.push("diff"),
    browser: async () => {
      await Promise.resolve();
      opened.push("browser");
    },
  };
  return { opened, open };
}

describe("seedThreadTabs", () => {
  it("opens each tab in the configured order, waiting for a browser before the next", async () => {
    const { opened, open } = recorder();
    await seedThreadTabs({
      entries: ["browser", "terminal", "files", "diff"],
      usedTerminalIds: [],
      open,
      settle: () => {},
    });
    expect(opened).toEqual(["browser", "terminal:term-1", "files", "diff"]);
  });

  it("gives repeated terminals distinct ids that avoid ones already in use", async () => {
    const { opened, open } = recorder();
    await seedThreadTabs({
      entries: ["terminal", "terminal", "terminal"],
      usedTerminalIds: ["term-1", "term-3"],
      open,
      settle: () => {},
    });
    expect(opened).toEqual(["terminal:term-2", "terminal:term-4", "terminal:term-5"]);
  });

  it("skips browsers where none can run and settles after every entry", async () => {
    const { opened, open } = recorder();
    let settled = 0;
    await seedThreadTabs({
      entries: ["files", "browser", "diff"],
      usedTerminalIds: [],
      open: { ...open, browser: null },
      settle: () => void (settled += 1),
    });
    expect(opened).toEqual(["files", "diff"]);
    expect(settled).toBe(3);
  });
});
