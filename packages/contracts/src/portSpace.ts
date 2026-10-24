import * as Schema from "effect/Schema";

/** Whether an environment can give each thread its own network namespace. */
export const PortSpacesStatus = Schema.Struct({
  available: Schema.Boolean,
  /** What is missing and how to fix it. Absent when port spaces are available. */
  detail: Schema.optionalKey(Schema.String),
});
export type PortSpacesStatus = typeof PortSpacesStatus.Type;

/** A TCP listener inside a thread's port space. `address` is as `ss` prints it: `*`, `0.0.0.0`, `::`, `127.0.0.1`, `::1`. */
export const PortSpaceListener = Schema.Struct({
  address: Schema.String.check(Schema.isMaxLength(64)),
  port: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65535 })),
});
export type PortSpaceListener = typeof PortSpaceListener.Type;

export const PortSpaceListenerList = Schema.Struct({
  listeners: Schema.Array(PortSpaceListener).check(Schema.isMaxLength(256)),
});
export type PortSpaceListenerList = typeof PortSpaceListenerList.Type;
