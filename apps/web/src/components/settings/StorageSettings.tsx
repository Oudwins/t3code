import type {
  StorageCleanupSettings,
  WorktreeCleanupRules,
  WorktreeReuseSettings,
} from "@t3tools/contracts";
import { resolveWorktreeCleanup } from "@t3tools/shared/projectSettings";
import { useState } from "react";

import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import {
  NumberField,
  NumberFieldDecrement,
  NumberFieldGroup,
  NumberFieldIncrement,
  NumberFieldInput,
} from "../ui/number-field";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";
import { SettingsScopeNotice } from "./SettingsScopeNotice";
import type { ScopedSettingsTarget } from "./scopedSettings";
import { useSettingsScope } from "./SettingsScopeContext";
import {
  useClearScopedSettings,
  useScopedSettings,
  useUpdateScopedSettings,
} from "./useScopedSettings";

function UnitNumberField({
  label,
  unit,
  value,
  min,
  max,
  onChange,
}: {
  label: string;
  unit: string;
  value: number;
  min: number;
  max: number;
  onChange: (value: number) => void;
}) {
  const [draft, setDraft] = useState<number | null>(value);
  const [savedValue, setSavedValue] = useState(value);
  if (savedValue !== value) {
    setSavedValue(value);
    setDraft(value);
  }

  return (
    <NumberField
      value={draft}
      min={min}
      max={max}
      step={1}
      size="sm"
      className="w-auto"
      onValueChange={setDraft}
      onValueCommitted={(next) => {
        if (next === null) setDraft(value);
        else {
          const clamped = Math.min(max, Math.max(min, Math.round(next)));
          setDraft(clamped);
          onChange(clamped);
        }
      }}
    >
      <NumberFieldGroup>
        <NumberFieldDecrement aria-label={`Decrease ${label}`} />
        <NumberFieldInput
          aria-label={`${label} (${unit})`}
          size={new Intl.NumberFormat().format(draft ?? value).length}
          className="field-sizing-content w-auto min-w-[1ch] grow-0 text-right"
        />
        <span aria-hidden="true" className="self-center pr-2 text-xs">
          {unit}
        </span>
        <NumberFieldIncrement aria-label={`Increase ${label}`} />
      </NumberFieldGroup>
    </NumberField>
  );
}

function RetentionControl({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number | null;
  onChange: (value: number | null) => void;
}) {
  return (
    <div className="flex items-center gap-3">
      {value !== null ? (
        <UnitNumberField
          label={label}
          unit="days"
          value={value}
          min={1}
          max={3650}
          onChange={onChange}
        />
      ) : (
        <span className="text-xs text-muted-foreground">Off</span>
      )}
      <Switch
        aria-label={label}
        checked={value !== null}
        onCheckedChange={(enabled) => onChange(enabled ? 8 : null)}
      />
    </div>
  );
}

export function StorageSettingsPanel() {
  const { scope, connectedEnvironments, targets, target } = useSettingsScope();
  const scopedSettings = useScopedSettings();
  const isProjectScope = scope.kind === "project" || scope.kind === "checkout";
  const settings = {
    ...scopedSettings.storageCleanup,
    ...resolveWorktreeCleanup(scopedSettings, null),
  };
  const projectMode = (entry: ScopedSettingsTarget | null) =>
    entry?.sources.worktreeCleanup === "project"
      ? (entry.settings.worktreeCleanup?.mode ?? "inherit")
      : "inherit";
  const mode = projectMode(target);
  const mixedModes = targets.some((entry) => projectMode(entry) !== mode);
  const updateSettings = useUpdateScopedSettings();
  const clearSettings = useClearScopedSettings();
  const ruleStatus = (key: keyof StorageCleanupSettings) =>
    targets.some(
      (target) =>
        ({ ...target.settings.storageCleanup, ...resolveWorktreeCleanup(target.settings, null) })[
          key
        ] !== settings[key],
    )
      ? "Mixed across selected machines"
      : undefined;
  const update = (patch: Partial<StorageCleanupSettings>) =>
    updateSettings({ storageCleanup: patch });
  const updateWorktree = (patch: Partial<WorktreeCleanupRules>) =>
    isProjectScope
      ? updateSettings({ worktreeCleanup: { mode: "custom", rules: patch } })
      : update(patch);
  const reuse = scopedSettings.worktreeReuse;
  const reuseStatus = (key: keyof WorktreeReuseSettings) =>
    targets.some((target) => target.settings.worktreeReuse[key] !== reuse[key])
      ? "Mixed across selected machines"
      : undefined;
  const updateReuse = (patch: Partial<WorktreeReuseSettings>) =>
    updateSettings({ worktreeReuse: patch });
  const reuseSupported = connectedEnvironments.every(
    (environment) => environment.serverConfig?.environment.capabilities.worktreeReuse === true,
  );

  if (
    isProjectScope &&
    connectedEnvironments.some(
      (environment) =>
        environment.serverConfig?.environment.capabilities.projectWorktreeCleanup !== true,
    )
  ) {
    return (
      <SettingsScopeNotice target="all">
        Update the selected machines to configure project worktree cleanup.
      </SettingsScopeNotice>
    );
  }

  if (
    connectedEnvironments.some(
      (environment) => environment.serverConfig?.environment.capabilities.storageCleanup !== true,
    )
  ) {
    return (
      <SettingsScopeNotice
        target="environment"
        eligibleEnvironmentIds={connectedEnvironments
          .filter(
            (environment) =>
              environment.serverConfig?.environment.capabilities.storageCleanup === true,
          )
          .map((environment) => environment.environmentId)}
      >
        Update the selected environments to use storage cleanup, or choose a machine that supports
        it.
      </SettingsScopeNotice>
    );
  }

  return (
    <SettingsPageContainer>
      <SettingsSection id="storage-worktrees" title="Worktrees">
        {isProjectScope && (
          <SettingsRow
            title="Automatic worktree cleanup"
            description={
              mode === "off"
                ? "Keep this project's worktrees until you delete them manually."
                : mode === "custom"
                  ? "Use these rules for this project."
                  : "Use each machine's worktree cleanup settings."
            }
            serverScoped
            settingKeys={["worktreeCleanup"]}
            mixed={mixedModes}
            control={
              <Select
                value={mixedModes ? null : mode}
                onValueChange={(next) => {
                  if (next === "inherit") clearSettings(["worktreeCleanup"]);
                  else if (next === "off") updateSettings({ worktreeCleanup: { mode: "off" } });
                  else if (next === "custom")
                    updateSettings({ worktreeCleanup: { mode: "custom", rules: {} } });
                }}
              >
                <SelectTrigger size="sm" aria-label="Automatic worktree cleanup">
                  <SelectValue>
                    {mixedModes
                      ? "Mixed"
                      : mode === "inherit"
                        ? "Inherit"
                        : mode === "off"
                          ? "Off"
                          : "Custom"}
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup align="end" alignItemWithTrigger={false}>
                  <SelectItem value="inherit">Inherit</SelectItem>
                  <SelectItem value="off">Off</SelectItem>
                  <SelectItem value="custom">Custom</SelectItem>
                </SelectPopup>
              </Select>
            }
          />
        )}
        {(!isProjectScope || (!mixedModes && mode === "custom")) && (
          <>
            <SettingsRow
              title="Delete worktrees with deleted threads"
              status={ruleStatus("worktreeOnDelete")}
              description="Remove worktrees when active or archived threads are deleted. Worktrees with local changes are kept unless deleting in-use worktrees is on."
              serverScoped={!isProjectScope}
              control={
                <Switch
                  aria-label="Delete worktrees with deleted threads"
                  checked={settings.worktreeOnDelete}
                  onCheckedChange={(worktreeOnDelete) => updateWorktree({ worktreeOnDelete })}
                />
              }
            />
            <SettingsRow
              title="Delete inactive worktrees"
              status={ruleStatus("worktreeAfterDays")}
              description="Remove worktrees after their threads have been inactive for this many days. Branches and thread history are kept."
              serverScoped={!isProjectScope}
              control={
                <RetentionControl
                  label="Delete inactive worktrees"
                  value={settings.worktreeAfterDays}
                  onChange={(worktreeAfterDays) => updateWorktree({ worktreeAfterDays })}
                />
              }
            />
            <SettingsRow
              title="Delete merged worktrees"
              status={ruleStatus("worktreeOnMerge")}
              description="Remove worktrees whose pull request is merged and whose commits are included in the default branch."
              serverScoped={!isProjectScope}
              control={
                <Switch
                  aria-label="Delete merged worktrees"
                  checked={settings.worktreeOnMerge}
                  onCheckedChange={(worktreeOnMerge) => updateWorktree({ worktreeOnMerge })}
                />
              }
            />
            <SettingsRow
              title="Delete unchanged worktrees"
              status={ruleStatus("worktreeUnchanged")}
              description="Remove worktrees with no commits beyond the default branch."
              serverScoped={!isProjectScope}
              control={
                <Switch
                  aria-label="Delete unchanged worktrees"
                  checked={settings.worktreeUnchanged}
                  onCheckedChange={(worktreeUnchanged) => updateWorktree({ worktreeUnchanged })}
                />
              }
            />
            <SettingsRow
              title="Delete even when in use"
              status={ruleStatus("worktreeForce")}
              description="For settled, archived, and deleted threads, also remove worktrees with uncommitted changes, ignored files, open terminals, or live sessions. Terminals and sessions are closed and uncommitted work is permanently lost."
              serverScoped={!isProjectScope}
              control={
                <Switch
                  aria-label="Delete even when in use"
                  checked={settings.worktreeForce}
                  onCheckedChange={(worktreeForce) => updateWorktree({ worktreeForce })}
                />
              }
            />
          </>
        )}
      </SettingsSection>

      {!isProjectScope && (
        <SettingsSection id="storage-worktree-reuse" title="Worktree reuse">
          {reuseSupported ? (
            <>
              <SettingsRow
                title="Reuse worktrees"
                status={reuseStatus("enabled")}
                description="Keep removed worktrees on standby and give them to new threads instead of creating new ones. A reused worktree gets a new location, is reset to the requested branch, and the setup script runs again; ignored files such as node_modules are kept."
                serverScoped
                settingKeys={["worktreeReuse"]}
                control={
                  <Switch
                    aria-label="Reuse worktrees"
                    checked={reuse.enabled}
                    onCheckedChange={(enabled) => updateReuse({ enabled })}
                  />
                }
              />
              {reuse.enabled && (
                <>
                  <SettingsRow
                    title="Standby limit"
                    status={reuseStatus("maxStandby")}
                    description="The most worktrees kept on standby for each repository. The least recently released are removed first."
                    serverScoped
                    settingKeys={["worktreeReuse"]}
                    control={
                      <UnitNumberField
                        label="Standby limit"
                        unit="per repository"
                        value={reuse.maxStandby}
                        min={1}
                        max={50}
                        onChange={(maxStandby) => updateReuse({ maxStandby })}
                      />
                    }
                  />
                  <SettingsRow
                    title="Standby time"
                    status={reuseStatus("standbyHours")}
                    description="Remove a worktree from standby after it has gone unused this long."
                    serverScoped
                    settingKeys={["worktreeReuse"]}
                    control={
                      <UnitNumberField
                        label="Standby time"
                        unit="hours"
                        value={reuse.standbyHours}
                        min={1}
                        max={720}
                        onChange={(standbyHours) => updateReuse({ standbyHours })}
                      />
                    }
                  />
                </>
              )}
            </>
          ) : (
            <SettingsRow
              title="Reuse worktrees"
              description="Update the selected environments to reuse worktrees."
              serverScoped
            />
          )}
        </SettingsSection>
      )}

      {!isProjectScope && (
        <SettingsSection id="storage-artifacts" title="Artifacts and logs">
          <SettingsRow
            title="Delete old browser artifacts"
            status={ruleStatus("browserArtifactsAfterDays")}
            description="Delete saved browser captures after this many days. Older capture links will no longer open."
            serverScoped
            control={
              <RetentionControl
                label="Delete old browser artifacts"
                value={settings.browserArtifactsAfterDays}
                onChange={(browserArtifactsAfterDays) => update({ browserArtifactsAfterDays })}
              />
            }
          />
          <SettingsRow
            title="Delete old rotated logs"
            status={ruleStatus("logsAfterDays")}
            description="Delete inactive rotated log files after this many days. Current logs are kept."
            serverScoped
            control={
              <RetentionControl
                label="Delete old rotated logs"
                value={settings.logsAfterDays}
                onChange={(logsAfterDays) => update({ logsAfterDays })}
              />
            }
          />
        </SettingsSection>
      )}
    </SettingsPageContainer>
  );
}
