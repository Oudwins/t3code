import { useSyncExternalStore } from "react";

import { getPendingChordLabel, subscribePendingChord } from "../keybindings";
import { Kbd } from "./ui/kbd";

/** Shown between a chord's leader press and its follow-up key. */
export function PendingChordHint() {
  const leader = useSyncExternalStore(subscribePendingChord, getPendingChordLabel, () => null);
  if (leader === null) return null;
  return (
    <div
      role="status"
      className="pointer-events-none fixed inset-x-0 top-3 z-100 flex justify-center"
    >
      <div className="flex items-center gap-2 rounded-lg border bg-popover px-3 py-2 text-sm text-popover-foreground shadow-lg/5">
        <Kbd>{leader}</Kbd>
        <span className="text-muted-foreground">Press the next key, or Esc to cancel</span>
      </div>
    </div>
  );
}
