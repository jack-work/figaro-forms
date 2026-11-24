import { wellKnownKeys } from "./known-keys.gen.js";

export type KeyMode = "user" | "system" | "per-turn";

export interface KeyDoc {
  readonly key: string;
  readonly short: string;
  readonly mode: KeyMode;
}

export { wellKnownKeys };

export const forms = {
  models: "@models",
  arias: "@arias",
  topology: "@topology",
  recent: "@recent",
  reaped: "@reaped",
  troupe: "@troupe",
} as const;
