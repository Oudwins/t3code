import { msg, T, useGT, useMessages } from "gt-react";
import { PlusIcon, XIcon } from "lucide-react";
import { useState } from "react";

import { m, type MessageResolver } from "../../i18n/messages";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { SettingResetButton, SettingsRow, SettingsSection } from "./settingsLayout";
import { useSearchableSetting } from "./settingsSearch";
import {
  useScopedSettings,
  useScopedSettingsMixed,
  useUpdateScopedSettings,
} from "./useScopedSettings";

function regexError(pattern: string, resolve: MessageResolver = m): string | null {
  try {
    RegExp(pattern, "i");
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : resolve(msg("Not a valid regular expression."));
  }
}

export function PullRequestWatchSettingsSection() {
  const searchableSetting = useSearchableSetting();
  const gt = useGT();
  const messages = useMessages();
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const mixed = useScopedSettingsMixed(["pullRequestWatchIgnoredChecks"]);
  const ignored = mixed ? [] : settings.pullRequestWatchIgnoredChecks;
  const [draft, setDraft] = useState("");
  const pattern = draft.trim();
  const error = pattern.length === 0 ? null : regexError(pattern, messages);
  const canAdd = pattern.length > 0 && error === null && !ignored.includes(pattern);

  const save = (next: ReadonlyArray<string>) =>
    updateSettings({ pullRequestWatchIgnoredChecks: [...next] });
  const add = () => {
    if (!canAdd) return;
    save([...ignored, pattern]);
    setDraft("");
  };

  return (
    <SettingsSection title={gt("Pull request watching")}>
      <SettingsRow
        serverScoped
        settingKeys={["pullRequestWatchIgnoredChecks"]}
        {...searchableSetting("pull-request-watch-ignored-checks")}
        description={gt(
          "Checks a watching agent does not wait for, such as approval bots that stay pending until someone reviews. Each pattern is a case-insensitive regular expression matched anywhere in the check name.",
        )}
        resetAction={
          mixed || ignored.length > 0 ? (
            <SettingResetButton
              ariaLabel={gt("Reset ignored checks to default")}
              onClick={() => save([])}
            />
          ) : null
        }
      >
        <div className="mt-3 max-w-xl min-w-0 space-y-2 pb-3.5">
          {ignored.map((saved) => (
            <div key={saved} className="flex min-w-0 items-center gap-1.5">
              <Input
                size="sm"
                font="mono"
                value={saved}
                readOnly
                aria-label={gt("Ignored check")}
              />
              <Button
                type="button"
                size="icon-micro"
                variant="ghost-destructive"
                onClick={() => save(ignored.filter((current) => current !== saved))}
                aria-label={gt("Remove {pattern}", { pattern: saved })}
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
              placeholder={
                mixed ? gt("Mixed. Patterns you add replace all of them.") : "^policy-bot"
              }
              spellCheck={false}
              aria-label={gt("New ignored check pattern")}
              aria-invalid={error !== null}
            />
            <Button type="submit" size="sm" variant="outline" disabled={!canAdd}>
              <PlusIcon />
              <T context="button, adds a pattern">Add</T>
            </Button>
          </form>
          {error ? <p className="text-xs text-destructive">{error}</p> : null}
        </div>
      </SettingsRow>
    </SettingsSection>
  );
}
