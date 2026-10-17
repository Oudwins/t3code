import type {
  EnvironmentId,
  EnvironmentMachineKind,
  PullRequestLinkedThreadsResult,
} from "@t3tools/contracts";

export interface CommandPaletteLinkedThreads {
  readonly environmentId: EnvironmentId;
  readonly threads: PullRequestLinkedThreadsResult["threads"];
}

const COMMAND_PALETTE_OPEN_EVENT = "t3code:open-command-palette";

/** One row of the workspace picker; the composer that opens it owns what selecting does. */
export interface WorkspacePaletteOption {
  readonly id: "local" | "worktree" | "previous-worktree";
  readonly label: string;
  readonly description: string | null;
  readonly icon: "checkout" | "worktree" | "new-worktree" | "previous-worktree";
  readonly selected: boolean;
  readonly select: () => void;
}

/** One row of the machine picker; the composer that opens it owns what selecting does. */
export interface MachinePaletteOption {
  readonly id: EnvironmentId | "auto";
  readonly label: string;
  readonly description: string | null;
  /** Null for the auto-balance row. */
  readonly machine: EnvironmentMachineKind | null;
  readonly selected: boolean;
  readonly select: () => void;
}

export interface CommandPaletteOpenDetail {
  readonly open?: "add-project" | "new-thread-in";
  readonly query?: string;
  readonly linkedThreads?: CommandPaletteLinkedThreads;
  readonly workspace?: ReadonlyArray<WorkspacePaletteOption>;
  readonly machine?: ReadonlyArray<MachinePaletteOption>;
}

export function openCommandPalette(detail?: CommandPaletteOpenDetail): void {
  window.dispatchEvent(
    new CustomEvent(COMMAND_PALETTE_OPEN_EVENT, detail ? { detail } : undefined),
  );
}

export function onOpenCommandPalette(
  listener: (detail: CommandPaletteOpenDetail) => void,
): () => void {
  const handler = (event: Event) => {
    listener((event as CustomEvent<CommandPaletteOpenDetail>).detail ?? {});
  };
  window.addEventListener(COMMAND_PALETTE_OPEN_EVENT, handler);
  return () => window.removeEventListener(COMMAND_PALETTE_OPEN_EVENT, handler);
}

export function isCommandPaletteOpen(): boolean {
  return (
    typeof document !== "undefined" && document.querySelector("[data-command-palette]") !== null
  );
}
