import {
  type KeybindingCommand,
  type KeybindingShortcut,
  type KeybindingWhenNode,
  MODEL_PICKER_JUMP_KEYBINDING_COMMANDS,
  type ResolvedKeybindingRule,
  type ResolvedKeybindingsConfig,
  THREAD_JUMP_KEYBINDING_COMMANDS,
  type ModelPickerJumpKeybindingCommand,
  type ThreadJumpKeybindingCommand,
} from "@t3tools/contracts";
import { isElectron } from "./env";
import { isEditableFocused } from "./lib/editableFocus";
import { isPreviewFocused } from "./lib/previewFocus";
import { isTerminalFocused } from "./lib/terminalFocus";
import { isMacPlatform } from "./lib/utils";

export interface ShortcutEventLike {
  getModifierState?: (key: "AltGraph") => boolean;
  type?: string;
  code?: string;
  key: string;
  repeat?: boolean;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  target?: EventTarget | null;
  preventDefault?: () => void;
  stopPropagation?: () => void;
}

export interface ShortcutModifierStateLike {
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}

export interface ShortcutMatchContext {
  terminalFocus: boolean;
  terminalOpen: boolean;
  previewFocus: boolean;
  previewOpen: boolean;
  isWeb: boolean;
  isDesktop: boolean;
  /** A text field, textarea, select or rich-text editor owns the keyboard.
      Optional: only chords that collide with native editing consult it. */
  editableFocus?: boolean;
  [key: string]: boolean;
}

interface ShortcutMatchOptions {
  platform?: string;
  context?: Partial<ShortcutMatchContext>;
}

interface ResolvedShortcutLabelOptions extends ShortcutMatchOptions {
  platform?: string;
}

const TERMINAL_WORD_BACKWARD = "\u001bb";
const TERMINAL_WORD_FORWARD = "\u001bf";
const TERMINAL_LINE_START = "\u0001";
const TERMINAL_LINE_END = "\u0005";
const TERMINAL_DELETE_TO_LINE_START = "\u0015";
const EVENT_CODE_SHORTCUT_KEYS: Readonly<Record<string, string>> = {
  Backquote: "`",
  Backslash: "\\",
  BracketLeft: "[",
  BracketRight: "]",
  Comma: ",",
  Digit0: "0",
  Digit1: "1",
  Digit2: "2",
  Digit3: "3",
  Digit4: "4",
  Digit5: "5",
  Digit6: "6",
  Digit7: "7",
  Digit8: "8",
  Digit9: "9",
  Equal: "=",
  Minus: "-",
  Period: ".",
  Quote: "'",
  Semicolon: ";",
  Slash: "/",
};

function normalizeEventKey(key: string): string {
  const normalized = key.toLowerCase();
  if (normalized === "esc") return "escape";
  return normalized;
}

export function shortcutKeyFromEvent(event: Pick<ShortcutEventLike, "key" | "code">): string {
  const layoutKey = normalizeEventKey(event.key);
  if (/^[a-z]$/.test(layoutKey)) return layoutKey;
  const physicalKey = event.code ? EVENT_CODE_SHORTCUT_KEYS[event.code] : undefined;
  return physicalKey ?? layoutKey;
}

export function resolveEventKeys(event: ShortcutEventLike): Set<string> {
  const layoutKey = normalizeEventKey(event.key);
  const keys = new Set([layoutKey]);
  // The physical-position fallback exists for layouts that type non-Latin
  // letters (Cyrillic, Greek) and for Option-modified symbols on macOS.
  // When the layout already produces a Latin letter, match on it alone;
  // otherwise a remapped physical key triggers shortcuts for two different
  // letters at once and shadows system shortcuts on non-QWERTY layouts.
  const letterCode = event.code?.match(/^Key([A-Z])$/)?.[1];
  if (letterCode && !/^[a-z]$/.test(layoutKey)) {
    keys.add(letterCode.toLowerCase());
  }
  keys.add(shortcutKeyFromEvent(event));
  return keys;
}

function matchesShortcutModifiers(
  event: ShortcutModifierStateLike,
  shortcut: KeybindingShortcut,
  platform = navigator.platform,
): boolean {
  const useMetaForMod = isMacPlatform(platform);
  const expectedMeta = shortcut.metaKey || (shortcut.modKey && useMetaForMod);
  const expectedCtrl = shortcut.ctrlKey || (shortcut.modKey && !useMetaForMod);
  return (
    event.metaKey === expectedMeta &&
    event.ctrlKey === expectedCtrl &&
    event.shiftKey === shortcut.shiftKey &&
    event.altKey === shortcut.altKey
  );
}

function matchesShortcut(
  event: ShortcutEventLike,
  shortcut: KeybindingShortcut,
  platform = navigator.platform,
): boolean {
  if (
    !isMacPlatform(platform) &&
    event.getModifierState?.("AltGraph") &&
    !/^[a-z0-9]$/i.test(event.key)
  )
    return false;
  if (!matchesShortcutModifiers(event, shortcut, platform)) return false;
  return resolveEventKeys(event).has(shortcut.key);
}

function resolvePlatform(options: ShortcutMatchOptions | undefined): string {
  return options?.platform ?? navigator.platform;
}

function resolveContext(options: ShortcutMatchOptions | undefined): ShortcutMatchContext {
  return {
    terminalFocus: false,
    terminalOpen: false,
    previewFocus: false,
    previewOpen: false,
    isWeb: !isElectron,
    isDesktop: isElectron,
    editableFocus: false,
    ...options?.context,
  };
}

function evaluateWhenNode(node: KeybindingWhenNode, context: ShortcutMatchContext): boolean {
  switch (node.type) {
    case "identifier":
      if (node.name === "true") return true;
      if (node.name === "false") return false;
      return Boolean(context[node.name]);
    case "not":
      return !evaluateWhenNode(node.node, context);
    case "and":
      return evaluateWhenNode(node.left, context) && evaluateWhenNode(node.right, context);
    case "or":
      return evaluateWhenNode(node.left, context) || evaluateWhenNode(node.right, context);
  }
}

function matchesWhenClause(
  whenAst: KeybindingWhenNode | undefined,
  context: ShortcutMatchContext,
): boolean {
  if (!whenAst) return true;
  return evaluateWhenNode(whenAst, context);
}

export function shortcutConflictKey(
  shortcut: KeybindingShortcut,
  platform = navigator.platform,
): string {
  const useMetaForMod = isMacPlatform(platform);
  const metaKey = shortcut.metaKey || (shortcut.modKey && useMetaForMod);
  const ctrlKey = shortcut.ctrlKey || (shortcut.modKey && !useMetaForMod);
  return [
    shortcut.key,
    metaKey ? "meta" : "",
    ctrlKey ? "ctrl" : "",
    shortcut.shiftKey ? "shift" : "",
    shortcut.altKey ? "alt" : "",
  ].join("|");
}

function chordConflictKey(
  chord: readonly [KeybindingShortcut, KeybindingShortcut],
  platform: string,
): string {
  return `${shortcutConflictKey(chord[0], platform)} ${shortcutConflictKey(chord[1], platform)}`;
}

/**
 * The binding that actually owns `command`'s shortcut: later rules shadow
 * earlier ones that share a shortcut. A chord's leader press and a plain
 * shortcut on the same key shadow each other the same way, because
 * `resolveShortcutCommand` lets the later rule win.
 */
function findEffectiveBindingForCommand(
  keybindings: ResolvedKeybindingsConfig,
  command: KeybindingCommand,
  options?: ShortcutMatchOptions,
): ResolvedKeybindingRule | null {
  const platform = resolvePlatform(options);
  const context = resolveContext(options);
  const claimed = new Set<string>();

  for (let index = keybindings.length - 1; index >= 0; index -= 1) {
    const binding = keybindings[index];
    if (!binding) continue;
    if (!matchesWhenClause(binding.whenAst, context)) continue;

    if ("shortcut" in binding) {
      const key = shortcutConflictKey(binding.shortcut, platform);
      if (claimed.has(`s|${key}`) || claimed.has(`l|${key}`)) continue;
      claimed.add(`s|${key}`);
    } else {
      const leaderKey = shortcutConflictKey(binding.chord[0], platform);
      const chordKey = chordConflictKey(binding.chord, platform);
      if (claimed.has(`c|${chordKey}`) || claimed.has(`s|${leaderKey}`)) continue;
      claimed.add(`c|${chordKey}`);
      claimed.add(`l|${leaderKey}`);
    }
    if (binding.command === command) {
      return binding;
    }
  }

  return null;
}

function matchesCommandShortcut(
  event: ShortcutEventLike,
  keybindings: ResolvedKeybindingsConfig,
  command: KeybindingCommand,
  options?: ShortcutMatchOptions,
): boolean {
  return resolveShortcutCommand(event, keybindings, options) === command;
}

// A chord is two keydowns, but every window-level listener resolves each
// event on its own with its own `when` context. The leader press records the
// pending chord here. The first listener to see the next key snapshots it
// onto the event and clears the live state, so the remaining listeners still
// resolve that same key as the chord's second step.
const CHORD_TIMEOUT_MS = 1500;

interface PendingChord {
  readonly leaderKey: string;
  readonly label: string;
}

let pendingChord: PendingChord | null = null;
let pendingChordTimer: ReturnType<typeof setTimeout> | null = null;
const pendingChordListeners = new Set<() => void>();
const pendingChordAtArrival = new WeakMap<object, PendingChord | null>();

function setPendingChord(next: PendingChord | null): void {
  const labelChanged = pendingChord?.label !== next?.label;
  pendingChord = next;
  if (pendingChordTimer !== null) clearTimeout(pendingChordTimer);
  pendingChordTimer = next === null ? null : setTimeout(cancelPendingChord, CHORD_TIMEOUT_MS);
  if (labelChanged) for (const listener of pendingChordListeners) listener();
}

export function cancelPendingChord(): void {
  setPendingChord(null);
}

/** Label of the leader shortcut while a chord waits for its second key, else null. */
export function getPendingChordLabel(): string | null {
  return pendingChord?.label ?? null;
}

export function subscribePendingChord(listener: () => void): () => void {
  pendingChordListeners.add(listener);
  return () => pendingChordListeners.delete(listener);
}

// The Settings recorder reads raw keypresses, so chords must not react to them.
function isKeybindingCaptureTarget(event: ShortcutEventLike): boolean {
  const target = event.target as { closest?: (selector: string) => unknown } | null | undefined;
  return (
    typeof target?.closest === "function" && target.closest("[data-keybinding-capture]") !== null
  );
}

// Listeners pass only the context they know, so a chord's `when` is judged again
// here with the focus state every listener can read from the document. The
// terminal owns the keyboard and cannot be told to hold a key back, so a chord
// never starts there; plain shortcuts on the leader key still apply.
function chordStartContext(
  event: ShortcutEventLike,
  context: ShortcutMatchContext,
  explicit: Partial<ShortcutMatchContext> | undefined,
): ShortcutMatchContext | null {
  if (context.terminalFocus || isKeybindingCaptureTarget(event)) return null;
  const hasDocument = typeof document !== "undefined";
  if (hasDocument && isTerminalFocused()) return null;
  return {
    ...context,
    editableFocus:
      explicit?.editableFocus ??
      (hasDocument && typeof Element !== "undefined" && isEditableFocused(event.target ?? null)),
    previewFocus: explicit?.previewFocus ?? (hasDocument && isPreviewFocused()),
  };
}

const MODIFIER_ONLY_KEYS: ReadonlySet<string> = new Set([
  "Shift",
  "Control",
  "Alt",
  "AltGraph",
  "Meta",
  "CapsLock",
]);

function isModifierOnlyKey(key: string): boolean {
  return MODIFIER_ONLY_KEYS.has(key);
}

function isKeydownLike(event: ShortcutEventLike): boolean {
  return event.type === undefined || event.type === "keydown";
}

function pendingChordForEvent(
  event: ShortcutEventLike,
  keybindings: ResolvedKeybindingsConfig,
  platform: string,
): PendingChord | null {
  // React handlers receive a wrapper; key on the native event the other listeners share.
  const eventKey: object = (event as { nativeEvent?: object }).nativeEvent ?? event;
  if (pendingChordAtArrival.has(eventKey)) return pendingChordAtArrival.get(eventKey) ?? null;

  // Most keys arrive with no chord pending; skip the DOM checks for those.
  const counts =
    pendingChord !== null &&
    isKeydownLike(event) &&
    !event.repeat &&
    !isModifierOnlyKey(event.key) &&
    !isKeybindingCaptureTarget(event);
  const pending = counts ? pendingChord : null;
  pendingChordAtArrival.set(eventKey, pending);
  if (pending === null) return null;

  cancelPendingChord();
  // A key no chord of this leader can take, in any context, is swallowed so
  // it neither types into a field nor fires something the user never meant.
  const expected = keybindings.some(
    (binding) =>
      "chord" in binding &&
      shortcutConflictKey(binding.chord[0], platform) === pending.leaderKey &&
      matchesShortcut(event, binding.chord[1], platform),
  );
  if (!expected) {
    event.preventDefault?.();
    event.stopPropagation?.();
  }
  return pending;
}

function beginChord(event: ShortcutEventLike, leader: KeybindingShortcut, platform: string): void {
  if (!isKeydownLike(event)) return;
  event.preventDefault?.();
  event.stopPropagation?.();
  const leaderKey = shortcutConflictKey(leader, platform);
  if (pendingChord?.leaderKey === leaderKey) return;
  setPendingChord({ leaderKey, label: formatShortcutLabel(leader, platform) });
}

/**
 * Whether this key is the second step of a pending chord. Handlers that react
 * to raw keys (type-to-focus, Enter to send) must leave such a key alone.
 */
export function isChordFollowUp(
  event: ShortcutEventLike,
  keybindings: ResolvedKeybindingsConfig,
  options?: ShortcutMatchOptions,
): boolean {
  return pendingChordForEvent(event, keybindings, resolvePlatform(options)) !== null;
}

export function resolveShortcutCommand(
  event: ShortcutEventLike,
  keybindings: ResolvedKeybindingsConfig,
  options?: ShortcutMatchOptions,
): KeybindingCommand | null {
  const platform = resolvePlatform(options);
  const context = resolveContext(options);
  const pending = pendingChordForEvent(event, keybindings, platform);

  for (let index = keybindings.length - 1; index >= 0; index -= 1) {
    const binding = keybindings[index];
    if (!binding) continue;
    if (!matchesWhenClause(binding.whenAst, context)) continue;

    if ("chord" in binding) {
      const [leader, next] = binding.chord;
      if (pending) {
        if (shortcutConflictKey(leader, platform) !== pending.leaderKey) continue;
        if (!matchesShortcut(event, next, platform)) continue;
        return binding.command;
      }
      if (!matchesShortcut(event, leader, platform)) continue;
      const startContext = chordStartContext(event, context, options?.context);
      if (!startContext || !matchesWhenClause(binding.whenAst, startContext)) continue;
      beginChord(event, leader, platform);
      return null;
    }

    if (pending) continue;
    if (!matchesShortcut(event, binding.shortcut, platform)) continue;
    return binding.command;
  }
  return null;
}

export function formatShortcutKeyLabel(key: string): string {
  if (key === " ") return "Space";
  if (key.length === 1) return key.toUpperCase();
  if (key === "escape") return "Esc";
  if (key === "arrowup") return "Up";
  if (key === "arrowdown") return "Down";
  if (key === "arrowleft") return "Left";
  if (key === "arrowright") return "Right";
  return key.slice(0, 1).toUpperCase() + key.slice(1);
}

export function formatShortcutLabel(
  shortcut: KeybindingShortcut,
  platform = navigator.platform,
): string {
  const keyLabel = formatShortcutKeyLabel(shortcut.key);
  const useMetaForMod = isMacPlatform(platform);
  const showMeta = shortcut.metaKey || (shortcut.modKey && useMetaForMod);
  const showCtrl = shortcut.ctrlKey || (shortcut.modKey && !useMetaForMod);
  const showAlt = shortcut.altKey;
  const showShift = shortcut.shiftKey;

  if (useMetaForMod) {
    return `${showCtrl ? "\u2303" : ""}${showAlt ? "\u2325" : ""}${showShift ? "\u21e7" : ""}${showMeta ? "\u2318" : ""}${keyLabel}`;
  }

  const parts: string[] = [];
  if (showCtrl) parts.push("Ctrl");
  if (showAlt) parts.push("Alt");
  if (showShift) parts.push("Shift");
  if (showMeta) parts.push("Meta");
  parts.push(keyLabel);
  return parts.join("+");
}

/** `⌘G X` for a chord, `⌘K` for a plain shortcut. */
export function formatBindingLabel(
  binding: ResolvedKeybindingRule,
  platform = navigator.platform,
): string {
  if ("shortcut" in binding) return formatShortcutLabel(binding.shortcut, platform);
  return binding.chord.map((step) => formatShortcutLabel(step, platform)).join(" ");
}

export function shortcutLabelForCommand(
  keybindings: ResolvedKeybindingsConfig,
  command: KeybindingCommand | null,
  options?: string | ResolvedShortcutLabelOptions,
): string | null {
  if (command === null) return null;
  const resolvedOptions =
    typeof options === "string"
      ? ({ platform: options } satisfies ResolvedShortcutLabelOptions)
      : options;
  const platform = resolvePlatform(resolvedOptions);
  const binding = findEffectiveBindingForCommand(keybindings, command, resolvedOptions);
  return binding ? formatBindingLabel(binding, platform) : null;
}

export function threadJumpCommandForIndex(index: number): ThreadJumpKeybindingCommand | null {
  return THREAD_JUMP_KEYBINDING_COMMANDS[index] ?? null;
}

export function threadJumpIndexFromCommand(command: string): number | null {
  const index = THREAD_JUMP_KEYBINDING_COMMANDS.indexOf(command as ThreadJumpKeybindingCommand);
  return index === -1 ? null : index;
}

export function threadTraversalDirectionFromCommand(
  command: string | null,
): "previous" | "next" | null {
  if (command === "thread.previous") return "previous";
  if (command === "thread.next") return "next";
  return null;
}

export function threadAttentionTraversalDirectionFromCommand(
  command: string | null,
): "previous" | "next" | null {
  if (command === "thread.previousAttention") return "previous";
  if (command === "thread.nextAttention") return "next";
  return null;
}

export function shouldShowThreadJumpHintsForModifiers(
  modifiers: ShortcutModifierStateLike,
  keybindings: ResolvedKeybindingsConfig,
  options?: ShortcutMatchOptions,
): boolean {
  // The embedded terminal owns keystrokes while it has focus: the Ghostty
  // surface encodes the keydown and can write the pressed key into the shell
  // before our window-level shortcut handling ever runs, regardless of any
  // configured `when` clause on the jump command. Advertising jump hints
  // here would promise a shortcut that instead types into the terminal, so
  // never show them while the terminal is focused.
  if (resolveContext(options).terminalFocus) {
    return false;
  }

  const platform = resolvePlatform(options);

  for (const command of THREAD_JUMP_KEYBINDING_COMMANDS) {
    const binding = findEffectiveBindingForCommand(keybindings, command, options);
    if (!binding || !("shortcut" in binding)) continue;
    if (matchesShortcutModifiers(modifiers, binding.shortcut, platform)) {
      return true;
    }
  }

  return false;
}

export function modelPickerJumpCommandForIndex(
  index: number,
): ModelPickerJumpKeybindingCommand | null {
  return MODEL_PICKER_JUMP_KEYBINDING_COMMANDS[index] ?? null;
}

export function modelPickerJumpIndexFromCommand(command: string): number | null {
  const index = MODEL_PICKER_JUMP_KEYBINDING_COMMANDS.indexOf(
    command as ModelPickerJumpKeybindingCommand,
  );
  return index === -1 ? null : index;
}

export function isTerminalToggleShortcut(
  event: ShortcutEventLike,
  keybindings: ResolvedKeybindingsConfig,
  options?: ShortcutMatchOptions,
): boolean {
  return matchesCommandShortcut(event, keybindings, "terminal.toggle", options);
}

export function isTerminalSplitShortcut(
  event: ShortcutEventLike,
  keybindings: ResolvedKeybindingsConfig,
  options?: ShortcutMatchOptions,
): boolean {
  return matchesCommandShortcut(event, keybindings, "terminal.split", options);
}

export function isTerminalSplitVerticalShortcut(
  event: ShortcutEventLike,
  keybindings: ResolvedKeybindingsConfig,
  options?: ShortcutMatchOptions,
): boolean {
  return matchesCommandShortcut(event, keybindings, "terminal.splitVertical", options);
}

export function isTerminalNewShortcut(
  event: ShortcutEventLike,
  keybindings: ResolvedKeybindingsConfig,
  options?: ShortcutMatchOptions,
): boolean {
  return matchesCommandShortcut(event, keybindings, "terminal.new", options);
}

export function isTerminalCloseShortcut(
  event: ShortcutEventLike,
  keybindings: ResolvedKeybindingsConfig,
  options?: ShortcutMatchOptions,
): boolean {
  return matchesCommandShortcut(event, keybindings, "terminal.close", options);
}

export function isDiffToggleShortcut(
  event: ShortcutEventLike,
  keybindings: ResolvedKeybindingsConfig,
  options?: ShortcutMatchOptions,
): boolean {
  return matchesCommandShortcut(event, keybindings, "diff.toggle", options);
}

export function isOpenFavoriteEditorShortcut(
  event: ShortcutEventLike,
  keybindings: ResolvedKeybindingsConfig,
  options?: ShortcutMatchOptions,
): boolean {
  return (
    event.repeat !== true &&
    matchesCommandShortcut(event, keybindings, "editor.openFavorite", options)
  );
}

/**
 * Whether the keypress is the rich-text bold chord (Mod+B without extra
 * modifiers). Tiptap binds the same chord, so app shortcuts captured ahead
 * of the editor must yield when the rich-text composer is focused.
 */
export function isRichTextBoldShortcut(event: ShortcutEventLike): boolean {
  if (event.type !== undefined && event.type !== "keydown") {
    return false;
  }
  return (
    resolveEventKeys(event).has("b") &&
    (event.metaKey || event.ctrlKey) &&
    !event.altKey &&
    !event.shiftKey
  );
}

export function isTerminalClearShortcut(
  event: ShortcutEventLike,
  platform = navigator.platform,
): boolean {
  if (event.type !== undefined && event.type !== "keydown") {
    return false;
  }

  const key = event.key.toLowerCase();

  if (key === "l" && event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey) {
    return true;
  }

  return (
    isMacPlatform(platform) &&
    key === "k" &&
    event.metaKey &&
    !event.ctrlKey &&
    !event.altKey &&
    !event.shiftKey
  );
}

export function terminalDeleteShortcutData(
  event: ShortcutEventLike,
  platform = navigator.platform,
): string | null {
  if (event.type !== undefined && event.type !== "keydown") {
    return null;
  }

  if (!isMacPlatform(platform)) {
    return null;
  }

  const key = normalizeEventKey(event.key);
  if (key !== "backspace") {
    return null;
  }

  return event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey
    ? TERMINAL_DELETE_TO_LINE_START
    : null;
}

export function terminalNavigationShortcutData(
  event: ShortcutEventLike,
  platform = navigator.platform,
): string | null {
  if (event.type !== undefined && event.type !== "keydown") {
    return null;
  }

  if (event.shiftKey) return null;

  const key = normalizeEventKey(event.key);
  if (key !== "arrowleft" && key !== "arrowright") {
    return null;
  }

  const moveWord = key === "arrowleft" ? TERMINAL_WORD_BACKWARD : TERMINAL_WORD_FORWARD;
  const moveLine = key === "arrowleft" ? TERMINAL_LINE_START : TERMINAL_LINE_END;

  if (isMacPlatform(platform)) {
    if (event.altKey && !event.metaKey && !event.ctrlKey) {
      return moveWord;
    }
    if (event.metaKey && !event.altKey && !event.ctrlKey) {
      return moveLine;
    }
    return null;
  }

  if (event.ctrlKey && !event.metaKey && !event.altKey) {
    return moveWord;
  }

  if (event.altKey && !event.metaKey && !event.ctrlKey) {
    return moveWord;
  }

  return null;
}
