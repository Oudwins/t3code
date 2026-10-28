import type { ToolCallDiffTarget } from "../../diffPanelStore";
import type { ThreadPreviewState } from "../../previewStateStore";
import { formatFilePathForClipboard } from "@t3tools/client-runtime/media-actions";
import { resolvePathLinkTarget } from "@t3tools/shared/fileLinks";
import { resolveExplicitDiffOpenOnActivate } from "../ChatView.logic";
import { useStableCallback } from "../../hooks/useStableCallback";
import { type ScopedThreadRef, type RunId } from "@t3tools/contracts";
import { useEffect } from "react";
import { useDiffPanelStore } from "../../diffPanelStore";
import { type ThreadPanelPresentation } from "../../rightPanelLayout";
import {
  selectActiveRightPanel,
  selectThreadPanelOpen,
  type RightPanelSurface,
  useRightPanelStore,
} from "../../rightPanelStore";
import { requestWorkspaceContentFocus, requestWorkspaceFocus } from "../../lib/workspaceFocus";
import { focusActivePanelTerminal } from "../../lib/terminalFocus";
import { subscribePreviewAction } from "../preview/previewActionBus";
import { floatDeviceSurface } from "../preview/agentOpenedPreviews";
import { browserMiniPlayerSource, usePreviewMiniPlayerStore } from "../../previewMiniPlayerStore";
import type { useDeviceState } from "../../state/device";
import { stackedThreadToast, toastManager } from "../ui/toast";
import type { useSurfaceGroupActions } from "../useSurfaceGroupActions";
import type { ChatShortcutCommands } from "./useChatShortcuts";

interface RightPanelActionsInput {
  readonly activeThreadRef: ScopedThreadRef | null;
  /** The side panel's surface actions; the tabs have their own group. */
  readonly sideActions: ReturnType<typeof useSurfaceGroupActions>;
  readonly activeRightPanelSurface: RightPanelSurface | null;
  readonly activePreviewState: ThreadPreviewState;
  readonly deviceState: ReturnType<typeof useDeviceState>["state"];
  readonly deviceStateLoaded: boolean;
  readonly threadPanelPresentation: ThreadPanelPresentation;
  readonly isServerThread: boolean;
  readonly browserAvailable: boolean;
  readonly canOperatePreview: boolean;
  readonly diffOpen: boolean;
  readonly previewPanelOpen: boolean;
  readonly rightPanelOpen: boolean;
  readonly canMaximizeRightPanel: boolean;
  readonly rightPanelMaximized: boolean;
  readonly gitCwd: string | null;
  readonly activeProjectCwd: string | null;
  readonly explicitDiffOpenRef: { current: ScopedThreadRef | null };
  readonly onDiffPanelOpen: (() => void) | undefined;
}

/**
 * Showing, sizing, and arranging the right panel. Opening and closing its surfaces goes
 * through the panel's surface group actions.
 */
export function useRightPanelActions(input: RightPanelActionsInput) {
  const {
    activeThreadRef,
    sideActions,
    activeRightPanelSurface,
    activePreviewState,
    deviceState,
    deviceStateLoaded,
    threadPanelPresentation,
    isServerThread,
    browserAvailable,
    canOperatePreview,
    diffOpen,
    previewPanelOpen,
    rightPanelOpen,
    canMaximizeRightPanel,
    rightPanelMaximized,
    gitCwd,
    activeProjectCwd,
    explicitDiffOpenRef,
    onDiffPanelOpen,
  } = input;

  const onToggleDiff = () => {
    if (!isServerThread) {
      return;
    }
    if (!diffOpen) {
      onDiffPanelOpen?.();
    }
    if (activeThreadRef) {
      useRightPanelStore.getState().toggle(activeThreadRef, "diff");
    }
  };
  const onToggleDiffStable = useStableCallback(onToggleDiff);
  const closePreviewPanel = () => {
    if (activeThreadRef) {
      if (activeRightPanelSurface?.kind === "preview" && activeRightPanelSurface.resourceId) {
        usePreviewMiniPlayerStore
          .getState()
          .open(activeThreadRef, browserMiniPlayerSource(activeRightPanelSurface.resourceId));
      } else if (activeRightPanelSurface?.kind === "device" && activeRightPanelSurface.target) {
        floatDeviceSurface(
          activeThreadRef,
          { kind: "device", ...activeRightPanelSurface.target },
          deviceStateLoaded ? deviceState : null,
        );
      }
      useRightPanelStore.getState().setMaximized(activeThreadRef, false);
      useRightPanelStore.getState().close(activeThreadRef);
    }
  };
  const closePreviewPanelStable = useStableCallback(closePreviewPanel);
  const togglePreviewPanel = () => {
    if (!activeThreadRef || !browserAvailable) return;
    if (previewPanelOpen) {
      closePreviewPanel();
      return;
    }
    if (!canOperatePreview) return;
    const activeTabId = activePreviewState.activeTabId;
    if (activeTabId) {
      useRightPanelStore.getState().openBrowser(activeThreadRef, activeTabId);
    } else {
      sideActions.addBrowser();
    }
  };
  const togglePreviewPanelStable = useStableCallback(togglePreviewPanel);
  const activateRightPanelSurface = (surface: RightPanelSurface) => {
    if (activeThreadRef) {
      explicitDiffOpenRef.current = resolveExplicitDiffOpenOnActivate({
        surfaceKind: surface.kind,
        diffOpen,
        activeThreadRef,
      });
    }
    sideActions.activate(surface);
  };
  const activateRightPanelSurfaceStable = useStableCallback(activateRightPanelSurface);
  const toggleRightPanel = () => {
    if (!activeThreadRef) return;
    if (rightPanelOpen) {
      closePreviewPanel();
      return;
    }
    useRightPanelStore.getState().toggleVisibility(activeThreadRef);
    focusActivePanelTerminal(activeThreadRef);
  };
  const toggleRightPanelStable = useStableCallback(toggleRightPanel);
  const toggleThreadPanel = () => {
    if (!activeThreadRef) return;
    const store = useRightPanelStore.getState();
    if (threadPanelPresentation === "inline") {
      const open = selectThreadPanelOpen(
        store.threadPanelVisibilityByThreadKey,
        activeThreadRef,
        "inline",
      );
      if (!open) requestWorkspaceFocus({ area: "details" });
      else if (document.activeElement?.closest('[data-workspace-area="details"]'))
        requestWorkspaceContentFocus();
    }
    store.toggleThreadPanel(activeThreadRef, threadPanelPresentation);
  };
  const toggleThreadPanelStable = useStableCallback(toggleThreadPanel);
  const toggleRightPanelMaximized = () => {
    if (!canMaximizeRightPanel || !activeThreadRef) return;
    if (!rightPanelMaximized) requestWorkspaceFocus({ area: "panel" });
    useRightPanelStore.getState().setMaximized(activeThreadRef, !rightPanelMaximized);
  };
  const toggleRightPanelMaximizedStable = useStableCallback(toggleRightPanelMaximized);
  const moveRightPanelSurface = (surfaceId: string, toIndex: number) => {
    if (activeThreadRef)
      useRightPanelStore.getState().moveSurface(activeThreadRef, surfaceId, toIndex);
  };
  const moveRightPanelSurfaceStable = useStableCallback(moveRightPanelSurface);
  const copyRightPanelFilePath = (relativePath: string) => {
    if (typeof window === "undefined" || !navigator.clipboard?.writeText) {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Failed to copy path",
          description: "Clipboard API unavailable.",
        }),
      );
      return;
    }

    const clipboardPath = formatFilePathForClipboard(
      relativePath,
      resolvePathLinkTarget(relativePath, gitCwd ?? activeProjectCwd ?? ""),
    );
    void navigator.clipboard.writeText(clipboardPath).then(
      () => {
        toastManager.add({
          type: "success",
          title: "Path copied",
          description: clipboardPath,
        });
      },
      (error) => {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Failed to copy path",
            description: error instanceof Error ? error.message : "An error occurred.",
          }),
        );
      },
    );
  };
  const copyRightPanelFilePathStable = useStableCallback(copyRightPanelFilePath);
  const onOpenTurnDiff = (runId: RunId, filePath?: string) => {
    if (!isServerThread || !activeThreadRef) return;
    const diffOpen =
      selectActiveRightPanel(useRightPanelStore.getState().byThreadKey, activeThreadRef) === "diff";
    explicitDiffOpenRef.current = diffOpen ? null : activeThreadRef;
    useDiffPanelStore.getState().selectTurn(activeThreadRef, runId, filePath);
    useRightPanelStore.getState().open(activeThreadRef, "diff");
    onDiffPanelOpen?.();
  };
  const onOpenToolDiffStable = useStableCallback((target: ToolCallDiffTarget) => {
    if (!isServerThread || !activeThreadRef) return;
    const diffOpen =
      selectActiveRightPanel(useRightPanelStore.getState().byThreadKey, activeThreadRef) === "diff";
    explicitDiffOpenRef.current = diffOpen ? null : activeThreadRef;
    useDiffPanelStore.getState().selectToolCall(activeThreadRef, target);
    useRightPanelStore.getState().open(activeThreadRef, "diff");
    onDiffPanelOpen?.();
  });
  const onOpenTurnDiffStable = useStableCallback(onOpenTurnDiff);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- subscribes to the preview action bus to toggle the preview panel
  useEffect(
    () =>
      subscribePreviewAction((action) => {
        if (action === "toggle-panel") togglePreviewPanelStable();
      }),
    [togglePreviewPanelStable],
  );

  const shortcuts = {
    "rightPanel.toggle": () => toggleRightPanel(),
    "rightPanel.toggleMaximized": ({ event }) => {
      if (!event.repeat) toggleRightPanelMaximized();
    },
    "threadPanel.toggle": () => toggleThreadPanel(),
    "rightPanel.close": ({ event }) => {
      if (!activeRightPanelSurface) return false;
      if (!event.repeat) sideActions.close(activeRightPanelSurface);
    },
    "diff.toggle": () => onToggleDiff(),
  } satisfies ChatShortcutCommands;

  return {
    shortcuts,
    activateRightPanelSurfaceStable,
    closePreviewPanelStable,
    copyRightPanelFilePathStable,
    moveRightPanelSurfaceStable,
    onOpenToolDiffStable,
    onOpenTurnDiffStable,
    onToggleDiffStable,
    toggleRightPanelMaximizedStable,
    toggleRightPanelStable,
    toggleThreadPanelStable,
  };
}
