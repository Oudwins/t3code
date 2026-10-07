import { describe, expect, it, vi } from "vite-plus/test";

import { buildThreadStateActionItems } from "./CommandPalette.threadActions";
import type { SnoozePreset } from "./Sidebar.snooze";

const presets: ReadonlyArray<SnoozePreset> = [
  {
    id: "hour",
    label: "In an hour",
    whenLabel: "10:00 AM",
    snoozedUntil: "2026-10-07T10:00:00.000Z",
  },
  {
    id: "tomorrow",
    label: "Tomorrow",
    whenLabel: "9:00 AM",
    snoozedUntil: "2026-10-08T09:00:00.000Z",
  },
];

function build(overrides: Partial<Parameters<typeof buildThreadStateActionItems>[0]> = {}) {
  const handlers = {
    onSettledChange: vi.fn(async () => {}),
    onSnooze: vi.fn(async () => {}),
    onCustomSnooze: vi.fn(async () => {}),
    onWake: vi.fn(async () => {}),
  };
  const items = buildThreadStateActionItems({
    settled: false,
    snoozed: false,
    canSnooze: true,
    snoozePresets: presets,
    ...handlers,
    ...overrides,
  });
  return { items, handlers };
}

describe("buildThreadStateActionItems", () => {
  it("offers settle, and un-settle once the thread is settled", async () => {
    const open = build({ settled: false });
    const settle = open.items.find((item) => item.value === "action:settle-thread");
    expect(settle?.title).toBe("Settle thread");
    expect(settle?.shortcutCommand).toBe("thread.settle");
    if (settle?.kind !== "action") throw new Error("expected an action row");
    await settle.run();
    expect(open.handlers.onSettledChange).toHaveBeenCalledWith(true);

    const settled = build({ settled: true });
    const unsettle = settled.items.find((item) => item.value === "action:unsettle-thread");
    expect(unsettle?.title).toBe("Un-settle thread");
    expect(settled.items.some((item) => item.value === "action:settle-thread")).toBe(false);
    if (unsettle?.kind !== "action") throw new Error("expected an action row");
    await unsettle.run();
    expect(settled.handlers.onSettledChange).toHaveBeenCalledWith(false);
  });

  it("leaves out rows for environments that cannot settle or snooze", () => {
    expect(build({ settled: null, snoozed: null }).items).toEqual([]);
    expect(build({ settled: null }).items.map((item) => item.value)).toEqual([
      "action:snooze-thread",
    ]);
    expect(build({ snoozed: null }).items.map((item) => item.value)).toEqual([
      "action:settle-thread",
    ]);
  });

  it("snoozes until the picked preset's wake time, with Custom last", async () => {
    const { items, handlers } = build();
    const snooze = items.find((item) => item.value === "action:snooze-thread");
    if (snooze?.kind !== "submenu") throw new Error("expected a submenu row");
    expect(snooze.disabled).toBe(false);
    const options = snooze.groups.flatMap((group) => group.items);
    expect(options.map((item) => item.value)).toEqual([
      "snooze:hour",
      "snooze:tomorrow",
      "snooze:custom",
    ]);
    expect(options[1]?.timestamp).toBe("9:00 AM");

    const [hour, , custom] = options;
    if (hour?.kind !== "action" || custom?.kind !== "action") throw new Error("expected actions");
    await hour.run();
    expect(handlers.onSnooze).toHaveBeenCalledWith("2026-10-07T10:00:00.000Z");
    await custom.run();
    expect(handlers.onCustomSnooze).toHaveBeenCalledOnce();
  });

  it("offers wake instead of snooze while the thread is snoozed", async () => {
    const { items, handlers } = build({ snoozed: true });
    expect(items.some((item) => item.value === "action:snooze-thread")).toBe(false);
    const wake = items.find((item) => item.value === "action:wake-thread");
    expect(wake?.title).toBe("Wake thread");
    expect(wake?.shortcutCommand).toBe("thread.snooze");
    if (wake?.kind !== "action") throw new Error("expected an action row");
    await wake.run();
    expect(handlers.onWake).toHaveBeenCalledOnce();
  });

  it("disables snooze, with a reason, when the thread is waiting on the user", () => {
    const snooze = build({ canSnooze: false }).items.find(
      (item) => item.value === "action:snooze-thread",
    );
    expect(snooze?.disabled).toBe(true);
    expect(snooze?.description).toBeTruthy();
  });
});
