import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  AuthPreviewOperateScope,
  AuthTerminalOperateScope,
  type NewThreadTab,
  type PreviewSessionSnapshot,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { projectScriptRuntimeEnv } from "@t3tools/shared/projectScripts";
import { getTerminalLabel, nextTerminalId } from "@t3tools/shared/terminalLabels";
import { readEnvironmentScope } from "../state/session";
import { useMemo } from "react";

import { BrowserSettingsReadError } from "../browser/openFileInPreview";
import { useDiffPanelStore } from "../diffPanelStore";
import { confirmTerminalClose } from "../lib/terminalCloseConfirm";
import { readLocalApi } from "../localApi";
import {
  isPreviewSupportedInRuntime,
  setActivePreviewTab,
  type DesktopPreviewOverlay,
} from "../previewStateStore";
import {
  selectActiveRightPanelSurface,
  useRightPanelStore,
  type RightPanelSurface,
} from "../rightPanelStore";
import { previewEnvironment } from "../state/preview";
import { terminalEnvironment } from "../state/terminal";
import { useAtomCommand } from "../state/use-atom-command";
import { useStableCallback } from "../hooks/useStableCallback";
import { useTerminalUiStateStore } from "../terminalUiStateStore";
import { MAX_TERMINALS_PER_GROUP } from "../types";
import { agentControlledBrowserCloseConfirmation } from "./ChatView.logic";
import type { threadPullRequestPanelTarget } from "./pullRequest/pullRequestDetail.logic";
import { addBrowserSurface } from "./preview/addBrowserSurface";
import { closePreviewSession } from "./preview/closePreviewSession";
import { seedThreadTabs } from "./seedThreadTabs";
import { stackedThreadToast, toastManager } from "./ui/toast";

interface SurfaceGroupInput {
  /** Store key of the group whose surfaces these actions open, activate and close. */
  groupRef: ScopedThreadRef | null;
  /** Thread that owns the resources (terminals, browser sessions) the surfaces point at. */
  threadRef: ScopedThreadRef | null;
  surfaces: readonly RightPanelSurface[];
  activeSurface: RightPanelSurface | null;
  project: { readonly workspaceRoot: string } | null | undefined;
  /** Where new terminals start: the checkout's git root when known, else the project root. */
  gitCwd: string | null;
  worktreePath: string | null;
  /** Every terminal id the thread has used, so a new one never collides. */
  allocatableTerminalIds: readonly string[];
  terminalLabelsById: ReadonlyMap<string, string>;
  requestTerminalFocus: () => void;
  previewSessions: Readonly<Record<string, PreviewSessionSnapshot>>;
  previewDesktopByTabId: Readonly<Record<string, DesktopPreviewOverlay>>;
  isServerThread: boolean;
  isGitRepo: boolean;
  /** Whether a diff is already showing, so activating one only announces the first. */
  diffOpen: boolean;
  onDiffPanelOpen: (() => void) | undefined;
  supportsPullRequests: boolean;
  pullRequestsSurfaceAvailable: boolean;
  pullRequestPanelTarget: ReturnType<typeof threadPullRequestPanelTarget>;
  deviceSetupRequired: boolean;
  onRequestDeviceSetup: () => void;
}

/**
 * Opens, activates and closes the surfaces of one group (the side panel or the
 * main-area tabs). The group only decides which store entry is mutated; the
 * resources the surfaces point at always belong to the thread. The returned
 * actions keep one identity for the life of the component.
 */
export function useSurfaceGroupActions(input: SurfaceGroupInput) {
  const {
    groupRef,
    threadRef,
    surfaces,
    activeSurface,
    project,
    gitCwd,
    worktreePath,
    allocatableTerminalIds,
    terminalLabelsById,
    requestTerminalFocus,
    previewSessions,
    previewDesktopByTabId,
    isServerThread,
    isGitRepo,
    diffOpen,
    onDiffPanelOpen,
    supportsPullRequests,
    pullRequestsSurfaceAvailable,
    pullRequestPanelTarget,
    deviceSetupRequired,
    onRequestDeviceSetup,
  } = input;
  const openPreview = useAtomCommand(previewEnvironment.open, { reportFailure: false });
  const closePreview = useAtomCommand(previewEnvironment.close, "preview close");
  const openTerminal = useAtomCommand(terminalEnvironment.open, "terminal open");
  const closeTerminalMutation = useAtomCommand(terminalEnvironment.close, "terminal close");
  const storeCloseTerminal = useTerminalUiStateStore((state) => state.closeTerminal);

  const openBrowserTab = async (profileId?: string) => {
    if (
      !threadRef ||
      !groupRef ||
      !readEnvironmentScope(threadRef.environmentId, AuthPreviewOperateScope)
    )
      return;
    const result = await addBrowserSurface({
      threadRef,
      groupRef,
      openPreview,
      ...(profileId === undefined ? {} : { profileId }),
    });
    if (result._tag !== "Failure" || isAtomCommandInterrupted(result)) return;
    const error = squashAtomCommandFailure(result);
    if (error instanceof BrowserSettingsReadError) {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Unable to open browser",
          description: error.message,
        }),
      );
    }
  };
  const addBrowser = (profileId?: string) => {
    void openBrowserTab(profileId);
  };
  const addDiff = () => {
    if (!groupRef || !threadRef || !isServerThread || !isGitRepo) return;
    useDiffPanelStore.getState().selectGitScope(threadRef, "branch");
    useRightPanelStore.getState().open(groupRef, "diff");
    onDiffPanelOpen?.();
  };
  const addFiles = () => {
    if (!groupRef || !project) return;
    useRightPanelStore.getState().open(groupRef, "files");
  };
  const addPullRequest = () => {
    if (!supportsPullRequests || groupRef === null || pullRequestPanelTarget === null) return;
    useRightPanelStore.getState().openPullRequest(groupRef, pullRequestPanelTarget);
  };
  const addPullRequests = () => {
    if (!groupRef || !pullRequestsSurfaceAvailable) return;
    useRightPanelStore.getState().open(groupRef, "pull-requests");
  };
  const addDevice = () => {
    if (!groupRef) return;
    if (deviceSetupRequired) {
      onRequestDeviceSetup();
      return;
    }
    useRightPanelStore.getState().open(groupRef, "device");
  };

  const openTerminalTab = (terminalId: string) => {
    if (
      !groupRef ||
      !threadRef ||
      !project ||
      !readEnvironmentScope(threadRef.environmentId, AuthTerminalOperateScope)
    )
      return;
    const cwd = gitCwd ?? project.workspaceRoot;
    useRightPanelStore.getState().openTerminal(groupRef, terminalId);
    void openTerminal({
      environmentId: threadRef.environmentId,
      input: {
        threadId: threadRef.threadId,
        terminalId,
        cwd,
        ...(worktreePath != null ? { worktreePath } : {}),
        env: projectScriptRuntimeEnv({
          project: { cwd: project.workspaceRoot },
          worktreePath,
        }),
      },
    });
  };
  const addTerminal = () => {
    if (
      !groupRef ||
      !threadRef ||
      !project ||
      !readEnvironmentScope(threadRef.environmentId, AuthTerminalOperateScope)
    )
      return;
    openTerminalTab(nextTerminalId(allocatableTerminalIds));
    requestTerminalFocus();
  };
  const seedTabs = (entries: readonly NewThreadTab[]) => {
    if (!groupRef || entries.length === 0) return Promise.resolve();
    return seedThreadTabs({
      entries,
      usedTerminalIds: allocatableTerminalIds,
      open: {
        terminal: openTerminalTab,
        files: addFiles,
        diff: addDiff,
        browser: isPreviewSupportedInRuntime() ? () => openBrowserTab() : null,
      },
      settle: () => useRightPanelStore.getState().close(groupRef),
    });
  };
  const splitTerminal = (direction: "horizontal" | "vertical" = "horizontal") => {
    if (
      !groupRef ||
      !threadRef ||
      !readEnvironmentScope(threadRef.environmentId, AuthTerminalOperateScope) ||
      !project ||
      activeSurface?.kind !== "terminal" ||
      activeSurface.terminalIds.length >= MAX_TERMINALS_PER_GROUP
    ) {
      return;
    }
    const terminalId = nextTerminalId(allocatableTerminalIds);
    const cwd = gitCwd ?? project.workspaceRoot;
    useRightPanelStore.getState().splitTerminal(groupRef, activeSurface.id, terminalId, direction);
    requestTerminalFocus();
    void openTerminal({
      environmentId: threadRef.environmentId,
      input: {
        threadId: threadRef.threadId,
        terminalId,
        cwd,
        ...(worktreePath != null ? { worktreePath } : {}),
        env: projectScriptRuntimeEnv({
          project: { cwd: project.workspaceRoot },
          worktreePath,
        }),
      },
    });
  };
  const splitTerminalVertical = () => {
    splitTerminal("vertical");
  };
  const activateTerminal = (terminalId: string) => {
    if (!groupRef || activeSurface?.kind !== "terminal") return;
    useRightPanelStore.getState().activateTerminal(groupRef, activeSurface.id, terminalId);
    requestTerminalFocus();
  };
  const closeTerminal = (terminalId: string) => {
    if (
      !groupRef ||
      !threadRef ||
      !readEnvironmentScope(threadRef.environmentId, AuthTerminalOperateScope) ||
      activeSurface?.kind !== "terminal"
    )
      return;
    void closeTerminalMutation({
      environmentId: threadRef.environmentId,
      input: { threadId: threadRef.threadId, terminalId, deleteHistory: true },
    });
    storeCloseTerminal(threadRef, terminalId);
    useRightPanelStore.getState().closeTerminal(groupRef, activeSurface.id, terminalId);
    requestTerminalFocus();
  };
  const requestCloseTerminal = (terminalId: string) => {
    const label = terminalLabelsById.get(terminalId) ?? getTerminalLabel(terminalId);
    void confirmTerminalClose([label]).then((confirmed) => {
      if (confirmed) closeTerminal(terminalId);
    });
  };

  const activate = (surface: RightPanelSurface) => {
    if (!groupRef || !threadRef) return;
    useRightPanelStore.getState().activateSurface(groupRef, surface.id);
    if (surface.kind === "preview" && surface.resourceId) {
      setActivePreviewTab(threadRef, surface.resourceId);
    }
    if (surface.kind === "terminal") {
      requestTerminalFocus();
    }
    if (surface.kind === "diff" && !diffOpen) {
      onDiffPanelOpen?.();
    }
  };

  const cleanupSurfaces = (closing: readonly RightPanelSurface[]) => {
    if (!threadRef) return;
    for (const surface of closing) {
      if (
        readEnvironmentScope(threadRef.environmentId, AuthPreviewOperateScope) &&
        surface.kind === "preview" &&
        surface.resourceId
      ) {
        void closePreviewSession({
          closePreview,
          snapshot: previewSessions[surface.resourceId] ?? null,
          tabId: surface.resourceId,
          threadRef,
        });
      }
      if (
        surface.kind === "terminal" &&
        readEnvironmentScope(threadRef.environmentId, AuthTerminalOperateScope)
      ) {
        for (const terminalId of surface.terminalIds) {
          storeCloseTerminal(threadRef, terminalId);
          void closeTerminalMutation({
            environmentId: threadRef.environmentId,
            input: { threadId: threadRef.threadId, terminalId, deleteHistory: true },
          });
        }
      }
    }
  };
  const closeAfterAgentBrowserConfirmation = (
    closing: readonly RightPanelSurface[],
    closeSurfaces: () => void,
  ) => {
    const message = agentControlledBrowserCloseConfirmation(closing, previewDesktopByTabId);
    if (!message) {
      closeSurfaces();
      return;
    }
    const localApi = readLocalApi();
    if (!localApi) return;
    void localApi.dialogs.confirm(message, { variant: "destructive" }).then(
      (confirmed) => {
        if (confirmed) closeSurfaces();
      },
      () => undefined,
    );
  };
  const syncActivePreviewSurface = () => {
    if (!groupRef || !threadRef) return;
    const nextActiveSurface = selectActiveRightPanelSurface(
      useRightPanelStore.getState().byThreadKey,
      groupRef,
    );
    if (nextActiveSurface?.kind === "preview" && nextActiveSurface.resourceId) {
      setActivePreviewTab(threadRef, nextActiveSurface.resourceId);
    }
  };
  const finishClose = (closing: readonly RightPanelSurface[]) => {
    if (!groupRef) return;
    const store = useRightPanelStore.getState();
    const activeId = selectActiveRightPanelSurface(store.byThreadKey, groupRef)?.id;
    const ordered = closing.toSorted(
      (left, right) => Number(left.id === activeId) - Number(right.id === activeId),
    );
    for (const surface of ordered) {
      cleanupSurfaces([surface]);
      store.closeSurface(groupRef, surface.id);
    }
    syncActivePreviewSurface();
  };
  const close = (surface: RightPanelSurface) => {
    if (!groupRef) return;
    const finish = () => finishClose([surface]);
    if (surface.kind === "preview") {
      closeAfterAgentBrowserConfirmation([surface], finish);
      return;
    }
    if (
      surface.kind !== "terminal" ||
      !threadRef ||
      !readEnvironmentScope(threadRef.environmentId, AuthTerminalOperateScope)
    ) {
      finish();
      return;
    }
    const activeLabel =
      terminalLabelsById.get(surface.activeTerminalId) ??
      getTerminalLabel(surface.activeTerminalId);
    const otherLabels = surface.terminalIds
      .filter((terminalId) => terminalId !== surface.activeTerminalId)
      .map((terminalId) => terminalLabelsById.get(terminalId) ?? getTerminalLabel(terminalId));
    void confirmTerminalClose([activeLabel, ...otherLabels]).then((confirmed) => {
      if (confirmed) finish();
    });
  };
  const closeOthers = (surface: RightPanelSurface) => {
    if (!groupRef) return;
    const closing = surfaces.filter((entry) => entry.id !== surface.id);
    closeAfterAgentBrowserConfirmation(closing, () => finishClose(closing));
  };
  const closeToRight = (surface: RightPanelSurface) => {
    if (!groupRef) return;
    const surfaceIndex = surfaces.findIndex((entry) => entry.id === surface.id);
    if (surfaceIndex < 0) return;
    const closing = surfaces.slice(surfaceIndex + 1);
    closeAfterAgentBrowserConfirmation(closing, () => finishClose(closing));
  };
  const closeAll = () => {
    if (!groupRef) return;
    closeAfterAgentBrowserConfirmation(surfaces, () => finishClose(surfaces));
  };

  // Fixed identities, so the actions can go into props and dependency arrays
  // without keeping an old render alive (see useStableCallback).
  const addBrowserStable = useStableCallback(addBrowser);
  const addDiffStable = useStableCallback(addDiff);
  const addFilesStable = useStableCallback(addFiles);
  const addPullRequestStable = useStableCallback(addPullRequest);
  const addPullRequestsStable = useStableCallback(addPullRequests);
  const addDeviceStable = useStableCallback(addDevice);
  const addTerminalStable = useStableCallback(addTerminal);
  const seedTabsStable = useStableCallback(seedTabs);
  const splitTerminalStable = useStableCallback(splitTerminal);
  const splitTerminalVerticalStable = useStableCallback(splitTerminalVertical);
  const activateTerminalStable = useStableCallback(activateTerminal);
  const closeTerminalStable = useStableCallback(closeTerminal);
  const requestCloseTerminalStable = useStableCallback(requestCloseTerminal);
  const activateStable = useStableCallback(activate);
  const closeStable = useStableCallback(close);
  const closeOthersStable = useStableCallback(closeOthers);
  const closeToRightStable = useStableCallback(closeToRight);
  const closeAllStable = useStableCallback(closeAll);
  return useMemo(
    () => ({
      addBrowser: addBrowserStable,
      addDiff: addDiffStable,
      addFiles: addFilesStable,
      addPullRequest: addPullRequestStable,
      addPullRequests: addPullRequestsStable,
      addDevice: addDeviceStable,
      addTerminal: addTerminalStable,
      seedTabs: seedTabsStable,
      splitTerminal: splitTerminalStable,
      splitTerminalVertical: splitTerminalVerticalStable,
      activateTerminal: activateTerminalStable,
      closeTerminal: closeTerminalStable,
      requestCloseTerminal: requestCloseTerminalStable,
      activate: activateStable,
      close: closeStable,
      closeOthers: closeOthersStable,
      closeToRight: closeToRightStable,
      closeAll: closeAllStable,
    }),
    [
      addBrowserStable,
      addDiffStable,
      addFilesStable,
      addPullRequestStable,
      addPullRequestsStable,
      addDeviceStable,
      addTerminalStable,
      seedTabsStable,
      splitTerminalStable,
      splitTerminalVerticalStable,
      activateTerminalStable,
      closeTerminalStable,
      requestCloseTerminalStable,
      activateStable,
      closeStable,
      closeOthersStable,
      closeToRightStable,
      closeAllStable,
    ],
  );
}
