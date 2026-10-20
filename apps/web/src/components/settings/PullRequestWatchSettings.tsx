import { PlusIcon, XIcon } from "lucide-react";
import { useState } from "react";

import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { SettingResetButton, SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import {
  useScopedSettings,
  useScopedSettingsMixed,
  useUpdateScopedSettings,
} from "./useScopedSettings";

function regexError(pattern: string): string | null {
  try {
    RegExp(pattern, "i");
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : "Not a valid regular expression.";
  }
}

export function PullRequestWatchSettingsSection() {
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const mixed = useScopedSettingsMixed(["pullRequestWatchIgnoredChecks"]);
  const ignored = mixed ? [] : settings.pullRequestWatchIgnoredChecks;
  const [draft, setDraft] = useState("");
  const pattern = draft.trim();
  const error = pattern.length === 0 ? null : regexError(pattern);
  const canAdd = pattern.length > 0 && error === null && !ignored.includes(pattern);

  const save = (next: ReadonlyArray<string>) =>
    updateSettings({ pullRequestWatchIgnoredChecks: [...next] });
  const add = () => {
    if (!canAdd) return;
    save([...ignored, pattern]);
    setDraft("");
  };

  return (
    <SettingsSection title="Pull request watching">
      <SettingsRow
        serverScoped
        settingKeys={["pullRequestWatchIgnoredChecks"]}
        {...searchableSetting("pull-request-watch-ignored-checks")}
        description="Checks a watching agent does not wait for, such as approval bots that stay pending until someone reviews. Each pattern is a case-insensitive regular expression matched anywhere in the check name."
        resetAction={
          mixed || ignored.length > 0 ? (
            <SettingResetButton label="ignored checks" onClick={() => save([])} />
          ) : null
        }
      >
        <div className="mt-3 max-w-xl min-w-0 space-y-2 pb-3.5">
          {ignored.map((saved) => (
            <div key={saved} className="flex min-w-0 items-center gap-1.5">
              <Input size="sm" font="mono" value={saved} readOnly aria-label="Ignored check" />
              <Button
                type="button"
                size="icon-micro"
                variant="ghost-destructive"
                onClick={() => save(ignored.filter((current) => current !== saved))}
                aria-label={`Remove ${saved}`}
              >
                <XIcon />
              </Button>
            </div>
          ))}
          <form
            className="flex min-w-0 items-center gap-1.5"
            onSubmit={(event) => {
              event.preventDefault();
              add();
            }}
          >
            <Input
              size="sm"
              font="mono"
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              placeholder={mixed ? "Mixed. Patterns you add replace all of them." : "^policy-bot"}
              spellCheck={false}
              aria-label="New ignored check pattern"
              aria-invalid={error !== null}
            />
            <Button type="submit" size="sm" variant="outline" disabled={!canAdd}>
              <PlusIcon />
              Add
            </Button>
          </form>
          {error ? <p className="text-xs text-destructive">{error}</p> : null}
        </div>
      </SettingsRow>
    </SettingsSection>
  );
}
