import type { NewThreadTab } from "@t3tools/contracts";
import { nextTerminalId } from "@t3tools/shared/terminalLabels";

/**
 * Opens a new thread's configured tabs one after another so they land in the configured order,
 * even though a browser tab only exists once its session has been created. Every terminal gets
 * its own id: the ids in use are tracked here because the caller's list is a render-time snapshot.
 */
export async function seedThreadTabs(input: {
  entries: readonly NewThreadTab[];
  usedTerminalIds: readonly string[];
  open: {
    terminal: (terminalId: string) => void;
    files: () => void;
    diff: () => void;
    /** Null where a browser cannot run, so the entry is skipped. */
    browser: (() => Promise<void>) | null;
  };
  /** Runs after each tab lands; seeding must not leave a tab covering the conversation. */
  settle: () => void;
}): Promise<void> {
  const usedTerminalIds = [...input.usedTerminalIds];
  for (const entry of input.entries) {
    switch (entry) {
      case "terminal": {
        const terminalId = nextTerminalId(usedTerminalIds);
        usedTerminalIds.push(terminalId);
        input.open.terminal(terminalId);
        break;
      }
      case "files":
        input.open.files();
        break;
      case "diff":
        input.open.diff();
        break;
      case "browser":
        await input.open.browser?.();
        break;
    }
    input.settle();
  }
}
