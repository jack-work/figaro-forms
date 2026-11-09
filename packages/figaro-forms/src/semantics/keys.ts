export type KeyMode = "user" | "system" | "per-turn";

export interface KeyDoc {
  readonly key: string;
  readonly short: string;
  readonly mode: KeyMode;
}
