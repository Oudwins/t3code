// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vite-plus/test";

import { Command, CommandInput, CommandItem, CommandList } from "../components/ui/command";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../components/ui/menu";
import { installListNavigationKeys, listNavigationDirection } from "./listNavigation";

const chord = (init: KeyboardEventInit) =>
  new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });

describe("listNavigationDirection", () => {
  it.each([
    [{ key: "n", ctrlKey: true }, "next"],
    [{ key: "n", metaKey: true }, "next"],
    [{ key: "N", ctrlKey: true }, "next"],
    [{ key: "p", ctrlKey: true }, "previous"],
    [{ key: "p", metaKey: true }, "previous"],
    [{ key: "т", code: "KeyN", ctrlKey: true }, "next"],
    [{ key: "з", code: "KeyP", metaKey: true }, "previous"],
  ] as const)("maps %j to %s", (init, expected) => {
    expect(listNavigationDirection(chord(init))).toBe(expected);
  });

  it.each([
    { key: "n" },
    { key: "n", ctrlKey: true, shiftKey: true },
    { key: "n", ctrlKey: true, altKey: true },
    { key: "p", metaKey: true, shiftKey: true },
    { key: "n", ctrlKey: true, metaKey: true },
    { key: "j", ctrlKey: true },
    { key: "ArrowDown", ctrlKey: true },
  ])("ignores %j", (init) => {
    expect(listNavigationDirection(chord(init))).toBeNull();
  });
});

describe("installListNavigationKeys", () => {
  let uninstall: () => void;
  let container: HTMLDivElement;
  let arrows: string[];
  let laterListener: Mock<(event: KeyboardEvent) => void>;

  beforeEach(() => {
    uninstall = installListNavigationKeys();
    container = document.createElement("div");
    document.body.append(container);
    arrows = [];
    laterListener = vi.fn<(event: KeyboardEvent) => void>();
    window.addEventListener("keydown", laterListener, true);
  });

  afterEach(() => {
    window.removeEventListener("keydown", laterListener, true);
    uninstall();
    container.remove();
  });

  function mount(html: string, options: { consume: boolean }) {
    container.innerHTML = html;
    const input = container.querySelector("input")!;
    input.addEventListener("keydown", (event) => {
      if (!event.key.startsWith("Arrow")) return;
      arrows.push(event.key);
      if (options.consume) event.preventDefault();
    });
    input.focus();
    return input;
  }

  function press(target: HTMLElement, init: KeyboardEventInit) {
    const event = chord(init);
    target.dispatchEvent(event);
    return event;
  }

  it("replays ctrl+n and ctrl+p as arrows inside a list and claims the chord", () => {
    const input = mount('<div role="listbox"><input /></div>', { consume: true });

    const next = press(input, { key: "n", ctrlKey: true });
    const previous = press(input, { key: "p", metaKey: true });

    expect(arrows).toEqual(["ArrowDown", "ArrowUp"]);
    expect(next.defaultPrevented).toBe(true);
    expect(previous.defaultPrevented).toBe(true);
    // Only the replayed arrows reach later listeners, never the chords that
    // would open a new thread or the file picker.
    expect(laterListener.mock.calls.map(([event]) => event.key)).toEqual(["ArrowDown", "ArrowUp"]);
  });

  it.each([
    ["an expanded combobox", '<div role="combobox" aria-expanded="true"><input /></div>'],
    ["the command palette", '<div data-command-palette="true"><input /></div>'],
    ["an opted-in region", '<div data-list-navigation=""><input /></div>'],
  ])("treats %s as a list", (_name, html) => {
    const input = mount(html, { consume: true });
    press(input, { key: "n", ctrlKey: true });
    expect(arrows).toEqual(["ArrowDown"]);
  });

  it("leaves the chord alone outside a list", () => {
    const input = mount('<div role="combobox" aria-expanded="false"><input /></div>', {
      consume: true,
    });

    const event = press(input, { key: "n", metaKey: true });

    expect(arrows).toEqual([]);
    expect(event.defaultPrevented).toBe(false);
    expect(laterListener).toHaveBeenCalledTimes(1);
  });

  it("leaves the chord alone when the list does not handle the arrow", () => {
    const input = mount('<div role="listbox"><input /></div>', { consume: false });

    const event = press(input, { key: "p", metaKey: true });

    expect(arrows).toEqual(["ArrowUp"]);
    expect(event.defaultPrevented).toBe(false);
    expect(laterListener.mock.calls.map(([later]) => later.key)).toEqual(["ArrowUp", "p"]);
  });

  it("does not interfere with composition or already-handled chords", () => {
    const input = mount('<div role="listbox"><input /></div>', { consume: true });

    press(input, { key: "n", ctrlKey: true, isComposing: true });
    const handled = chord({ key: "n", ctrlKey: true });
    handled.preventDefault();
    input.dispatchEvent(handled);

    expect(arrows).toEqual([]);
  });
});

describe("with a Base UI menu", () => {
  let uninstall: () => void;
  let root: Root;
  let container: HTMLDivElement;

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    uninstall = installListNavigationKeys();
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    uninstall();
    container.remove();
    vi.unstubAllGlobals();
  });

  it("moves between items with ctrl+n and ctrl+p", async () => {
    await act(async () => {
      root.render(
        <Menu defaultOpen>
          <MenuTrigger>Open</MenuTrigger>
          <MenuPopup>
            <MenuItem>First</MenuItem>
            <MenuItem>Second</MenuItem>
            <MenuItem>Third</MenuItem>
          </MenuPopup>
        </Menu>,
      );
    });
    const items = () => [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')];
    expect(items()).toHaveLength(3);
    const popup = document.querySelector<HTMLElement>('[role="menu"]')!;
    await act(async () => popup.focus());
    const press = async (key: string) => {
      const event = chord({ key, ctrlKey: true });
      await act(async () => {
        (document.activeElement ?? popup).dispatchEvent(event);
      });
      return event;
    };

    const first = await press("n");
    expect(document.activeElement).toBe(items()[0]);
    await press("n");
    expect(document.activeElement).toBe(items()[1]);
    await press("p");
    expect(document.activeElement).toBe(items()[0]);
    expect(first.defaultPrevented).toBe(true);
  });
});

describe("with a Base UI command list", () => {
  let uninstall: () => void;
  let root: Root;
  let container: HTMLDivElement;

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    uninstall = installListNavigationKeys();
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    uninstall();
    container.remove();
    vi.unstubAllGlobals();
  });

  it("moves the highlight from the search input with ctrl+n and ctrl+p", async () => {
    const items = ["alpha", "beta", "gamma"];
    await act(async () => {
      root.render(
        <div data-command-palette="true">
          <Command items={items}>
            <CommandInput aria-label="Search" />
            <CommandList>
              {(item: string) => (
                <CommandItem key={item} value={item}>
                  {item}
                </CommandItem>
              )}
            </CommandList>
          </Command>
        </div>,
      );
    });
    const input = document.querySelector<HTMLInputElement>("input")!;
    const highlighted = () =>
      document.querySelector('[role="option"][data-highlighted]')?.textContent ?? null;
    expect(document.activeElement).toBe(input);
    expect(highlighted()).toBe("alpha");

    const press = async (key: string) => {
      const event = chord({ key, ctrlKey: true });
      await act(async () => {
        input.dispatchEvent(event);
      });
      return event;
    };

    const next = await press("n");
    expect(highlighted()).toBe("beta");
    await press("n");
    expect(highlighted()).toBe("gamma");
    await press("p");
    expect(highlighted()).toBe("beta");
    expect(next.defaultPrevented).toBe(true);
  });
});
