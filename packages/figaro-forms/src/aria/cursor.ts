import type { Anchor } from "./wire.js";

export type Cursor = string;

export interface Position {
  readonly turn: number;
  readonly pos: number;
}

export const startCursor: Cursor = "0.0";

export function formatCursor(p: Position): Cursor {
  return `${p.turn}.${p.pos}`;
}

export function parseCursor(c: Cursor): Position | undefined {
  const m = /^(\d+)\.(\d+)$/.exec(c);
  if (!m) return undefined;
  const turn = Number(m[1]);
  const pos = Number(m[2]);
  if (!Number.isSafeInteger(turn) || !Number.isSafeInteger(pos)) return undefined;
  return { turn, pos };
}

export function anchorOfCursor(c: Cursor): Anchor | undefined {
  const p = parseCursor(c);
  if (!p) return undefined;
  return { turn: p.turn, node: Math.max(0, p.pos - 1) };
}

export function compareCursors(a: Cursor, b: Cursor): number {
  const x = parseCursor(a);
  const y = parseCursor(b);
  if (!x || !y) return 0;
  return x.turn !== y.turn ? x.turn - y.turn : x.pos - y.pos;
}
