import { useAtomValue } from "@effect/atom-react";
import { CalendarClockIcon, ClockIcon } from "lucide-react";
import type { EnvironmentId } from "@t3tools/contracts";
import { useState } from "react";
import { resolveSnoozeQuery } from "@t3tools/client-runtime/state/thread-settled";

import { useClientSettings } from "../hooks/useSettings";
import { primaryServerKeybindingsAtom } from "../state/server";
import { formatShortTimestamp } from "../timestampFormat";
import { ITEM_ICON_CLASS, type CommandPaletteActionItem } from "./CommandPalette.logic";
import { CommandPaletteContent } from "./CommandPaletteContent";
import { CommandPaletteResults } from "./CommandPaletteResults";
import { requestCustomSnooze } from "./CustomSnoozeDialog";
import { resolveSnoozePresets } from "./Sidebar.snooze";
import { CommandDialog, CommandDialogPopup } from "./ui/command";

export type SnoozeChoice = { readonly snoozedUntil: string };

/**
 * Keyboard-first snooze menu: type to filter the wake-time presets, or a
 * duration such as "5d" to offer it first, Enter to pick. "Custom…" always
 * stays last so a query that matches nothing still has a way forward. Marked
 * as a palette so global shortcuts stand down while it owns the keyboard.
 */
export function ThreadSnoozePicker(props: {
  readonly environmentId: EnvironmentId;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onSelect: (choice: SnoozeChoice) => void;
}) {
  return (
    <CommandDialog open={props.open} onOpenChange={props.onOpenChange}>
      {props.open ? (
        <CommandDialogPopup
          aria-label="Snooze thread"
          className="overflow-hidden"
          data-command-palette="true"
          onBackdropPointerDown={() => props.onOpenChange(false)}
        >
          <SnoozePickerContent
            environmentId={props.environmentId}
            onOpenChange={props.onOpenChange}
            onSelect={props.onSelect}
          />
        </CommandDialogPopup>
      ) : null}
    </CommandDialog>
  );
}

// Resolved at selection so a typed duration starts then, not when the picker opened.
function snoozeFromSelection(query: string, onSelect: (choice: SnoozeChoice) => void) {
  const wake = resolveSnoozeQuery(query, new Date());
  if (wake) onSelect({ snoozedUntil: wake.snoozedUntil });
}

function SnoozePickerContent(props: {
  readonly environmentId: EnvironmentId;
  readonly onOpenChange: (open: boolean) => void;
  readonly onSelect: (choice: SnoozeChoice) => void;
}) {
  const { onSelect } = props;
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const timestampFormat = useClientSettings((settings) => settings.timestampFormat);
  const [query, setQuery] = useState("");
  const [highlightedItemValue, setHighlightedItemValue] = useState<string | null>(null);
  const [openedAt] = useState(() => new Date());
  // Resolved once per open so a picker left idle does not offer stale wake times.
  const [presets] = useState(() =>
    resolveSnoozePresets(openedAt, timestampFormat, props.environmentId),
  );

  const needle = query.trim().toLowerCase();
  const typed = resolveSnoozeQuery(needle, openedAt, (date) =>
    formatShortTimestamp(date.toISOString(), timestampFormat),
  );
  const typedItems: CommandPaletteActionItem[] = typed
    ? [
        {
          kind: "action",
          value: "snooze:typed",
          searchTerms: [needle],
          title: typed.label,
          timestamp: typed.whenLabel,
          icon: <ClockIcon className={ITEM_ICON_CLASS} />,
          run: async () => snoozeFromSelection(needle, onSelect),
        },
      ]
    : [];
  const presetItems = presets
    .map<CommandPaletteActionItem>((preset) => ({
      kind: "action",
      value: `snooze:${preset.id}`,
      searchTerms: [preset.label, preset.whenLabel],
      title: preset.label,
      timestamp: preset.whenLabel,
      icon: <ClockIcon className={ITEM_ICON_CLASS} />,
      run: async () => onSelect({ snoozedUntil: preset.snoozedUntil }),
    }))
    .filter(
      (item) =>
        needle === "" || item.searchTerms.some((term) => term.toLowerCase().includes(needle)),
    );
  const items: CommandPaletteActionItem[] = [
    ...typedItems,
    ...presetItems,
    {
      kind: "action",
      value: "snooze:custom",
      searchTerms: ["custom"],
      title: "Custom…",
      icon: <CalendarClockIcon className={ITEM_ICON_CLASS} />,
      run: async () => {
        const choice = await requestCustomSnooze();
        if (choice) onSelect(choice);
      },
    },
  ];

  return (
    <CommandPaletteContent
      aria-label="Snooze thread"
      autoHighlight="always"
      escapeLabel="Close"
      footerActionLabel="Snooze"
      inputProps={{ placeholder: "Snooze until… or type 2h, 3d" }}
      mode="none"
      onItemHighlighted={(value) => {
        setHighlightedItemValue(typeof value === "string" ? value : null);
      }}
      onValueChange={(value) => {
        setHighlightedItemValue(null);
        setQuery(value);
      }}
      testId="thread-snooze-picker"
      value={query}
    >
      <CommandPaletteResults
        groups={[{ value: "snooze-options", label: "", items }]}
        highlightedItemValue={highlightedItemValue}
        isActionsOnly={false}
        keybindings={keybindings}
        onExecuteItem={(item) => {
          if (item.kind !== "action") return;
          props.onOpenChange(false);
          void item.run();
        }}
      />
    </CommandPaletteContent>
  );
}
