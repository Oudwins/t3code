import { afterEach, assert, beforeEach, describe, it, vi } from "vite-plus/test";
import {
  compileResolvedKeybindingsConfig,
  DEFAULT_RESOLVED_KEYBINDINGS,
  mergeWithDefaultKeybindings,
} from "@t3tools/shared/keybindings";

import {
  type KeybindingCommand,
  type KeybindingShortcut,
  type KeybindingWhenNode,
  type ResolvedKeybindingsConfig,
} from "@t3tools/contracts";
import {
  cancelPendingChord,
  effectiveShortcutsForCommand,
  formatShortcutLabel,
  getPendingChordLabel,
  isChordFollowUp,
  isRichTextBoldShortcut,
  isTerminalNewShortcut,
  isTerminalSplitShortcut,
  resolveChatShortcutCommand,
  resolveShortcutCommand,
  shouldShowThreadJumpHintsForModifiers,
  shortcutLabelForCommand,
  threadAttentionTraversalDirectionFromCommand,
  threadTabIndexFromCommand,
  threadTabShortcutIndex,
  type ShortcutEventLike,
  type ShortcutMatchContext,
} from "./keybindings";

function event(overrides: Partial<ShortcutEventLike> = {}): ShortcutEventLike {
  return {
    key: "j",
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    ...overrides,
  };
}

function modShortcut(
  key: string,
  overrides: Partial<Omit<KeybindingShortcut, "key">> = {},
): KeybindingShortcut {
  return {
    key,
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    modKey: true,
    ...overrides,
  };
}

function whenIdentifier(name: string): KeybindingWhenNode {
  return { type: "identifier", name };
}

function whenNot(node: KeybindingWhenNode): KeybindingWhenNode {
  return { type: "not", node };
}

function whenAnd(left: KeybindingWhenNode, right: KeybindingWhenNode): KeybindingWhenNode {
  return { type: "and", left, right };
}

interface TestBinding {
  shortcut: KeybindingShortcut;
  command: KeybindingCommand;
  whenAst?: KeybindingWhenNode;
}

function compile(bindings: TestBinding[]): ResolvedKeybindingsConfig {
  return bindings.map((binding) => ({
    command: binding.command,
    shortcut: binding.shortcut,
    ...(binding.whenAst ? { whenAst: binding.whenAst } : {}),
  }));
}

const DEFAULT_BINDINGS = compile([
  { shortcut: modShortcut("b"), command: "sidebar.toggle" },
  { shortcut: modShortcut("j"), command: "terminal.toggle" },
  { shortcut: modShortcut("b", { altKey: true }), command: "rightPanel.toggle" },
  {
    shortcut: modShortcut("d"),
    command: "terminal.split",
    whenAst: whenIdentifier("terminalFocus"),
  },
  {
    shortcut: modShortcut("d", { shiftKey: true }),
    command: "terminal.splitVertical",
    whenAst: whenIdentifier("terminalFocus"),
  },
  {
    shortcut: modShortcut("n"),
    command: "terminal.new",
    whenAst: whenIdentifier("terminalFocus"),
  },
  {
    shortcut: modShortcut("w"),
    command: "terminal.close",
    whenAst: whenIdentifier("terminalFocus"),
  },
  {
    shortcut: modShortcut("w"),
    command: "rightPanel.close",
    whenAst: whenNot(whenIdentifier("terminalFocus")),
  },
  {
    shortcut: modShortcut("d"),
    command: "diff.toggle",
    whenAst: whenNot(whenIdentifier("terminalFocus")),
  },
  {
    shortcut: modShortcut("k"),
    command: "commandPalette.toggle",
    whenAst: whenNot(whenIdentifier("terminalFocus")),
  },
  {
    shortcut: modShortcut("p"),
    command: "filePicker.toggle",
    whenAst: whenNot(whenIdentifier("terminalFocus")),
  },
  {
    shortcut: modShortcut("f", { shiftKey: true }),
    command: "projectSearch.toggle",
    whenAst: whenNot(whenIdentifier("terminalFocus")),
  },
  {
    shortcut: modShortcut("t", { altKey: true, shiftKey: true }),
    command: "themeEditor.toggle",
  },
  {
    shortcut: modShortcut("f"),
    command: "chat.find",
    whenAst: whenAnd(
      whenNot(whenIdentifier("terminalFocus")),
      whenNot(whenIdentifier("previewFocus")),
    ),
  },
  {
    shortcut: modShortcut("m", { shiftKey: true }),
    command: "modelPicker.toggle",
    whenAst: whenNot(whenIdentifier("terminalFocus")),
  },
  { shortcut: modShortcut("o", { shiftKey: true }), command: "chat.new" },
  { shortcut: modShortcut("n", { shiftKey: true }), command: "chat.newLocal" },
  { shortcut: modShortcut("o"), command: "editor.openFavorite" },
  { shortcut: modShortcut("[", { shiftKey: true }), command: "thread.previous" },
  { shortcut: modShortcut("]", { shiftKey: true }), command: "thread.next" },
  {
    shortcut: modShortcut("c", { shiftKey: true }),
    command: "thread.copyReference",
    whenAst: whenNot(whenIdentifier("terminalFocus")),
  },
  {
    shortcut: modShortcut("s", { shiftKey: true }),
    command: "thread.settle",
    whenAst: whenNot(whenIdentifier("terminalFocus")),
  },
  { shortcut: modShortcut("1", { shiftKey: true }), command: "thread.jump.1" },
  { shortcut: modShortcut("2", { shiftKey: true }), command: "thread.jump.2" },
  { shortcut: modShortcut("3", { shiftKey: true }), command: "thread.jump.3" },
  {
    shortcut: modShortcut("1"),
    command: "modelPicker.jump.1",
    whenAst: whenIdentifier("modelPickerOpen"),
  },
  {
    shortcut: modShortcut("2"),
    command: "modelPicker.jump.2",
    whenAst: whenIdentifier("modelPickerOpen"),
  },
  {
    shortcut: modShortcut("3"),
    command: "modelPicker.jump.3",
    whenAst: whenIdentifier("modelPickerOpen"),
  },
]);

describe("effectiveShortcutsForCommand", () => {
  it("passes only effective preview shortcuts to the desktop bridge", () => {
    const reopen = modShortcut("t", { shiftKey: true });
    const second = modShortcut("y", { shiftKey: true });
    const keybindings = compile([
      { shortcut: reopen, command: "view.reopenClosed" },
      {
        shortcut: second,
        command: "view.reopenClosed",
        whenAst: whenIdentifier("previewFocus"),
      },
      {
        shortcut: reopen,
        command: "preview.toggle",
        whenAst: whenIdentifier("previewFocus"),
      },
    ]);
    assert.deepEqual(
      effectiveShortcutsForCommand(keybindings, "view.reopenClosed", {
        platform: "MacIntel",
        context: { previewFocus: true, previewOpen: true },
      }),
      [second],
    );
    assert.deepEqual(
      effectiveShortcutsForCommand(keybindings, "view.reopenClosed", {
        platform: "MacIntel",
        context: { previewFocus: false },
      }),
      [reopen],
    );
  });
});

describe("settle thread shortcut", () => {
  it("does not intercept the terminal", () => {
    assert.isNull(
      resolveShortcutCommand(event({ key: "s", ctrlKey: true, shiftKey: true }), DEFAULT_BINDINGS, {
        platform: "Win32",
        context: { terminalFocus: true },
      }),
    );
  });
});

describe("thread undo shortcut", () => {
  it("leaves native undo alone inside text fields and terminals", () => {
    assert.isNull(
      resolveShortcutCommand(event({ key: "z", ctrlKey: true }), DEFAULT_RESOLVED_KEYBINDINGS, {
        platform: "Win32",
        context: { editableFocus: true },
      }),
    );
    assert.isNull(
      resolveShortcutCommand(event({ key: "z", ctrlKey: true }), DEFAULT_RESOLVED_KEYBINDINGS, {
        platform: "Win32",
        context: { terminalFocus: true },
      }),
    );
  });
});

describe("thread half page scroll shortcuts", () => {
  it("takes Ctrl+D and Ctrl+U on every platform, over diff and usage where mod is ctrl", () => {
    for (const platform of ["MacIntel", "Linux", "Win32"]) {
      assert.equal(
        resolveShortcutCommand(event({ key: "d", ctrlKey: true }), DEFAULT_RESOLVED_KEYBINDINGS, {
          platform,
          context: { editableFocus: true },
        }),
        "thread.scrollHalfPageDown",
      );
      assert.equal(
        resolveShortcutCommand(event({ key: "u", ctrlKey: true }), DEFAULT_RESOLVED_KEYBINDINGS, {
          platform,
        }),
        "thread.scrollHalfPageUp",
      );
    }
  });

  it("leaves Ctrl+D and Ctrl+U to the terminal and the browser preview", () => {
    for (const context of [{ terminalFocus: true }, { previewFocus: true }]) {
      for (const key of ["d", "u"]) {
        assert.notInclude(
          [
            resolveShortcutCommand(event({ key, ctrlKey: true }), DEFAULT_RESOLVED_KEYBINDINGS, {
              platform: "MacIntel",
              context,
            }),
          ],
          key === "d" ? "thread.scrollHalfPageDown" : "thread.scrollHalfPageUp",
        );
      }
    }
  });
});

describe("thread search and command palette shortcuts", () => {
  it("opens thread search on Cmd+K and the command palette on Cmd+Alt+K", () => {
    assert.equal(
      resolveShortcutCommand(event({ key: "k", metaKey: true }), DEFAULT_RESOLVED_KEYBINDINGS, {
        platform: "MacIntel",
      }),
      "threadSearch.toggle",
    );
    assert.equal(
      resolveShortcutCommand(
        event({ key: "k", metaKey: true, altKey: true }),
        DEFAULT_RESOLVED_KEYBINDINGS,
        {
          platform: "MacIntel",
        },
      ),
      "commandPalette.toggle",
    );
    assert.equal(
      resolveShortcutCommand(
        event({ key: "k", ctrlKey: true, altKey: true }),
        DEFAULT_RESOLVED_KEYBINDINGS,
        {
          platform: "Linux",
        },
      ),
      "commandPalette.toggle",
    );
  });

  it("leaves Cmd+Shift+K to copying a pull request number", () => {
    assert.equal(
      resolveShortcutCommand(
        event({ key: "k", metaKey: true, shiftKey: true }),
        DEFAULT_RESOLVED_KEYBINDINGS,
        {
          platform: "MacIntel",
        },
      ),
      "pullRequest.copyNumber",
    );
  });
});

describe("split/new/close terminal shortcuts", () => {
  it("supports when expressions", () => {
    const keybindings = compile([
      {
        shortcut: modShortcut("\\"),
        command: "terminal.split",
        whenAst: whenAnd(whenIdentifier("terminalOpen"), whenNot(whenIdentifier("terminalFocus"))),
      },
      {
        shortcut: modShortcut("n", { shiftKey: true }),
        command: "terminal.new",
        whenAst: whenAnd(whenIdentifier("terminalOpen"), whenNot(whenIdentifier("terminalFocus"))),
      },
      { shortcut: modShortcut("j"), command: "terminal.toggle" },
    ]);
    assert.isTrue(
      isTerminalSplitShortcut(event({ key: "\\", ctrlKey: true }), keybindings, {
        platform: "Win32",
        context: { terminalOpen: true, terminalFocus: false },
      }),
    );
    assert.isFalse(
      isTerminalSplitShortcut(event({ key: "\\", ctrlKey: true }), keybindings, {
        platform: "Win32",
        context: { terminalOpen: false, terminalFocus: false },
      }),
    );
    assert.isTrue(
      isTerminalNewShortcut(event({ key: "n", ctrlKey: true, shiftKey: true }), keybindings, {
        platform: "Win32",
        context: { terminalOpen: true, terminalFocus: false },
      }),
    );
  });
});

describe("shortcutLabelForCommand", () => {
  it("returns null for commands shadowed by a later conflicting shortcut", () => {
    const bindings = compile([
      { shortcut: modShortcut("1", { shiftKey: true }), command: "thread.jump.1" },
      { shortcut: modShortcut("1", { shiftKey: true }), command: "thread.jump.7" },
    ]);

    assert.isNull(shortcutLabelForCommand(bindings, "thread.jump.1", "MacIntel"));
    assert.strictEqual(shortcutLabelForCommand(bindings, "thread.jump.7", "MacIntel"), "⇧⌘1");
  });

  it("respects when-context while resolving labels", () => {
    const bindings = compile([
      { shortcut: modShortcut("d"), command: "diff.toggle" },
      {
        shortcut: modShortcut("d"),
        command: "terminal.split",
        whenAst: whenIdentifier("terminalFocus"),
      },
    ]);

    assert.strictEqual(
      shortcutLabelForCommand(bindings, "diff.toggle", {
        platform: "Linux",
        context: { terminalFocus: false },
      }),
      "Ctrl+D",
    );
    assert.isNull(
      shortcutLabelForCommand(bindings, "diff.toggle", {
        platform: "Linux",
        context: { terminalFocus: true },
      }),
    );
    assert.strictEqual(
      shortcutLabelForCommand(bindings, "terminal.split", {
        platform: "Linux",
        context: { terminalFocus: true },
      }),
      "Ctrl+D",
    );
  });
});

describe("thread navigation helpers", () => {
  it("maps attention traversal commands to directions", () => {
    assert.strictEqual(
      threadAttentionTraversalDirectionFromCommand("thread.previousAttention"),
      "previous",
    );
    assert.strictEqual(
      threadAttentionTraversalDirectionFromCommand("thread.nextAttention"),
      "next",
    );
    assert.isNull(threadAttentionTraversalDirectionFromCommand("thread.next"));
    assert.isNull(threadAttentionTraversalDirectionFromCommand(null));
  });

  it("never shows jump hints while the terminal is focused, even with an unrestricted binding", () => {
    const modifiers = event({ metaKey: true, shiftKey: true });
    assert.isFalse(
      shouldShowThreadJumpHintsForModifiers(modifiers, DEFAULT_BINDINGS, {
        platform: "MacIntel",
        context: { terminalFocus: true },
      }),
    );
    assert.isTrue(
      shouldShowThreadJumpHintsForModifiers(modifiers, DEFAULT_BINDINGS, {
        platform: "MacIntel",
        context: { terminalFocus: false },
      }),
    );
  });

  it("keeps default thread jumps off the web", () => {
    const input = event({ key: "!", code: "Digit1", metaKey: true, shiftKey: true });
    assert.isNull(
      resolveShortcutCommand(input, DEFAULT_RESOLVED_KEYBINDINGS, {
        platform: "MacIntel",
        context: { isDesktop: false },
      }),
    );
    assert.strictEqual(
      resolveShortcutCommand(input, DEFAULT_RESOLVED_KEYBINDINGS, {
        platform: "MacIntel",
        context: { isDesktop: true },
      }),
      "thread.jump.1",
    );
    assert.isFalse(
      shouldShowThreadJumpHintsForModifiers(
        event({ metaKey: true, shiftKey: true }),
        DEFAULT_RESOLVED_KEYBINDINGS,
        {
          platform: "MacIntel",
          context: { isDesktop: false },
        },
      ),
    );
    assert.isTrue(
      shouldShowThreadJumpHintsForModifiers(
        event({ metaKey: true, shiftKey: true }),
        DEFAULT_RESOLVED_KEYBINDINGS,
        {
          platform: "MacIntel",
          context: { isDesktop: true },
        },
      ),
    );
  });
});

describe("model picker navigation helpers", () => {
  it("keeps default model jumps off the web even while the picker is open", () => {
    const input = event({ key: "3", metaKey: true });
    assert.isNull(
      resolveShortcutCommand(input, DEFAULT_RESOLVED_KEYBINDINGS, {
        platform: "MacIntel",
        context: { isDesktop: false, modelPickerOpen: true },
      }),
    );
    assert.strictEqual(
      resolveShortcutCommand(input, DEFAULT_RESOLVED_KEYBINDINGS, {
        platform: "MacIntel",
        context: { isDesktop: true, modelPickerOpen: true },
      }),
      "modelPicker.jump.3",
    );
    assert.isNull(
      resolveShortcutCommand(input, DEFAULT_RESOLVED_KEYBINDINGS, {
        platform: "MacIntel",
        context: { isDesktop: true, modelPickerOpen: false },
      }),
    );
    assert.strictEqual(
      resolveShortcutCommand(
        event({ key: "#", code: "Digit3", metaKey: true, shiftKey: true }),
        DEFAULT_RESOLVED_KEYBINDINGS,
        {
          platform: "MacIntel",
          context: { isDesktop: true, modelPickerOpen: true },
        },
      ),
      "thread.jump.3",
    );
  });
});

describe("chat/editor shortcuts", () => {
  it("toggles the thread panel by default without taking terminal keystrokes", () => {
    for (const platform of ["MacIntel", "Win32", "Linux"]) {
      const input = event({
        key: "b",
        metaKey: platform === "MacIntel",
        ctrlKey: platform !== "MacIntel",
        shiftKey: true,
      });
      assert.strictEqual(
        resolveShortcutCommand(input, DEFAULT_RESOLVED_KEYBINDINGS, {
          platform,
          context: { terminalFocus: false, editableFocus: true },
        }),
        "threadPanel.toggle",
      );
      assert.isNull(
        resolveShortcutCommand(input, DEFAULT_RESOLVED_KEYBINDINGS, {
          platform,
          context: { terminalFocus: true },
        }),
      );
    }
  });

  it("preserves a user-configured thread panel shortcut instead of its default", () => {
    const bindings = mergeWithDefaultKeybindings(
      compile([
        {
          shortcut: modShortcut("b", { altKey: true, shiftKey: true }),
          command: "threadPanel.toggle",
        },
      ]),
    );

    assert.strictEqual(
      resolveShortcutCommand(
        event({ key: "b", metaKey: true, altKey: true, shiftKey: true }),
        bindings,
        { platform: "MacIntel" },
      ),
      "threadPanel.toggle",
    );
    assert.isNull(
      resolveShortcutCommand(event({ key: "b", metaKey: true, shiftKey: true }), bindings, {
        platform: "MacIntel",
      }),
    );
  });
});

describe("cross-command precedence", () => {
  it("uses when + order so a later focused rule overrides a global rule", () => {
    const keybindings = compile([
      { shortcut: modShortcut("n"), command: "chat.new" },
      {
        shortcut: modShortcut("n"),
        command: "terminal.new",
        whenAst: whenIdentifier("terminalFocus"),
      },
    ]);

    assert.isTrue(
      isTerminalNewShortcut(event({ key: "n", metaKey: true }), keybindings, {
        platform: "MacIntel",
        context: { terminalFocus: true },
      }),
    );
    assert.strictEqual(
      resolveShortcutCommand(event({ key: "n", metaKey: true }), keybindings, {
        platform: "MacIntel",
        context: { terminalFocus: true },
      }),
      "terminal.new",
    );
    assert.isFalse(
      isTerminalNewShortcut(event({ key: "n", metaKey: true }), keybindings, {
        platform: "MacIntel",
        context: { terminalFocus: false },
      }),
    );
    assert.strictEqual(
      resolveShortcutCommand(event({ key: "n", metaKey: true }), keybindings, {
        platform: "MacIntel",
        context: { terminalFocus: false },
      }),
      "chat.new",
    );
  });

  it("still lets a later global rule win when both rules match", () => {
    const keybindings = compile([
      {
        shortcut: modShortcut("n"),
        command: "terminal.new",
        whenAst: whenIdentifier("terminalFocus"),
      },
      { shortcut: modShortcut("n"), command: "chat.new" },
    ]);

    assert.isFalse(
      isTerminalNewShortcut(event({ key: "n", ctrlKey: true }), keybindings, {
        platform: "Linux",
        context: { terminalFocus: true },
      }),
    );
    assert.strictEqual(
      resolveShortcutCommand(event({ key: "n", ctrlKey: true }), keybindings, {
        platform: "Linux",
        context: { terminalFocus: true },
      }),
      "chat.new",
    );
  });
});

describe("resolveChatShortcutCommand", () => {
  it("runs the active environment's script shortcut instead of the primary environment's", () => {
    const primary = compile([{ shortcut: modShortcut("r"), command: "script.setup.run" }]);
    const active = compile([{ shortcut: modShortcut("t"), command: "script.setup.run" }]);

    assert.strictEqual(
      resolveChatShortcutCommand(event({ key: "t", ctrlKey: true }), primary, active, {
        platform: "Linux",
      }),
      "script.setup.run",
    );
    assert.isNull(
      resolveChatShortcutCommand(event({ key: "r", ctrlKey: true }), primary, active, {
        platform: "Linux",
      }),
    );
  });

  it("does not run primary scripts before the active environment's bindings arrive", () => {
    const primary = compile([{ shortcut: modShortcut("r"), command: "script.setup.run" }]);

    assert.isNull(
      resolveChatShortcutCommand(event({ key: "r", ctrlKey: true }), primary, [], {
        platform: "Linux",
      }),
    );
  });

  it("keeps primary app commands ahead of conflicting active script shortcuts", () => {
    const primary = compile([{ shortcut: modShortcut("k"), command: "commandPalette.toggle" }]);
    const active = compile([{ shortcut: modShortcut("k"), command: "script.setup.run" }]);

    assert.strictEqual(
      resolveChatShortcutCommand(event({ key: "k", ctrlKey: true }), primary, active, {
        platform: "Linux",
      }),
      "commandPalette.toggle",
    );
  });

  it("keeps app shortcuts on the primary environment when the active environment remaps them", () => {
    const primary = compile([{ shortcut: modShortcut("j"), command: "terminal.toggle" }]);
    const active = compile([{ shortcut: modShortcut("t"), command: "terminal.toggle" }]);

    assert.strictEqual(
      resolveChatShortcutCommand(event({ key: "j", ctrlKey: true }), primary, active, {
        platform: "Linux",
      }),
      "terminal.toggle",
    );
    assert.isNull(
      resolveChatShortcutCommand(event({ key: "t", ctrlKey: true }), primary, active, {
        platform: "Linux",
      }),
    );
  });

  it.each([false, true])(
    "preserves active binding precedence with terminalFocus=%s",
    (terminalFocus) => {
      const primary = compile([{ shortcut: modShortcut("r"), command: "script.setup.run" }]);
      const active = compile([
        { shortcut: modShortcut("r"), command: "script.deploy.run" },
        {
          shortcut: modShortcut("r"),
          command: "terminal.new",
          whenAst: whenIdentifier("terminalFocus"),
        },
      ]);
      const options = { platform: "Linux", context: { terminalFocus } };
      const shortcut = event({ key: "r", ctrlKey: true });

      assert.strictEqual(
        resolveChatShortcutCommand(shortcut, primary, active, options),
        terminalFocus ? null : "script.deploy.run",
      );
      assert.strictEqual(
        resolveChatShortcutCommand(shortcut, active, active, options),
        resolveShortcutCommand(shortcut, active, options),
      );
    },
  );
});

describe("resolveShortcutCommand", () => {
  it("routes mod+w to the terminal while focused and to the right panel otherwise", () => {
    const closeEvent = event({ key: "w", metaKey: true });
    assert.strictEqual(
      resolveShortcutCommand(closeEvent, DEFAULT_BINDINGS, {
        platform: "MacIntel",
        context: { terminalFocus: true },
      }),
      "terminal.close",
    );
    assert.strictEqual(
      resolveShortcutCommand(closeEvent, DEFAULT_BINDINGS, {
        platform: "MacIntel",
        context: { terminalFocus: false },
      }),
      "rightPanel.close",
    );
  });

  it("navigates history with mod+[ and mod+] outside the terminal", () => {
    const back = event({ key: "[", code: "BracketLeft", metaKey: true });
    const forward = event({ key: "]", code: "BracketRight", ctrlKey: true });
    assert.strictEqual(
      resolveShortcutCommand(back, DEFAULT_RESOLVED_KEYBINDINGS, { platform: "MacIntel" }),
      "navigation.back",
    );
    assert.strictEqual(
      resolveShortcutCommand(forward, DEFAULT_RESOLVED_KEYBINDINGS, { platform: "Linux" }),
      "navigation.forward",
    );
    assert.isNull(
      resolveShortcutCommand(back, DEFAULT_RESOLVED_KEYBINDINGS, {
        platform: "MacIntel",
        context: { terminalFocus: true },
      }),
    );
  });

  it("matches punctuation shortcuts by physical key across keyboard layouts", () => {
    const keybindings = compile([
      { shortcut: modShortcut("'", { shiftKey: true }), command: "diff.toggle" },
    ]);

    assert.strictEqual(
      resolveShortcutCommand(
        event({ key: "@", code: "Quote", metaKey: true, shiftKey: true }),
        keybindings,
        { platform: "MacIntel" },
      ),
      "diff.toggle",
    );
    assert.isNull(
      resolveShortcutCommand(
        event({ key: '"', code: "Digit2", metaKey: true, shiftKey: true }),
        keybindings,
        { platform: "MacIntel" },
      ),
    );
  });

  it("does not let a punctuation position shadow a Latin layout key", () => {
    const keybindings = compile([
      { shortcut: modShortcut("m"), command: "diff.toggle" },
      { shortcut: modShortcut(";"), command: "sidebar.toggle" },
    ]);

    assert.strictEqual(
      resolveShortcutCommand(event({ key: "m", code: "Semicolon", metaKey: true }), keybindings, {
        platform: "MacIntel",
      }),
      "diff.toggle",
    );
  });

  it("matches Option-modified letters using the physical key code on macOS", () => {
    assert.strictEqual(
      resolveShortcutCommand(
        event({ key: "∫", code: "KeyB", metaKey: true, altKey: true }),
        DEFAULT_BINDINGS,
        { platform: "MacIntel" },
      ),
      "rightPanel.toggle",
    );
  });

  it("matches non-Latin layout letters using the physical key code", () => {
    const keybindings = compile([{ shortcut: modShortcut("d"), command: "diff.toggle" }]);

    assert.strictEqual(
      resolveShortcutCommand(event({ key: "в", code: "KeyD", metaKey: true }), keybindings, {
        platform: "MacIntel",
      }),
      "diff.toggle",
    );
  });

  it("ignores the physical key code when the layout types a different Latin letter", () => {
    const keybindings = compile([{ shortcut: modShortcut("d"), command: "diff.toggle" }]);

    assert.isNull(
      resolveShortcutCommand(event({ key: "a", code: "KeyD", metaKey: true }), keybindings, {
        platform: "MacIntel",
      }),
    );
    assert.strictEqual(
      resolveShortcutCommand(event({ key: "d", code: "KeyL", metaKey: true }), keybindings, {
        platform: "MacIntel",
      }),
      "diff.toggle",
    );
  });
});

describe("isRichTextBoldShortcut", () => {
  it("matches the B key on non-Latin layouts, like the sidebar toggle does", () => {
    const cyrillicB = event({ key: "и", code: "KeyB", ctrlKey: true });
    assert.isTrue(isRichTextBoldShortcut(cyrillicB));
    assert.strictEqual(
      resolveShortcutCommand(cyrillicB, DEFAULT_BINDINGS, { platform: "Win32" }),
      "sidebar.toggle",
    );
  });

  it("follows the letter a Latin layout types, not the physical key", () => {
    assert.isFalse(isRichTextBoldShortcut(event({ key: "x", code: "KeyB", ctrlKey: true })));
    assert.isTrue(isRichTextBoldShortcut(event({ key: "b", code: "KeyN", ctrlKey: true })));
  });
});

describe("composer and pull request shortcuts", () => {
  it("fills missing number shortcuts without replacing the saved URL binding", () => {
    const olderServerBindings = DEFAULT_RESOLVED_KEYBINDINGS.filter(
      (binding) =>
        binding.command !== "pullRequest.copyNumber" && binding.command !== "thread.copyReference",
    );
    const bindings = mergeWithDefaultKeybindings([
      ...olderServerBindings,
      ...compileResolvedKeybindingsConfig([
        { key: "mod+shift+8", command: "thread.copyReference", when: "!terminalFocus" },
      ]),
    ]);
    for (const [key, command] of [
      ["k", "pullRequest.copyNumber"],
      ["8", "thread.copyReference"],
      ["c", null],
      ["y", null],
    ] as const) {
      assert.strictEqual(
        resolveShortcutCommand(event({ key, metaKey: true, shiftKey: true }), bindings, {
          platform: "MacIntel",
        }),
        command,
      );
    }
  });

  it.each(["MacIntel", "Win32", "Linux"])(
    "reserves the alternate send chord for the focused composer on %s",
    (platform) => {
      const modifier = {
        metaKey: platform === "MacIntel",
        ctrlKey: platform !== "MacIntel",
      };
      const shiftedEnter = event({ key: "Enter", shiftKey: true, ...modifier });
      for (const composerRequiresModifier of [false, true]) {
        const context = {
          composerFocus: true,
          turnRunning: true,
          composerRequiresModifier,
        };
        assert.strictEqual(
          resolveShortcutCommand(shiftedEnter, DEFAULT_RESOLVED_KEYBINDINGS, {
            platform,
            context,
          }),
          composerRequiresModifier ? "composer.sendAlternate" : "thread.steerQueuedMessage",
        );
        assert.strictEqual(
          shortcutLabelForCommand(DEFAULT_RESOLVED_KEYBINDINGS, "composer.sendAlternate", {
            platform,
            context,
          }),
          formatShortcutLabel(
            modShortcut("enter", { shiftKey: composerRequiresModifier }),
            platform,
          ),
        );
        assert.strictEqual(
          resolveShortcutCommand(shiftedEnter, DEFAULT_RESOLVED_KEYBINDINGS, {
            platform,
            context: { ...context, composerFocus: false },
          }),
          "thread.steerQueuedMessage",
        );
      }
    },
  );

  const altEffortBindings = compileResolvedKeybindingsConfig([
    { key: "mod+alt+e", command: "composer.effort", when: "!terminalFocus" },
  ]);

  it("leaves AltGr text entry alone with a custom Alt binding", () => {
    for (const platform of ["Win32", "Linux"]) {
      const input = event({
        key: "€",
        code: "KeyE",
        ctrlKey: true,
        altKey: true,
        getModifierState: (key) => key === "AltGraph",
      });
      assert.isNull(resolveShortcutCommand(input, altEffortBindings, { platform }));
      assert.strictEqual(
        resolveShortcutCommand({ ...input, getModifierState: () => false }, altEffortBindings, {
          platform,
        }),
        "composer.effort",
      );
    }
  });

  it("keeps Firefox modifier reporting usable on Windows and macOS", () => {
    const getModifierState = (key: string) => key === "AltGraph";
    assert.strictEqual(
      resolveShortcutCommand(
        event({ key: "e", ctrlKey: true, altKey: true, getModifierState }),
        altEffortBindings,
        { platform: "Win32" },
      ),
      "composer.effort",
    );
    assert.strictEqual(
      resolveShortcutCommand(
        event({ key: "´", code: "KeyE", metaKey: true, altKey: true, getModifierState }),
        altEffortBindings,
        { platform: "MacIntel" },
      ),
      "composer.effort",
    );
  });
});

describe("Usage shortcuts", () => {
  it.each(["Linux", "MacIntel"])(
    "gives the shared number shortcuts to periods on Usage and keeps the other thread jumps on %s",
    (platform) => {
      const modifiers = {
        shiftKey: true,
        ctrlKey: platform === "Linux",
        metaKey: platform === "MacIntel",
      };
      const options = { platform, context: { usagePageOpen: true, isDesktop: true } };
      assert.strictEqual(
        resolveShortcutCommand(
          event({ key: "@", code: "Digit2", ...modifiers }),
          DEFAULT_RESOLVED_KEYBINDINGS,
          options,
        ),
        "usage.period.week",
      );
      assert.isNull(
        shortcutLabelForCommand(DEFAULT_RESOLVED_KEYBINDINGS, "thread.jump.2", options),
      );
      assert.strictEqual(
        resolveShortcutCommand(
          event({ key: "%", code: "Digit5", ...modifiers }),
          DEFAULT_RESOLVED_KEYBINDINGS,
          options,
        ),
        "thread.jump.5",
      );
    },
  );

  it("matches shifted number keys for periods and only on Usage", () => {
    const shortcut = event({ key: "!", code: "Digit1", ctrlKey: true, shiftKey: true });
    assert.strictEqual(
      resolveShortcutCommand(shortcut, DEFAULT_RESOLVED_KEYBINDINGS, {
        platform: "Linux",
        context: { usagePageOpen: true },
      }),
      "usage.period.day",
    );
    assert.isNull(
      resolveShortcutCommand(shortcut, DEFAULT_RESOLVED_KEYBINDINGS, {
        platform: "Linux",
      }),
    );
  });
});

describe("chord shortcuts", () => {
  const platform = "MacIntel";
  const compileRules = (
    rules: ReadonlyArray<{ key: string; command: KeybindingCommand; when?: string }>,
  ) => compileResolvedKeybindingsConfig(rules);

  function keyDown(overrides: Partial<ShortcutEventLike> = {}) {
    return {
      ...event(overrides),
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
    };
  }
  const leaderPress = () => keyDown({ key: "g", metaKey: true });
  const plainPress = (key: string) => keyDown({ key });

  beforeEach(() => {
    vi.useFakeTimers();
    cancelPendingChord();
  });
  afterEach(() => {
    cancelPendingChord();
    vi.useRealTimers();
  });

  it("runs the command on the follow-up key and nothing on the leader alone", () => {
    const rules = compileRules([{ key: "mod+g x", command: "terminal.toggle" }]);
    const leader = leaderPress();

    assert.isNull(resolveShortcutCommand(leader, rules, { platform }));
    assert.strictEqual(getPendingChordLabel(), "\u2318G");
    assert.isTrue(leader.preventDefault.mock.calls.length > 0);

    assert.strictEqual(
      resolveShortcutCommand(plainPress("x"), rules, { platform }),
      "terminal.toggle",
    );
    assert.isNull(getPendingChordLabel());
  });

  it("opens the environment picker from the default ctrl+x l chord", () => {
    const context = { terminalFocus: false };
    assert.isNull(
      resolveShortcutCommand(keyDown({ key: "x", ctrlKey: true }), DEFAULT_RESOLVED_KEYBINDINGS, {
        platform,
        context,
      }),
    );
    assert.strictEqual(
      resolveShortcutCommand(plainPress("l"), DEFAULT_RESOLVED_KEYBINDINGS, { platform, context }),
      "composer.environment",
    );
  });

  it("lets every listener resolve the same event, including the follow-up key", () => {
    const rules = compileRules([{ key: "mod+g x", command: "terminal.toggle" }]);
    const leader = leaderPress();
    resolveShortcutCommand(leader, rules, { platform });
    assert.isNull(resolveShortcutCommand(leader, rules, { platform }));
    assert.strictEqual(getPendingChordLabel(), "\u2318G");

    const next = plainPress("x");
    assert.strictEqual(resolveShortcutCommand(next, rules, { platform }), "terminal.toggle");
    assert.strictEqual(resolveShortcutCommand(next, rules, { platform }), "terminal.toggle");
  });

  it("swallows a key no chord can take and returns to normal matching", () => {
    const rules = compileRules([
      { key: "mod+g x", command: "terminal.toggle" },
      { key: "q", command: "usage.cost" },
    ]);
    resolveShortcutCommand(leaderPress(), rules, { platform });

    const stray = plainPress("q");
    assert.isNull(resolveShortcutCommand(stray, rules, { platform }));
    assert.isTrue(stray.preventDefault.mock.calls.length > 0);
    assert.isNull(getPendingChordLabel());

    assert.strictEqual(resolveShortcutCommand(plainPress("q"), rules, { platform }), "usage.cost");
  });

  it("cancels on Escape without letting it through", () => {
    const rules = compileRules([{ key: "mod+g x", command: "terminal.toggle" }]);
    resolveShortcutCommand(leaderPress(), rules, { platform });

    const escape = plainPress("Escape");
    assert.isNull(resolveShortcutCommand(escape, rules, { platform }));
    assert.isTrue(escape.preventDefault.mock.calls.length > 0);
    assert.isNull(getPendingChordLabel());
  });

  it("expires when the follow-up key never comes", () => {
    const rules = compileRules([
      { key: "mod+g x", command: "terminal.toggle" },
      { key: "x", command: "usage.cost" },
    ]);
    resolveShortcutCommand(leaderPress(), rules, { platform });
    vi.advanceTimersByTime(1500);

    assert.isNull(getPendingChordLabel());
    assert.strictEqual(resolveShortcutCommand(plainPress("x"), rules, { platform }), "usage.cost");
  });

  it("keeps waiting through modifier presses and a held leader", () => {
    const rules = compileRules([{ key: "mod+g shift+x", command: "terminal.toggle" }]);
    resolveShortcutCommand(leaderPress(), rules, { platform });
    resolveShortcutCommand(keyDown({ key: "g", metaKey: true, repeat: true }), rules, { platform });
    resolveShortcutCommand(keyDown({ key: "Shift", shiftKey: true }), rules, { platform });
    assert.strictEqual(getPendingChordLabel(), "\u2318G");

    assert.strictEqual(
      resolveShortcutCommand(keyDown({ key: "x", shiftKey: true }), rules, { platform }),
      "terminal.toggle",
    );
  });

  it("takes the follow-up key from the chord, not from a plain shortcut on it", () => {
    const rules = compileRules([
      { key: "x", command: "usage.cost" },
      { key: "mod+g x", command: "terminal.toggle" },
    ]);
    resolveShortcutCommand(leaderPress(), rules, { platform });
    assert.strictEqual(
      resolveShortcutCommand(plainPress("x"), rules, { platform }),
      "terminal.toggle",
    );
  });

  it("evaluates when-clauses per listener without swallowing the key for them", () => {
    const rules = compileRules([
      { key: "mod+g x", command: "terminal.toggle", when: "composerFocus" },
    ]);
    resolveShortcutCommand(leaderPress(), rules, { platform, context: { composerFocus: true } });

    const next = plainPress("x");
    assert.isNull(resolveShortcutCommand(next, rules, { platform, context: {} }));
    assert.isFalse(next.preventDefault.mock.calls.length > 0);
    assert.strictEqual(
      resolveShortcutCommand(next, rules, { platform, context: { composerFocus: true } }),
      "terminal.toggle",
    );
  });

  it("does not start a chord outside its when-clause", () => {
    const rules = compileRules([
      { key: "mod+g x", command: "terminal.toggle", when: "!terminalFocus" },
    ]);
    const leader = leaderPress();
    assert.isNull(
      resolveShortcutCommand(leader, rules, { platform, context: { terminalFocus: true } }),
    );
    assert.isNull(getPendingChordLabel());
    assert.isFalse(leader.preventDefault.mock.calls.length > 0);
  });

  it("never starts a chord while the terminal has focus", () => {
    const rules = compileRules([{ key: "mod+g x", command: "terminal.toggle" }]);
    const leader = leaderPress();
    assert.isNull(
      resolveShortcutCommand(leader, rules, { platform, context: { terminalFocus: true } }),
    );
    assert.isNull(getPendingChordLabel());
    assert.isFalse(leader.preventDefault.mock.calls.length > 0);
  });

  it("reports the follow-up key so raw-key handlers can leave it alone", () => {
    const rules = compileRules([{ key: "mod+g x", command: "terminal.toggle" }]);
    assert.isFalse(isChordFollowUp(plainPress("x"), rules, { platform }));

    resolveShortcutCommand(leaderPress(), rules, { platform });
    const next = plainPress("x");
    assert.isTrue(isChordFollowUp(next, rules, { platform }));
    assert.isTrue(isChordFollowUp(next, rules, { platform }));
    assert.isFalse(isChordFollowUp(plainPress("x"), rules, { platform }));
  });

  it("resolves a React wrapper and its native event as the same keypress", () => {
    const rules = compileRules([{ key: "mod+g x", command: "terminal.toggle" }]);
    resolveShortcutCommand(leaderPress(), rules, { platform });

    const native = plainPress("x");
    const wrapper = { ...plainPress("x"), nativeEvent: native };
    assert.strictEqual(resolveShortcutCommand(native, rules, { platform }), "terminal.toggle");
    assert.strictEqual(resolveShortcutCommand(wrapper, rules, { platform }), "terminal.toggle");
  });

  it("ignores the Settings shortcut recorder's keypresses", () => {
    const rules = compileRules([{ key: "mod+g x", command: "terminal.toggle" }]);
    const recorder = { closest: () => ({}) } as unknown as EventTarget;
    const leader = { ...leaderPress(), target: recorder };
    assert.isNull(resolveShortcutCommand(leader, rules, { platform }));
    assert.isNull(getPendingChordLabel());
    assert.isFalse(leader.preventDefault.mock.calls.length > 0);
  });

  it("lets the later rule win when a plain shortcut and a chord leader share a key", () => {
    const chordLast = compileRules([
      { key: "mod+g", command: "usage.cost" },
      { key: "mod+g x", command: "terminal.toggle" },
    ]);
    assert.isNull(resolveShortcutCommand(leaderPress(), chordLast, { platform }));
    assert.strictEqual(getPendingChordLabel(), "\u2318G");
    cancelPendingChord();

    const plainLast = compileRules([
      { key: "mod+g x", command: "terminal.toggle" },
      { key: "mod+g", command: "usage.cost" },
    ]);
    assert.strictEqual(
      resolveShortcutCommand(leaderPress(), plainLast, { platform }),
      "usage.cost",
    );
    assert.isNull(getPendingChordLabel());
  });

  it("labels a chord with both steps and keeps it out of modifier hints", () => {
    const rules = compileRules([{ key: "mod+g x", command: "thread.jump.1" }]);
    assert.strictEqual(shortcutLabelForCommand(rules, "thread.jump.1", { platform }), "\u2318G X");
    assert.isFalse(
      shouldShowThreadJumpHintsForModifiers(
        { metaKey: true, ctrlKey: false, shiftKey: false, altKey: false },
        rules,
        { platform },
      ),
    );
  });
});

describe("thread tab shortcuts", () => {
  it("maps tab commands to indices, with 0 as the conversation", () => {
    assert.strictEqual(threadTabIndexFromCommand("thread.tab.1"), 0);
    assert.strictEqual(threadTabIndexFromCommand("thread.tab.9"), 8);
    assert.isNull(threadTabIndexFromCommand("thread.jump.1"));
  });

  it("binds Alt+1 through Alt+9 by default", () => {
    for (let number = 1; number <= 9; number += 1) {
      const pressed = event({ key: String(number), code: `Digit${number}`, altKey: true });
      assert.strictEqual(
        threadTabShortcutIndex(pressed, DEFAULT_RESOLVED_KEYBINDINGS, { platform: "Linux" }),
        number - 1,
      );
      assert.strictEqual(
        resolveShortcutCommand(pressed, DEFAULT_RESOLVED_KEYBINDINGS, { platform: "Linux" }),
        `thread.tab.${number}`,
      );
    }
  });

  it("matches Option+digit on macOS, where the key types another character", () => {
    const pressed = event({ key: "¡", code: "Digit1", altKey: true });
    assert.strictEqual(
      threadTabShortcutIndex(pressed, DEFAULT_RESOLVED_KEYBINDINGS, { platform: "MacIntel" }),
      0,
    );
  });

  it("leaves other digit shortcuts alone", () => {
    const withMod = event({ key: "1", code: "Digit1", metaKey: true });
    assert.isNull(
      threadTabShortcutIndex(withMod, DEFAULT_RESOLVED_KEYBINDINGS, { platform: "MacIntel" }),
    );
    const plain = event({ key: "1", code: "Digit1" });
    assert.isNull(
      threadTabShortcutIndex(plain, DEFAULT_RESOLVED_KEYBINDINGS, { platform: "MacIntel" }),
    );
  });

  it("works while a terminal has focus", () => {
    const pressed = event({ key: "2", code: "Digit2", altKey: true });
    assert.strictEqual(
      resolveShortcutCommand(pressed, DEFAULT_RESOLVED_KEYBINDINGS, {
        platform: "Linux",
        context: { terminalFocus: true },
      }),
      "thread.tab.2",
    );
  });

  it("opens a thread tab with mod+t unless the right panel takes it", () => {
    const pressed = event({ key: "t", metaKey: true });
    const resolve = (context: Partial<ShortcutMatchContext>) =>
      resolveShortcutCommand(pressed, DEFAULT_RESOLVED_KEYBINDINGS, {
        platform: "MacIntel",
        context,
      });
    assert.strictEqual(resolve({ rightPanelOpen: false }), "thread.newTab");
    assert.strictEqual(resolve({ rightPanelOpen: true }), "rightPanel.new");
    assert.strictEqual(resolve({ rightPanelOpen: false, terminalFocus: true }), "thread.newTab");
    assert.strictEqual(resolve({ rightPanelOpen: true, terminalFocus: true }), "thread.newTab");
  });

  it("closes the showing thread tab with mod+w, and the right panel's tab otherwise", () => {
    const pressed = event({ key: "w", metaKey: true });
    const resolve = (context: Partial<ShortcutMatchContext>) =>
      resolveShortcutCommand(pressed, DEFAULT_RESOLVED_KEYBINDINGS, {
        platform: "MacIntel",
        context,
      });
    assert.strictEqual(resolve({ threadTabActive: true }), "thread.closeTab");
    assert.strictEqual(resolve({ threadTabActive: false }), "rightPanel.close");
    assert.strictEqual(resolve({ threadTabActive: true, terminalFocus: true }), "terminal.close");
  });
});
