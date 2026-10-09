import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { NewThreadTab, PreviewSessionSnapshot, ScopedThreadRef } from "@t3tools/contracts";
import { projectScriptRuntimeEnv } from "@t3tools/shared/projectScripts";
import { getTerminalLabel, nextTerminalId } from "@t3tools/shared/terminalLabels";
import { useCallback } from "react";

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
 * resources the surfaces point at always belong to the thread.
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

  const openBrowserTab = useCallback(
    async (profileId?: string) => {
      if (!threadRef || !groupRef) return;
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
    },
    [groupRef, openPreview, threadRef],
  );
  const addBrowser = useCallback(
    (profileId?: string) => {
      void openBrowserTab(profileId);
    },
    [openBrowserTab],
  );
  const addDiff = useCallback(() => {
    if (!groupRef || !threadRef || !isServerThread || !isGitRepo) return;
    useDiffPanelStore.getState().selectGitScope(threadRef, "branch");
    useRightPanelStore.getState().open(groupRef, "diff");
    onDiffPanelOpen?.();
  }, [groupRef, isGitRepo, isServerThread, onDiffPanelOpen, threadRef]);
  const addFiles = useCallback(() => {
    if (!groupRef || !project) return;
    useRightPanelStore.getState().open(groupRef, "files");
  }, [groupRef, project]);
  const addPullRequest = useCallback(() => {
    if (!supportsPullRequests || groupRef === null || pullRequestPanelTarget === null) return;
    useRightPanelStore.getState().openPullRequest(groupRef, pullRequestPanelTarget);
  }, [groupRef, pullRequestPanelTarget, supportsPullRequests]);
  const addPullRequests = useCallback(() => {
    if (!groupRef || !pullRequestsSurfaceAvailable) return;
    useRightPanelStore.getState().open(groupRef, "pull-requests");
  }, [groupRef, pullRequestsSurfaceAvailable]);
  const addDevice = useCallback(() => {
    if (!groupRef) return;
    if (deviceSetupRequired) {
      onRequestDeviceSetup();
      return;
    }
    useRightPanelStore.getState().open(groupRef, "device");
  }, [deviceSetupRequired, groupRef, onRequestDeviceSetup]);

  const openTerminalTab = useCallback(
    (terminalId: string) => {
      if (!groupRef || !threadRef || !project) return;
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
    },
    [gitCwd, groupRef, openTerminal, project, threadRef, worktreePath],
  );
  const addTerminal = useCallback(() => {
    if (!groupRef || !threadRef || !project) return;
    openTerminalTab(nextTerminalId(allocatableTerminalIds));
    requestTerminalFocus();
  }, [allocatableTerminalIds, groupRef, openTerminalTab, project, requestTerminalFocus, threadRef]);
  const seedTabs = useCallback(
    (entries: readonly NewThreadTab[]) => {
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
    },
    [addDiff, addFiles, allocatableTerminalIds, groupRef, openBrowserTab, openTerminalTab],
  );
  const splitTerminal = useCallback(
    (direction: "horizontal" | "vertical" = "horizontal") => {
      if (
        !groupRef ||
        !threadRef ||
        !project ||
        activeSurface?.kind !== "terminal" ||
        activeSurface.terminalIds.length >= MAX_TERMINALS_PER_GROUP
      ) {
        return;
      }
      const terminalId = nextTerminalId(allocatableTerminalIds);
      const cwd = gitCwd ?? project.workspaceRoot;
      useRightPanelStore
        .getState()
        .splitTerminal(groupRef, activeSurface.id, terminalId, direction);
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
    },
    [
      activeSurface,
      allocatableTerminalIds,
      gitCwd,
      groupRef,
      openTerminal,
      project,
      requestTerminalFocus,
      threadRef,
      worktreePath,
    ],
  );
  const splitTerminalVertical = useCallback(() => {
    splitTerminal("vertical");
  }, [splitTerminal]);
  const activateTerminal = useCallback(
    (terminalId: string) => {
      if (!groupRef || activeSurface?.kind !== "terminal") return;
      useRightPanelStore.getState().activateTerminal(groupRef, activeSurface.id, terminalId);
      requestTerminalFocus();
    },
    [activeSurface, groupRef, requestTerminalFocus],
  );
  const closeTerminal = useCallback(
    (terminalId: string) => {
      if (!groupRef || !threadRef || activeSurface?.kind !== "terminal") return;
      void closeTerminalMutation({
        environmentId: threadRef.environmentId,
        input: { threadId: threadRef.threadId, terminalId, deleteHistory: true },
      });
      storeCloseTerminal(threadRef, terminalId);
      useRightPanelStore.getState().closeTerminal(groupRef, activeSurface.id, terminalId);
      requestTerminalFocus();
    },
    [
      activeSurface,
      closeTerminalMutation,
      groupRef,
      requestTerminalFocus,
      storeCloseTerminal,
      threadRef,
    ],
  );
  const requestCloseTerminal = useCallback(
    (terminalId: string) => {
      const label = terminalLabelsById.get(terminalId) ?? getTerminalLabel(terminalId);
      void confirmTerminalClose([label]).then((confirmed) => {
        if (confirmed) closeTerminal(terminalId);
      });
    },
    [closeTerminal, terminalLabelsById],
  );

  const activate = useCallback(
    (surface: RightPanelSurface) => {
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
    },
    [diffOpen, groupRef, onDiffPanelOpen, requestTerminalFocus, threadRef],
  );

  const cleanupSurfaces = useCallback(
    (closing: readonly RightPanelSurface[]) => {
      if (!threadRef) return;
      for (const surface of closing) {
        if (surface.kind === "preview" && surface.resourceId) {
          void closePreviewSession({
            closePreview,
            snapshot: previewSessions[surface.resourceId] ?? null,
            tabId: surface.resourceId,
            threadRef,
          });
        }
        if (surface.kind === "terminal") {
          for (const terminalId of surface.terminalIds) {
            storeCloseTerminal(threadRef, terminalId);
            void closeTerminalMutation({
              environmentId: threadRef.environmentId,
              input: { threadId: threadRef.threadId, terminalId, deleteHistory: true },
            });
          }
        }
      }
    },
    [closePreview, closeTerminalMutation, previewSessions, storeCloseTerminal, threadRef],
  );
  const closeAfterAgentBrowserConfirmation = useCallback(
    (closing: readonly RightPanelSurface[], closeSurfaces: () => void) => {
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
    },
    [previewDesktopByTabId],
  );
  const syncActivePreviewSurface = useCallback(() => {
    if (!groupRef || !threadRef) return;
    const nextActiveSurface = selectActiveRightPanelSurface(
      useRightPanelStore.getState().byThreadKey,
      groupRef,
    );
    if (nextActiveSurface?.kind === "preview" && nextActiveSurface.resourceId) {
      setActivePreviewTab(threadRef, nextActiveSurface.resourceId);
    }
  }, [groupRef, threadRef]);
  const finishClose = useCallback(
    (closing: readonly RightPanelSurface[]) => {
      if (!groupRef) return;
      cleanupSurfaces(closing);
      const store = useRightPanelStore.getState();
      for (const surface of closing) {
        store.closeSurface(groupRef, surface.id);
      }
      syncActivePreviewSurface();
    },
    [cleanupSurfaces, groupRef, syncActivePreviewSurface],
  );
  const close = useCallback(
    (surface: RightPanelSurface) => {
      if (!groupRef) return;
      const finish = () => finishClose([surface]);
      if (surface.kind === "preview") {
        closeAfterAgentBrowserConfirmation([surface], finish);
        return;
      }
      if (surface.kind !== "terminal") {
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
    },
    [closeAfterAgentBrowserConfirmation, finishClose, groupRef, terminalLabelsById],
  );
  const closeOthers = useCallback(
    (surface: RightPanelSurface) => {
      if (!groupRef) return;
      const closing = surfaces.filter((entry) => entry.id !== surface.id);
      closeAfterAgentBrowserConfirmation(closing, () => finishClose(closing));
    },
    [closeAfterAgentBrowserConfirmation, finishClose, groupRef, surfaces],
  );
  const closeToRight = useCallback(
    (surface: RightPanelSurface) => {
      if (!groupRef) return;
      const surfaceIndex = surfaces.findIndex((entry) => entry.id === surface.id);
      if (surfaceIndex < 0) return;
      const closing = surfaces.slice(surfaceIndex + 1);
      closeAfterAgentBrowserConfirmation(closing, () => finishClose(closing));
    },
    [closeAfterAgentBrowserConfirmation, finishClose, groupRef, surfaces],
  );
  const closeAll = useCallback(() => {
    if (!groupRef) return;
    closeAfterAgentBrowserConfirmation(surfaces, () => finishClose(surfaces));
  }, [closeAfterAgentBrowserConfirmation, finishClose, groupRef, surfaces]);

  return {
    addBrowser,
    addDiff,
    addFiles,
    addPullRequest,
    addPullRequests,
    addDevice,
    addTerminal,
    seedTabs,
    splitTerminal,
    splitTerminalVertical,
    activateTerminal,
    closeTerminal,
    requestCloseTerminal,
    activate,
    close,
    closeOthers,
    closeToRight,
    closeAll,
  };
}
