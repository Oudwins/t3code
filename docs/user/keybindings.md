# Keybindings

Customize shortcuts in **Settings → Keybindings** on web and desktop. That page
also lists the command IDs and defaults available in your version.

## Composer controls

In **Settings → General → Send shortcut**, choose whether Enter sends, requires
`mod+Enter` for multiline prompts, or always requires `mod+Enter`. `Shift+Enter`
inserts a new line. This applies to the web and desktop composer at desktop widths.

**Follow-up behavior** chooses Queue or Steer while the agent runs. Use
`mod+Enter` to do the opposite for one message, even when the send shortcut
requires a modifier. `mod+Alt+Enter` sends, keeps that thread running in the
background, and opens a fresh new-thread composer. In a new thread, `mod+Enter`
does the same. Change these shortcuts in **Settings → Keybindings** under
**Composer: Opposite Queue or Steer Action**, **Composer: Start in Background**,
or **Composer: Send and Start New Thread**. These bindings take priority over the
send shortcut. Click the send button to use the configured follow-up behavior.

When an active turn has queued messages, `mod+Shift+Enter` sends the first as a
steer. Change it under **Queue: Send First Queued Message as Steer** in Keybindings.

Use `mod+shift+m` to choose a model and `mod+shift+h` to choose a host.
To step a new thread to the next machine instead of opening the menu, bind
**Composer: Cycle Host** in Keybindings. It has no default shortcut.
Use `mod+shift+e` for effort, `mod+shift+a` for access mode, `mod+shift+x` for the
workspace, and `mod+shift+g` for the Git branch. `mod+shift+x` opens the command
palette on the workspace choices (the current checkout, a new worktree, and the
previous worktree when available), so you can type to filter them.
Use `mod+shift+l` to reuse the previous worktree directly.
**Change model** and **Select workspace** are also in the command palette
(`Cmd/Ctrl+Alt+K`), next to their shortcuts.

In the model picker, press Left in an empty search field or Shift+Tab to reach
the provider list. Use Up/Down to move and Enter to choose. Right returns to
model search. `mod+shift+up` and `mod+shift+down` switch providers directly and clear the
search. These provider shortcuts can also be changed in Settings.

These shortcuts run inside the focused web or desktop client. `mod` uses Command
on macOS and Ctrl on Windows and Linux, including GNOME, KDE Plasma, Niri, and
Hyprland. If a custom desktop shortcut takes the same keys, choose another binding
in Settings.

## Move through lists

In menus, pickers, the command palette, and search results, `Ctrl+N` or `Cmd+N` moves to
the next item and `Ctrl+P` or `Cmd+P` to the previous one, the same as Down and Up. While a
list is open these win over New Thread and the file picker; everywhere else those
shortcuts work as usual. This is not configurable in Settings.

## Triage threads

With a thread open, `mod+shift+s` settles it and `mod+alt+s` snoozes it. Both toggle:
the same shortcut un-settles a settled thread or wakes a snoozed one. Snooze opens a
list of wake times; type to filter it, press Enter to pick one, or choose **Custom…**
for a date or duration. A thread waiting on an approval or question cannot be snoozed.
The command palette (`Cmd/Ctrl+Alt+K`) has the same actions: **Settle thread**,
**Un-settle thread**, **Snooze thread**, and **Wake thread**.

`mod+shift+[` and `mod+shift+]` open the previous and next thread in the sidebar.
`mod+alt+[` and `mod+alt+]` skip to the previous and next thread that needs you: any
thread that has stopped working, whether it is blocked on an approval or question,
failed, or simply finished, and whether or not you have read it. Working, snoozed, and
settled threads are skipped, and the search wraps at either end. These two need the
default sidebar rather than the legacy one.

Change them in Settings under **Thread: Settle**, **Thread: Snooze**, **Thread: Previous
Needing Attention**, and **Thread: Next Needing Attention**.

## Copy pull request references

With a PR open in the right panel or on the Pull Requests page, use `mod+shift+c`
to copy its URL and `mod+shift+k` to copy its number with a `#` prefix.
Both shortcuts can be changed in Settings. Search for “Copy Link or Thread ID”
or “Copy Number”. They copy the selected PR and leave terminal input alone.

## iPad

With a hardware keyboard, use `Cmd+1` through `Cmd+9` to open the first nine
displayed threads. The shortcuts follow the current list filters and order.
`Cmd+K` opens the command palette to search commands, projects, and threads.
Use the arrow keys and Return to choose a result, or `Cmd+1` through `Cmd+9` to
choose directly. Escape or `Cmd+K` closes the palette. Start a search with `>`
to show only actions.

In a new thread, `Cmd+Shift+H` moves the draft to the next machine.

In the composer, Return sends and `Shift+Return` inserts a new line. `Cmd+Return`
also sends. To make Return insert a new line instead, change the Return key
behavior in Settings → Keyboard.

## Edit the configuration file

Keybindings live on the environment's machine, in
`~/.t3/userdata/keybindings.json` by default. You can edit this file directly.
It is a JSON array of rules:

```json
[
  { "key": "mod+g", "command": "terminal.toggle" },
  { "key": "mod+shift+g", "command": "terminal.new", "when": "terminalFocus" }
]
```

T3 Code creates the file with its defaults and adds new defaults on later startups.
New defaults do not replace commands you customized. If a new default overlaps one
of your shortcuts, [rule order](#precedence) decides which runs.
Invalid rules are ignored; if the file cannot be parsed, T3 Code uses defaults.

## Rule shape

Each rule requires a `key` shortcut and a `command` ID. An optional `when`
expression restricts when it runs.

Project scripts use `script.{id}.run`, such as `script.test.run`.

## Key syntax

Join modifiers and a key with `+`, such as `mod+shift+d` or `ctrl+l`.
`mod` means Command on macOS and Control elsewhere. Other modifiers are
`cmd` / `meta`, `ctrl` / `control`, `alt` / `option`, and `shift`.

## Chords

A chord runs a command from two keys in a row: a shortcut with a modifier, then one
more key. Separate the steps with a space:

```json
{ "key": "mod+g n", "command": "thread.next", "when": "!terminalFocus" }
```

Press `mod+g`, release it, then press `n`. While T3 Code waits, a hint at the top
of the window shows the first key. `Esc`, any key the chord does not use, or about
a second and a half without a key cancels it. A cancelled chord swallows the key
you pressed, so it never types into the composer.

In **Settings → Keybindings**, click a shortcut and press the first key, then press
the second. A modified first key followed by a plain key records a chord.

The first step must include `mod`, `ctrl`, `cmd`, or `alt`, so it can never be typed
text. The second step is usually a plain key but may carry modifiers, such as
`mod+k mod+s`. `Esc` cannot be a second step. Chords work in the web and desktop apps
and never start while the terminal has focus. When a chord's first key matches a
plain shortcut, [rule order](#precedence) decides which one runs.

## When conditions

Available context keys are `terminalFocus`, `terminalOpen`, `previewFocus`,
`previewOpen`, `modelPickerOpen`, `usagePageOpen`, `composerFocus`, `composerDraft`,
`turnRunning`, `editableFocus`, `isWeb`, and `isDesktop`.
`editableFocus` is true while a text field, the composer, or another editor has
the keyboard. `isWeb` is true in a browser tab. `isDesktop` is true in the
desktop app. Unknown keys evaluate to `false`.

`mod+shift+1` through `mod+shift+9` jump to the first nine threads, and `mod+1`
through `mod+9` choose a model while the model picker is open. Both defaults use
`isDesktop`, so a browser keeps its own tab-switch shortcuts. Remove that
condition in Settings if you want the same jumps in a browser. On macOS the system
screenshot shortcuts take `cmd+shift+3`, `cmd+shift+4`, and `cmd+shift+5` before T3
Code sees them, so rebind those jumps if you need them. On the Usage page,
`mod+shift+1` through `mod+shift+4` pick the period instead of jumping to a thread.

Combine keys with `!` for not, `&&` for and, `||` for or, and parentheses:

```json
{ "key": "mod+j", "command": "terminal.toggle", "when": "terminalOpen && !terminalFocus" }
```

## Precedence

The last rule whose key and condition both match wins, even if it belongs to a
different command. Put a more specific rule after a general one when they share
a shortcut.

## Commands with special behavior

`thread.stop` interrupts the running turn in the focused thread. It has no default
shortcut; assign one in **Settings → Keybindings**.

`thread.undo` (`mod+z` by default) reverses the actions shown in the notice at the
bottom of the sidebar, such as unpin, settle, snooze, archive, or discarding a
draft. Consecutive
actions of the same kind undo together. The notice remains available for five
seconds after the latest action. The default shortcut skips text fields and
terminals so native undo keeps working there.

`thread.tab.1` through `thread.tab.9` (`alt+1` through `alt+9` by default) switch a
thread's [tabs](./thread-sidebar.md#work-in-tabs): the first is the conversation and
each later number is the next tab. They work while a terminal has focus. A number
with no matching tab does nothing and the terminal keeps the key, so a shell or
editor binding on `alt+digit` still works until that tab exists.

`navigation.back` (`mod+[` by default) and `navigation.forward` (`mod+]`) move
through the pages you have visited, like a browser's back and forward buttons.

`chat.new` may ask you to choose a project when there is more than one.
`chat.newLocal` skips that chooser. Both use your
[new-thread defaults](./thread-sidebar.md#start-a-thread). `chat.newWithoutProject`
(`mod+alt+n`) starts a thread [without a project](./thread-sidebar.md#start-without-a-project).

## Reserved shortcuts

In the desktop app, `mod+w` closes the focused terminal, the active tab, or the
active right-panel tab. When nothing remains to close, it closes the window. In a browser, `mod+w`
closes the browser tab; rebind `rightPanel.close` and `terminal.close` to an available
shortcut such as `alt+w`.

Many defaults include `!terminalFocus` so they do not intercept terminal input.
Keep that condition when remapping them if you want the same behavior.

## Desktop quit shortcut

Use `Cmd+Q` on macOS or `Ctrl+Q` on Windows and Linux. In the default **Hold** mode,
hold for 1.2 seconds or press twice within 500 milliseconds. Holding requires
keyboard repeat; if repeat is disabled, use two presses or the application menu.

Change **Settings → General → Confirmations → Quit shortcut** to **Direct** for a
single press or **Double press** for two presses only. Choosing **Quit** from the
application menu always quits immediately.
