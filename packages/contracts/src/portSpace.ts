import * as Schema from "effect/Schema";

/** Whether an environment can give each thread its own network namespace. */
export const PortSpacesStatus = Schema.Struct({
  available: Schema.Boolean,
  /** What is missing and how to fix it. Absent when port spaces are available. */
  detail: Schema.optionalKey(Schema.String),
});
export type PortSpacesStatus = typeof PortSpacesStatus.Type;
