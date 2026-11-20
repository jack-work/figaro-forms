import { readFileSync } from "node:fs";
import type { AriaFrame, Page, TurnDone } from "../../src/aria/wire.js";

export interface TapeLine {
  readonly t: number;
  readonly dir: "out" | "in" | "push";
  readonly id?: number;
  readonly method?: string;
  readonly params?: unknown;
  readonly result?: unknown;
  readonly error?: { readonly code: number; readonly message: string };
}

export function loadTape(name: string): TapeLine[] {
  return readFileSync(new URL(`./tapes/${name}.ndjson`, import.meta.url), "utf8")
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l) as TapeLine);
}

export function reads(tape: readonly TapeLine[]): Page[] {
  const asked = new Map<number, string>();
  const out: Page[] = [];
  let id = 0;
  for (const l of tape) {
    if (l.dir === "out") {
      id++;
      if (l.method) asked.set(id, l.method);
    }
    if (l.dir === "in" && l.id !== undefined && asked.get(l.id) === "figaro.read") out.push(l.result as Page);
  }
  return out;
}

export function pushes(tape: readonly TapeLine[]): TapeLine[] {
  return tape.filter((l) => l.dir === "push");
}

export const frameOf = (l: TapeLine): AriaFrame => l.params as AriaFrame;
export const doneOf = (l: TapeLine): TurnDone => l.params as TurnDone;
