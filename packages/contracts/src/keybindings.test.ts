import { assert, it } from "@effect/vitest";
import * as Schema from "effect/Schema";
import * as Effect from "effect/Effect";

import { ForwardCompatibleArray } from "./baseSchemas.ts";
import { ResolvedKeybindingsConfig, ResolvedShortcutKeybindingRule } from "./keybindings.ts";

const decode = <S extends Schema.Top>(
  schema: S,
  input: unknown,
): Effect.Effect<Schema.Schema.Type<S>, Schema.SchemaError, never> =>
  Schema.decodeUnknownEffect(schema as never)(input) as Effect.Effect<
    Schema.Schema.Type<S>,
    Schema.SchemaError,
    never
  >;

const encodeResolvedKeybindings = Schema.encodeEffect(ResolvedKeybindingsConfig);

const shortcut = {
  key: "p",
  metaKey: false,
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  modKey: true,
};

const chordRule = {
  command: "terminal.toggle" as const,
  chord: [
    { ...shortcut, key: "g" },
    { ...shortcut, key: "x", modKey: false },
  ] as const,
};

it.effect("round-trips chord rules through the resolved config", () =>
  Effect.gen(function* () {
    const encoded = yield* encodeResolvedKeybindings([chordRule]);
    assert.deepEqual(encoded, [chordRule]);
    const decoded = yield* decode(ResolvedKeybindingsConfig, encoded);
    assert.deepEqual(decoded, [chordRule]);
  }),
);

it.effect("lets a client without chord support drop chord rules instead of misreading them", () =>
  Effect.gen(function* () {
    const clientBeforeChords = ForwardCompatibleArray(ResolvedShortcutKeybindingRule);
    const decoded = yield* decode(clientBeforeChords, [
      chordRule,
      { command: "terminal.split", shortcut },
    ]);
    assert.deepEqual(
      decoded.map((rule) => rule.command),
      ["terminal.split"],
    );
  }),
);

it.effect("drops resolved rules with commands this build does not know", () =>
  Effect.gen(function* () {
    const parsed = yield* decode(ResolvedKeybindingsConfig, [
      { command: "terminal.toggle", shortcut },
      { command: "someFuture.toggle", shortcut },
      { command: "filePicker.toggle", shortcut },
    ]);
    assert.deepEqual(
      parsed.map((rule) => rule.command),
      ["terminal.toggle", "filePicker.toggle"],
    );
  }),
);

it.effect("drops malformed resolved rule entries", () =>
  Effect.gen(function* () {
    const parsed = yield* decode(ResolvedKeybindingsConfig, [
      "garbage",
      { command: "terminal.toggle", shortcut },
      null,
    ]);
    assert.deepEqual(
      parsed.map((rule) => rule.command),
      ["terminal.toggle"],
    );
  }),
);
