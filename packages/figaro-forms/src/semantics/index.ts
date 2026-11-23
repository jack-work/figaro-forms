import { wellKnownKeys } from "./known-keys.gen.js";

export type { KeyDoc, KeyMode } from "./keys.js";
export { wellKnownKeys };

export const forms = {
  models: "@models",
  arias: "@arias",
  topology: "@topology",
  recent: "@recent",
  reaped: "@reaped",
  troupe: "@troupe",
} as const;
