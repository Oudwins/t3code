import type { NewThreadTab } from "@t3tools/contracts";
import {
  ArrowDownIcon,
  ArrowUpIcon,
  FileDiff,
  Files,
  Globe2,
  PlusIcon,
  TerminalSquare,
  XIcon,
} from "lucide-react";

import { isPreviewSupportedInRuntime } from "../../previewStateStore";
import { Button } from "../ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { SettingResetButton, SettingsRow } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { useScopedSettings, useUpdateScopedSettings } from "./useScopedSettings";

const TAB_OPTIONS = {
  terminal: { label: "Terminal", icon: TerminalSquare },
  files: { label: "Files", icon: Files },
  diff: { label: "Diff", icon: FileDiff },
  browser: { label: "Browser", icon: Globe2 },
} as const satisfies Record<NewThreadTab, { label: string; icon: typeof Files }>;

export function NewThreadTabsSettings() {
  const tabs = useScopedSettings((settings) => settings.newThreadTabs);
  const updateSettings = useUpdateScopedSettings();
  const browserAvailable = isPreviewSupportedInRuntime();
  const addable = (Object.keys(TAB_OPTIONS) as NewThreadTab[]).filter(
    (kind) => kind !== "browser" || browserAvailable,
  );
  const setTabs = (next: readonly NewThreadTab[]) => updateSettings({ newThreadTabs: next });
  const move = (index: number, offset: -1 | 1) => {
    const next = [...tabs];
    const [moved] = next.splice(index, 1);
    if (moved === undefined) return;
    next.splice(index + offset, 0, moved);
    setTabs(next);
  };

  return (
    <SettingsRow
      {...searchableSetting("new-thread-tabs")}
      description="Tabs opened in order when you start a thread. The conversation stays in front. Terminals start empty and browsers start blank."
      resetAction={
        tabs.length > 0 ? (
          <SettingResetButton label="tabs for new threads" onClick={() => setTabs([])} />
        ) : null
      }
      control={
        <Menu>
          <MenuTrigger render={<Button size="sm" variant="outline" />}>
            <PlusIcon />
            Add tab
          </MenuTrigger>
          <MenuPopup align="end">
            {addable.map((kind) => {
              const { label, icon: Icon } = TAB_OPTIONS[kind];
              return (
                <MenuItem key={kind} onClick={() => setTabs([...tabs, kind])}>
                  <Icon />
                  {label}
                </MenuItem>
              );
            })}
          </MenuPopup>
        </Menu>
      }
    >
      {tabs.length > 0 ? (
        <ol className="mt-3 mb-2 divide-y divide-border/50 rounded-lg border border-border/60">
          {tabs.map((kind, index) => {
            const { label, icon: Icon } = TAB_OPTIONS[kind];
            const occurrence = tabs.slice(0, index).filter((entry) => entry === kind).length;
            return (
              <li key={`${kind}-${occurrence}`} className="flex items-center gap-2 py-1 pr-1 pl-3">
                <Icon className="size-4 text-muted-foreground" />
                <span className="min-w-0 flex-1 truncate text-sm">{label}</span>
                <Button
                  size="icon-xs"
                  variant="ghost-muted"
                  disabled={index === 0}
                  aria-label={`Move ${label} up`}
                  onClick={() => move(index, -1)}
                >
                  <ArrowUpIcon />
                </Button>
                <Button
                  size="icon-xs"
                  variant="ghost-muted"
                  disabled={index === tabs.length - 1}
                  aria-label={`Move ${label} down`}
                  onClick={() => move(index, 1)}
                >
                  <ArrowDownIcon />
                </Button>
                <Button
                  size="icon-xs"
                  variant="ghost-muted"
                  aria-label={`Remove ${label}`}
                  onClick={() => setTabs(tabs.filter((_, entryIndex) => entryIndex !== index))}
                >
                  <XIcon />
                </Button>
              </li>
            );
          })}
        </ol>
      ) : null}
    </SettingsRow>
  );
}
