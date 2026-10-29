import { useAtomValue } from "@effect/atom-react";
import type {
  DesktopPreviewBridge,
  DesktopPreviewWebviewConfig,
  EnvironmentId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { AsyncResult, Atom } from "effect/reactivity";

import { previewBridge } from "~/components/preview/previewBridge";

const PREVIEW_CONFIG_STALE_TIME_MS = 5 * 60_000;
const PREVIEW_CONFIG_IDLE_TTL_MS = 10 * 60_000;

export class PreviewWebviewBridgeUnavailableError extends Schema.TaggedError<PreviewWebviewBridgeUnavailableError>()(
  "PreviewWebviewBridgeUnavailableError",
  { environmentId: Schema.String },
) {
  override get message(): string {
    return `Desktop preview configuration is unavailable for environment "${this.environmentId}".`;
  }
}

export class PreviewWebviewConfigLoadError extends Schema.TaggedError<PreviewWebviewConfigLoadError>()(
  "PreviewWebviewConfigLoadError",
  {
    environmentId: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to load desktop preview configuration for environment "${this.environmentId}".`;
  }
}

export const PreviewWebviewConfigError = Schema.Union([
  PreviewWebviewBridgeUnavailableError,
  PreviewWebviewConfigLoadError,
]);
export type PreviewWebviewConfigError = typeof PreviewWebviewConfigError.Type;

type PreviewConfigBridge = Pick<DesktopPreviewBridge, "getPreviewConfig">;

const loadPreviewWebviewConfig = (
  environmentId: EnvironmentId,
  profileId?: string,
  bridge: PreviewConfigBridge | null = previewBridge,
  portSpaceThreadId?: ThreadId,
): Effect.Effect<DesktopPreviewWebviewConfig, PreviewWebviewConfigError> => {
  if (bridge === null) {
    return Effect.fail(new PreviewWebviewBridgeUnavailableError({ environmentId }));
  }

  return Effect.tryPromise({
    try: () => bridge.getPreviewConfig(environmentId, profileId, portSpaceThreadId),
    catch: (cause) => new PreviewWebviewConfigLoadError({ environmentId, cause }),
  });
};

// Atom.family needs a primitive key, so environment, thread and profile fold into one string.
// The thread is empty unless port spaces are on; profile stays last so delimiter-containing ids round-trip.
const CONFIG_KEY_DELIMITER = "\u0000";

const configKey = (
  environmentId: EnvironmentId,
  threadId: ThreadId | undefined,
  profileId: string | undefined,
): string => [environmentId, threadId ?? "", profileId ?? ""].join(CONFIG_KEY_DELIMITER);

const parseConfigKey = (
  key: string,
): { environmentId: EnvironmentId; threadId?: ThreadId; profileId?: string } => {
  const first = key.indexOf(CONFIG_KEY_DELIMITER);
  const second = first === -1 ? -1 : key.indexOf(CONFIG_KEY_DELIMITER, first + 1);
  const environmentId = (first === -1 ? key : key.slice(0, first)) as EnvironmentId;
  const threadId = first === -1 ? "" : key.slice(first + 1, second === -1 ? undefined : second);
  const profileId = second === -1 ? "" : key.slice(second + 1);
  return {
    environmentId,
    ...(threadId === "" ? {} : { threadId: threadId as ThreadId }),
    ...(profileId === "" ? {} : { profileId }),
  };
};

const previewWebviewConfigAtom = Atom.family((key: string) => {
  const { environmentId, threadId, profileId } = parseConfigKey(key);
  return Atom.make(
    loadPreviewWebviewConfig(environmentId, profileId, previewBridge, threadId),
  ).pipe(
    Atom.swr({
      staleTime: PREVIEW_CONFIG_STALE_TIME_MS,
      revalidateOnMount: true,
    }),
    Atom.setIdleTTL(PREVIEW_CONFIG_IDLE_TTL_MS),
    Atom.withLabel(`preview:webview-config:${key}`),
  );
});

export function usePreviewWebviewConfig(
  environmentId: EnvironmentId,
  profileId?: string,
  portSpaceThreadId?: ThreadId,
): DesktopPreviewWebviewConfig | null {
  const result = useAtomValue(
    previewWebviewConfigAtom(configKey(environmentId, portSpaceThreadId, profileId)),
  );
  return AsyncResult.getOrElse(result, () => null);
}
