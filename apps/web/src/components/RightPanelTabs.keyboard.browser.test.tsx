import type { ComponentProps } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import { DEFAULT_RESOLVED_KEYBINDINGS } from "@t3tools/shared/keybindings";

import { act, fakeTimers, render, stubGlobal } from "../../test/render";
import { SurfaceTabStrip } from "./RightPanelTabs";

vi.mock("~/hooks/useTheme", () => ({ useTheme: () => ({ resolvedTheme: "light" }) }));
vi.mock("~/browser/browserDefaults", () => ({ useBrowserDefaults: () => ({ profiles: [] }) }));

const noop = () => undefined;

async function settle() {
  await act(() => vi.advanceTimersByTimeAsync(0));
  await act(() => vi.advanceTimersToNextFrame());
}

type PanelProps = Pick<ComponentProps<typeof SurfaceTabStrip>, "onNewTab">;

async function renderPanel(overrides: PanelProps, platform = "MacIntel") {
  await using stack = new AsyncDisposableStack();
  stack.use(fakeTimers());
  stack.use(
    stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        disconnect() {}
        unobserve() {}
      },
    ),
  );
  // Menus wait for exit animations to finish, which never happens under fake timers.
  stack.use(vi.spyOn(Element.prototype, "getAnimations").mockReturnValue([]));
  stack.use(vi.spyOn(navigator, "platform", "get").mockReturnValue(platform));
  const panel = (props: PanelProps) => (
    <SurfaceTabStrip
      noDrag={false}
      open
      keybindings={DEFAULT_RESOLVED_KEYBINDINGS}
      getShortcutContext={() => ({
        terminalFocus: false,
        terminalOpen: false,
        previewFocus: false,
        previewOpen: false,
        isWeb: true,
        isDesktop: false,
      })}
      surfaces={[]}
      environmentId={null}
      activeSurfaceId={null}
      pendingSurfaceIds={new Set()}
      previewSessions={{}}
      desktopByTabId={{}}
      terminalLabelsById={new Map()}
      onActivate={noop}
      onCloseSurface={noop}
      onCloseOtherSurfaces={noop}
      onCloseSurfacesToRight={noop}
      onCloseAllSurfaces={noop}
      onCopyFilePath={noop}
      onAddBrowser={noop}
      onAddBrowserInProfile={noop}
      onAddTerminal={noop}
      onAddDiff={noop}
      onAddFiles={noop}
      onAddPullRequest={noop}
      onAddPullRequests={noop}
      onAddDevice={noop}
      browserAvailable={false}
      terminalAvailable={false}
      diffAvailable={false}
      filesAvailable
      pullRequestAvailable={false}
      pullRequestsAvailable={false}
      deviceAvailable={false}
      {...props}
    />
  );
  // Nothing here navigates, and the test router would load on the fake clock too.
  const screen = stack.use(await render(panel(overrides), { router: false }));
  await settle();
  const environment = stack.move();
  return {
    container: screen.container,
    [Symbol.asyncDispose]: () => environment.disposeAsync(),
  };
}

async function press(key: string, options: KeyboardEventInit = {}) {
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...options });
  await act(() => (document.activeElement ?? document.body).dispatchEvent(event));
  await settle();
  return event;
}

describe("thread tab strip new-tab shortcut", () => {
  it("leaves the shortcut to the host when the host owns thread tabs", async () => {
    const onNewTab = vi.fn();
    await using _screen = await renderPanel({ onNewTab });
    expect((await press("t", { metaKey: true })).defaultPrevented).toBe(false);
    expect(onNewTab).not.toHaveBeenCalled();
    expect(document.querySelector('[role="menu"]')).toBeNull();
  });
});
