import {
  DEFAULT_CLIENT_SETTINGS,
  EnvironmentId,
  FILL_PREVIEW_VIEWPORT,
  ThreadId,
  type ClientSettings,
  type DesktopPreviewBridge,
} from "@t3tools/contracts";
import type { ReactNode } from "react";

import "~/index.css";
import { describe, expect, it, vi } from "vite-plus/test";
import type { previewBridge } from "~/components/preview/previewBridge";

import { act, fakeTimers, render } from "../../test/render";

const mocks = vi.hoisted(() => ({
  getClientSettings: vi.fn<() => Promise<ClientSettings | null>>(),
  setClientSettings: vi.fn<(settings: ClientSettings) => Promise<void>>(),
  createTab: vi.fn<DesktopPreviewBridge["createTab"]>(),
  closeTab: vi.fn<DesktopPreviewBridge["closeTab"]>(),
  registerWebview: vi.fn<DesktopPreviewBridge["registerWebview"]>(),
  getPreviewConfig: vi.fn<DesktopPreviewBridge["getPreviewConfig"]>(),
  activeRecordings: new Set<string>(),
  portSpace: { enabled: false, settled: true },
}));

vi.mock(import("~/state/portSpace"), async (original) => ({
  ...(await original()),
  usePortSpacesEnabled: () => mocks.portSpace.enabled,
  usePortSpaceTunnelSettled: () => mocks.portSpace.settled,
}));

vi.mock(import("~/localApi"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    ensureLocalApi: () => ({ ...actual.ensureLocalApi(), persistence: mocks as never }),
  };
});

vi.mock(import("./desktopTabLifetime"), { spy: true });

// The Electron desktop bridge; a browser has none.
vi.mock(import("~/components/preview/previewBridge"), async (original) => ({
  ...(await original()),
  previewBridge: {
    createTab: mocks.createTab,
    closeTab: mocks.closeTab,
    registerWebview: mocks.registerWebview,
    getPreviewConfig: mocks.getPreviewConfig,
  } as unknown as NonNullable<typeof previewBridge>,
}));

vi.mock(import("~/components/preview/usePreviewBridge"), async (original) => ({
  ...(await original()),
  usePreviewBridge: () => undefined,
}));

import {
  __resetClientSettingsPersistenceForTests,
  ensureClientSettingsHydrated,
} from "~/hooks/useSettings";
import { useBrowserSurfaceStore } from "./browserSurfaceStore";
import * as desktopTabLifetime from "./desktopTabLifetime";
import { HostedBrowserWebview } from "./HostedBrowserWebview";

function resetStores() {
  __resetClientSettingsPersistenceForTests();
  useBrowserSurfaceStore.setState({ activityByTabId: {}, byTabId: {} });
}

function setup() {
  using stack = new DisposableStack();
  resetStores();
  stack.defer(resetStores);
  vi.mocked(desktopTabLifetime.acquireDesktopTab).mockClear();
  mocks.getClientSettings.mockReset();
  mocks.setClientSettings.mockReset().mockResolvedValue(undefined);
  mocks.createTab.mockReset().mockResolvedValue(undefined);
  mocks.closeTab.mockReset().mockResolvedValue(undefined);
  mocks.registerWebview.mockReset().mockResolvedValue(undefined);
  mocks.portSpace.enabled = false;
  mocks.portSpace.settled = true;
  mocks.getPreviewConfig.mockReset().mockResolvedValue({
    partition: "persist:t3-preview-work",
    webPreferences: "contextIsolation=yes",
    preloadUrl: null,
  });
  stack.use(vi.spyOn(console, "error").mockImplementation(() => undefined));
  return stack.move();
}

// The webview releases its desktop tab on a timer after unmount; run it before the test ends
// so it cannot land in the next one.
async function renderHost(ui: ReactNode) {
  await using stack = new AsyncDisposableStack();
  const screen = stack.use(await render(ui));
  stack.defer(async () => {
    using _timers = fakeTimers();
    await screen.unmount();
    await vi.advanceTimersByTimeAsync(0);
  });
  const environment = stack.move();
  return Object.assign(screen, { [Symbol.asyncDispose]: () => environment.disposeAsync() });
}

describe("HostedBrowserWebview port spaces", () => {
  it("scopes the session to the thread and waits for the tunnel ticket before mounting", async () => {
    using _setup = setup();
    mocks.portSpace.enabled = true;
    mocks.portSpace.settled = false;
    mocks.getClientSettings.mockResolvedValue({ ...DEFAULT_CLIENT_SETTINGS });
    const threadRef = {
      environmentId: EnvironmentId.make("host-port-space"),
      threadId: ThreadId.make("thread-port-space"),
    };
    const element = () => (
      <HostedBrowserWebview
        threadRef={threadRef}
        tabId="server-tab"
        runtimeTabId="port-space-tab"
        initialUrl="http://localhost:3000"
        viewport={FILL_PREVIEW_VIEWPORT}
        pictureInPicture={false}
        profileId={undefined}
        zoomFactor={1}
      />
    );

    await using screen = await renderHost(element());
    await act(() => ensureClientSettingsHydrated());
    const guest = () => screen.container.querySelector("webview");

    expect(mocks.getPreviewConfig).toHaveBeenCalledExactlyOnceWith(
      threadRef.environmentId,
      undefined,
      threadRef.threadId,
    );
    expect(guest()).toBeNull();

    mocks.portSpace.settled = true;
    await screen.rerender(element());

    expect(screen.container.querySelectorAll("webview")).toHaveLength(1);
    expect(guest()?.getAttribute("partition")).toBe("persist:t3-preview-work");
    expect(guest()?.getAttribute("src")).toBe("http://localhost:3000");
  });
});
