import { CalendarClockIcon, CircleCheckIcon, ClockIcon } from "lucide-react";

import type { SnoozePreset } from "./Sidebar.snooze";
import {
  ADDON_ICON_CLASS,
  ITEM_ICON_CLASS,
  type CommandPaletteActionItem,
  type CommandPaletteSubmenuItem,
} from "./CommandPalette.logic";

/**
 * Settle and snooze for the open thread, worded like the thread action menu.
 * Each is the way back as well as the way in: a settled thread offers
 * "Un-settle", a snoozed one "Wake". A null state means the environment's
 * server predates the feature, so the row is left out.
 */
export function buildThreadStateActionItems(input: {
  readonly settled: boolean | null;
  readonly snoozed: boolean | null;
  readonly canSnooze: boolean;
  readonly snoozePresets: ReadonlyArray<SnoozePreset>;
  readonly onSettledChange: (settled: boolean) => Promise<void>;
  readonly onSnooze: (snoozedUntil: string) => Promise<void>;
  readonly onCustomSnooze: () => Promise<void>;
  readonly onWake: () => Promise<void>;
}): Array<CommandPaletteActionItem | CommandPaletteSubmenuItem> {
  const items: Array<CommandPaletteActionItem | CommandPaletteSubmenuItem> = [];

  if (input.settled !== null) {
    items.push({
      kind: "action",
      value: input.settled ? "action:unsettle-thread" : "action:settle-thread",
      searchTerms: input.settled
        ? ["un-settle", "unsettle", "settled", "reopen", "active"]
        : ["settle", "done", "finish", "complete", "close"],
      title: input.settled ? "Un-settle thread" : "Settle thread",
      icon: <CircleCheckIcon className={ITEM_ICON_CLASS} />,
      shortcutCommand: "thread.settle",
      run: () => input.onSettledChange(!input.settled),
    });
  }

  if (input.snoozed === true) {
    items.push({
      kind: "action",
      value: "action:wake-thread",
      searchTerms: ["wake", "unsnooze", "snoozed", "resume"],
      title: "Wake thread",
      icon: <ClockIcon className={ITEM_ICON_CLASS} />,
      shortcutCommand: "thread.snooze",
      run: input.onWake,
    });
  } else if (input.snoozed === false) {
    items.push({
      kind: "submenu",
      value: "action:snooze-thread",
      searchTerms: ["snooze", "later", "remind", "defer", "hide"],
      title: "Snooze thread...",
      ...(input.canSnooze ? {} : { description: "Waiting on you or has queued work" }),
      disabled: !input.canSnooze,
      icon: <ClockIcon className={ITEM_ICON_CLASS} />,
      addonIcon: <ClockIcon className={ADDON_ICON_CLASS} />,
      shortcutCommand: "thread.snooze",
      groups: [
        {
          value: "snooze-options",
          label: "Snooze until",
          items: [
            ...input.snoozePresets.map((preset): CommandPaletteActionItem => ({
              kind: "action",
              value: `snooze:${preset.id}`,
              searchTerms: [preset.label, preset.whenLabel],
              title: preset.label,
              timestamp: preset.whenLabel,
              icon: <ClockIcon className={ITEM_ICON_CLASS} />,
              run: () => input.onSnooze(preset.snoozedUntil),
            })),
            {
              kind: "action",
              value: "snooze:custom",
              searchTerms: ["custom", "pick a time", "date"],
              title: "Custom…",
              icon: <CalendarClockIcon className={ITEM_ICON_CLASS} />,
              run: input.onCustomSnooze,
            },
          ],
        },
      ],
    });
  }

  return items;
}
