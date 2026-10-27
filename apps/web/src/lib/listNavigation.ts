import { resolveEventKeys } from "@t3tools/shared/keybindings";

export type ListNavigationDirection = "next" | "previous";

/**
 * Where ctrl/cmd+N and ctrl/cmd+P step through a list. Base UI menus, selects
 * and comboboxes are matched by role; the command palette and anything else
 * can opt in with `data-list-navigation` on an ancestor of the focused element.
 */
const LIST_SCOPE_SELECTOR = [
  '[role="menu"]',
  '[role="listbox"]',
  '[role="combobox"][aria-expanded="true"]',
  "[data-command-palette]",
  "[data-list-navigation]",
].join(",");

export function listNavigationDirection(event: KeyboardEvent): ListNavigationDirection | null {
  if (event.altKey || event.shiftKey || event.metaKey === event.ctrlKey) return null;
  const keys = resolveEventKeys(event);
  if (keys.has("n")) return "next";
  if (keys.has("p")) return "previous";
  return null;
}

/**
 * Replays ctrl/cmd+N and ctrl/cmd+P as ArrowDown/ArrowUp on the focused element, claiming the
 * chord only when the arrow is handled, so New Thread, the file picker, and caret movement work
 * elsewhere. Install once, before any other keydown listener: it stops the original event so
 * global shortcuts sharing these chords do not also fire.
 */
export function installListNavigationKeys(): () => void {
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.defaultPrevented || event.isComposing || event.keyCode === 229) return;
    const direction = listNavigationDirection(event);
    if (direction === null) return;
    const target = event.target;
    if (!(target instanceof Element) || target.closest(LIST_SCOPE_SELECTOR) === null) return;

    const key = direction === "next" ? "ArrowDown" : "ArrowUp";
    const arrow = new KeyboardEvent("keydown", {
      key,
      code: key,
      repeat: event.repeat,
      bubbles: true,
      cancelable: true,
      composed: true,
    });
    if (target.dispatchEvent(arrow)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
  };
  window.addEventListener("keydown", onKeyDown, true);
  return () => window.removeEventListener("keydown", onKeyDown, true);
}
