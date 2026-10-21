import { EnvironmentId, type VcsRef } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import {
  buildEnvironmentPaletteOptions,
  buildWorkspacePaletteOptions,
  dedupeRemoteBranchesWithLocalMatches,
  deriveLocalBranchNameFromRemoteRef,
  resolveBranchSelectionTarget,
  resolveDraftEnvModeAfterBranchChange,
  resolveEffectiveEnvMode,
  resolveBranchToolbarPrBranch,
  resolveLocalCheckoutBranchMismatch,
  sanitizeNewRefName,
  shouldIncludeBranchPickerItem,
} from "./BranchToolbar.logic";

const localEnvironmentId = EnvironmentId.make("environment-local");
const remoteEnvironmentId = EnvironmentId.make("environment-remote");

describe("buildEnvironmentPaletteOptions", () => {
  const environments = [
    {
      environmentId: localEnvironmentId,
      projectId: null,
      label: "MacBook",
      isPrimary: true,
      machine: "laptop" as const,
    },
    {
      environmentId: remoteEnvironmentId,
      projectId: null,
      label: "Build box",
      isPrimary: false,
      machine: "server" as const,
    },
  ];

  it("lists the environments, marks the current one, and reports the chosen id", () => {
    const select = vi.fn();
    const options = buildEnvironmentPaletteOptions({
      environments,
      environmentId: remoteEnvironmentId,
      autoEnvironmentLabel: undefined,
      onAutoEnvironment: undefined,
      select,
    });

    expect(options.map(({ id, description, selected }) => ({ id, description, selected }))).toEqual(
      [
        { id: localEnvironmentId, description: "This device", selected: false },
        { id: remoteEnvironmentId, description: null, selected: true },
      ],
    );
    options[0]?.select();
    expect(select.mock.calls).toEqual([[localEnvironmentId]]);
  });

  it("leads with auto balance and marks it current while it picks the environment", () => {
    const onAutoEnvironment = vi.fn();
    const options = buildEnvironmentPaletteOptions({
      environments,
      environmentId: remoteEnvironmentId,
      autoEnvironmentLabel: "Auto: Build box",
      onAutoEnvironment,
      select: () => {},
    });

    expect(options.map(({ id, label, selected }) => ({ id, label, selected }))).toEqual([
      { id: "auto", label: "Auto: Build box", selected: true },
      { id: localEnvironmentId, label: "MacBook", selected: false },
      { id: remoteEnvironmentId, label: "Build box", selected: false },
    ]);
    options[0]?.select();
    expect(onAutoEnvironment).toHaveBeenCalledOnce();
  });
});

describe("buildWorkspacePaletteOptions", () => {
  it("lists the dropdown choices and marks the current one", () => {
    const options = buildWorkspacePaletteOptions({
      activeWorktreePath: null,
      effectiveEnvMode: "local",
      previousWorktree: null,
      select: () => {},
    });

    expect(options.map(({ id, label, selected }) => ({ id, label, selected }))).toEqual([
      { id: "local", label: "Current checkout", selected: true },
      { id: "worktree", label: "New worktree", selected: false },
    ]);
  });

  it("offers the previous worktree with its branch and reports the chosen id", () => {
    const select = vi.fn();
    const options = buildWorkspacePaletteOptions({
      activeWorktreePath: "/wt/current",
      effectiveEnvMode: "local",
      previousWorktree: { branch: "t3/fix-thing", worktreePath: "/wt/previous" },
      select,
    });

    expect(options.map(({ id, label }) => ({ id, label }))).toEqual([
      { id: "local", label: "Current worktree" },
      { id: "worktree", label: "New worktree" },
      { id: "previous-worktree", label: "Previous worktree" },
    ]);
    expect(options[2]?.description).toBe("t3/fix-thing");

    options[1]?.select();
    options[2]?.select();
    expect(select.mock.calls).toEqual([["worktree"], ["previous-worktree"]]);
  });

  it("marks a new worktree as current when one is being created", () => {
    const options = buildWorkspacePaletteOptions({
      activeWorktreePath: null,
      effectiveEnvMode: "worktree",
      previousWorktree: null,
      select: () => {},
    });

    expect(options.find((option) => option.selected)?.id).toBe("worktree");
  });
});

describe("resolveDraftEnvModeAfterBranchChange", () => {
  it("switches to local mode when returning from an existing worktree to the main worktree", () => {
    expect(
      resolveDraftEnvModeAfterBranchChange({
        nextWorktreePath: null,
        currentWorktreePath: "/repo/.t3/worktrees/feature-a",
        effectiveEnvMode: "worktree",
      }),
    ).toBe("local");
  });

  it("uses worktree mode when selecting a ref already attached to a worktree", () => {
    expect(
      resolveDraftEnvModeAfterBranchChange({
        nextWorktreePath: "/repo/.t3/worktrees/feature-a",
        currentWorktreePath: null,
        effectiveEnvMode: "local",
      }),
    ).toBe("worktree");
  });
});

describe("resolveBranchToolbarPrBranch", () => {
  it("hides PR state while an optimistic branch switch is in flight", () => {
    expect(
      resolveBranchToolbarPrBranch({
        activeThreadBranch: "feature/current",
        resolvedActiveBranch: "feature/next",
      }),
    ).toBeNull();
  });
});

describe("resolveLocalCheckoutBranchMismatch", () => {
  it("detects when a local thread is associated with a different branch than the checkout", () => {
    expect(
      resolveLocalCheckoutBranchMismatch({
        effectiveEnvMode: "local",
        activeWorktreePath: null,
        activeThreadBranch: "feature/thread",
        currentGitBranch: "feature/current",
      }),
    ).toEqual({
      threadBranch: "feature/thread",
      currentBranch: "feature/current",
    });
  });

  it("ignores dedicated worktrees because their checkout is already thread-scoped", () => {
    expect(
      resolveLocalCheckoutBranchMismatch({
        effectiveEnvMode: "worktree",
        activeWorktreePath: "/repo/.t3/worktrees/feature-thread",
        activeThreadBranch: "feature/thread",
        currentGitBranch: "feature/current",
      }),
    ).toBeNull();
  });
});

describe("resolveEffectiveEnvMode", () => {
  it("keeps a server thread in worktree mode while its worktree is still being created", () => {
    expect(
      resolveEffectiveEnvMode({
        activeWorktreePath: null,
        hasServerThread: true,
        draftThreadEnvMode: undefined,
        preparingWorktree: true,
      }),
    ).toBe("worktree");
    expect(
      resolveEffectiveEnvMode({
        activeWorktreePath: null,
        hasServerThread: true,
        draftThreadEnvMode: undefined,
      }),
    ).toBe("local");
  });
});

describe("deriveLocalBranchNameFromRemoteRef", () => {
  it("supports remote names that contain slashes", () => {
    expect(deriveLocalBranchNameFromRemoteRef("my-org/upstream/feature/demo")).toBe(
      "upstream/feature/demo",
    );
  });
});

describe("dedupeRemoteBranchesWithLocalMatches", () => {
  it("hides remote refs when the matching local ref exists", () => {
    const input: VcsRef[] = [
      {
        name: "feature/demo",
        current: false,
        isDefault: false,
        worktreePath: null,
      },
      {
        name: "origin/feature/demo",
        isRemote: true,
        remoteName: "origin",
        current: false,
        isDefault: false,
        worktreePath: null,
      },
      {
        name: "origin/feature/remote-only",
        isRemote: true,
        remoteName: "origin",
        current: false,
        isDefault: false,
        worktreePath: null,
      },
    ];

    expect(dedupeRemoteBranchesWithLocalMatches(input).map((ref) => ref.name)).toEqual([
      "feature/demo",
      "origin/feature/remote-only",
    ]);
  });

  it("keeps non-origin remote refs visible when git tracks with first-slash local naming", () => {
    const input: VcsRef[] = [
      {
        name: "upstream/feature",
        current: false,
        isDefault: false,
        worktreePath: null,
      },
      {
        name: "my-org/upstream/feature",
        isRemote: true,
        remoteName: "my-org/upstream",
        current: false,
        isDefault: false,
        worktreePath: null,
      },
    ];

    expect(dedupeRemoteBranchesWithLocalMatches(input).map((ref) => ref.name)).toEqual([
      "upstream/feature",
      "my-org/upstream/feature",
    ]);
  });
});

describe("resolveBranchSelectionTarget", () => {
  it("reuses an existing secondary worktree for the selected ref", () => {
    expect(
      resolveBranchSelectionTarget({
        activeProjectCwd: "/repo",
        activeWorktreePath: "/repo/.t3/worktrees/feature-a",
        refName: {
          isDefault: false,
          worktreePath: "/repo/.t3/worktrees/feature-b",
        },
      }),
    ).toEqual({
      checkoutCwd: "/repo/.t3/worktrees/feature-b",
      nextWorktreePath: "/repo/.t3/worktrees/feature-b",
      reuseExistingWorktree: true,
    });
  });

  it("switches back to the main repo when the ref already lives there", () => {
    expect(
      resolveBranchSelectionTarget({
        activeProjectCwd: "/repo",
        activeWorktreePath: "/repo/.t3/worktrees/feature-a",
        refName: {
          isDefault: true,
          worktreePath: "/repo",
        },
      }),
    ).toEqual({
      checkoutCwd: "/repo",
      nextWorktreePath: null,
      reuseExistingWorktree: true,
    });
  });

  it("keeps checkout in the current worktree for non-default refs", () => {
    expect(
      resolveBranchSelectionTarget({
        activeProjectCwd: "/repo",
        activeWorktreePath: "/repo/.t3/worktrees/feature-a",
        refName: {
          isDefault: false,
          worktreePath: null,
        },
      }),
    ).toEqual({
      checkoutCwd: "/repo/.t3/worktrees/feature-a",
      nextWorktreePath: "/repo/.t3/worktrees/feature-a",
      reuseExistingWorktree: false,
    });
  });
});

describe("shouldIncludeBranchPickerItem", () => {
  it("keeps the synthetic checkout PR item visible for gh pr checkout input", () => {
    expect(
      shouldIncludeBranchPickerItem({
        itemValue: "__checkout_pull_request__:1359",
        normalizedQuery: "gh pr checkout 1359",
        createBranchItemValue: "__create_new_branch__:gh pr checkout 1359",
        checkoutPullRequestItemValue: "__checkout_pull_request__:1359",
      }),
    ).toBe(true);
  });

  it("surfaces an existing ref matching the sanitized query", () => {
    expect(
      shouldIncludeBranchPickerItem({
        itemValue: "new-branch",
        normalizedQuery: "new branch",
        createBranchItemValue: null,
        checkoutPullRequestItemValue: null,
      }),
    ).toBe(true);
  });
});

describe("sanitizeNewRefName", () => {
  it("collapses a run of whitespace into a single dash", () => {
    expect(sanitizeNewRefName("new   branch")).toBe("new-branch");
  });

  it("replaces tabs, which git rejects just like spaces", () => {
    expect(sanitizeNewRefName("new\tbranch")).toBe("new-branch");
  });

  it("preserves whitespace that git accepts", () => {
    expect(sanitizeNewRefName("new\u00a0branch")).toBe("new\u00a0branch");
    expect(sanitizeNewRefName("new\u2009branch")).toBe("new\u2009branch");
  });

  it("does not collapse dashes the user typed", () => {
    expect(sanitizeNewRefName("new - branch")).toBe("new---branch");
    expect(sanitizeNewRefName("foo--bar")).toBe("foo--bar");
  });
});
