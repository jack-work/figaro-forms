import { compareStrings, isObject, type Json, type JsonObject } from "../json.js";
import type { EditResult } from "../replica.js";
import { formatQuote, parseQuote, type QuoteCoord, type QuoteRange } from "./quote.js";
import type { BoundFormWriter } from "./surface.js";

const commentsKey = "comments";

export interface CommentEntry {
  readonly key: string;
  readonly by: string;
  readonly text: string;
}

export interface TranscriptComment {
  readonly id: string;
  readonly token: string;
  readonly at: QuoteRange;
  readonly turn: number;
  readonly thread: readonly CommentEntry[];
}

const str = (v: Json | undefined): string => (typeof v === "string" ? v : "");

const coordLess = (a: QuoteCoord, b: QuoteCoord): number => a.lt - b.lt || a.block - b.block || a.offset - b.offset;

function entriesOf(v: Json | undefined): CommentEntry[] {
  if (!isObject(v)) return [];
  const out: CommentEntry[] = [];
  for (const [key, e] of Object.entries(v)) {
    if (isObject(e)) out.push({ key, by: str(e.by), text: str(e.text) });
  }
  return out.sort((a, b) => compareStrings(a.key, b.key));
}

export function foldComments(root: JsonObject): TranscriptComment[] {
  const all = root[commentsKey];
  if (!isObject(all)) return [];
  const out: TranscriptComment[] = [];
  for (const [id, rec] of Object.entries(all)) {
    if (!isObject(rec)) continue;
    let parsed: ReturnType<typeof parseQuote>;
    try {
      parsed = parseQuote(str(rec.at).trim());
    } catch {
      continue;
    }
    if (!parsed) continue;
    const turn = typeof rec.turn === "number" && Number.isInteger(rec.turn) ? rec.turn : 0;
    out.push({ id, token: formatQuote(parsed.range), at: parsed.range, turn, thread: entriesOf(rec.thread) });
  }
  return out.sort((a, b) => coordLess(a.at.start, b.at.start) || compareStrings(a.id, b.id));
}

export function endBlockOf(r: QuoteRange): { readonly lt: number; readonly block: number } {
  return r.block ? { lt: r.end.lt, block: r.end.block } : { lt: r.start.lt, block: 0 };
}

export function commentsByTurn(comments: readonly TranscriptComment[]): Map<number, TranscriptComment[]> {
  const out = new Map<number, TranscriptComment[]>();
  for (const c of comments) {
    const list = out.get(c.turn);
    if (list) list.push(c);
    else out.set(c.turn, [c]);
  }
  return out;
}

export interface CommentEnv {
  nowMs(): number;
  randomBytes(n: number): Uint8Array;
}

export const systemEnv: CommentEnv = {
  nowMs: () => Date.now(),
  randomBytes: (n) => crypto.getRandomValues(new Uint8Array(n)),
};

const alphabet = "abcdefghijkmnpqrstuvwxyz23456789";

function newCommentId(taken: ReadonlySet<string>, env: CommentEnv): string {
  for (let size = 3; ; size++) {
    for (let attempt = 0; attempt < 64; attempt++) {
      const id = Array.from(env.randomBytes(size), (b) => alphabet[b & 31]).join("");
      if (!taken.has(id)) return id;
    }
  }
}

function appendKey(thread: readonly CommentEntry[], env: CommentEnv): string {
  const key = Math.trunc(env.nowMs()).toString(36);
  let last = "";
  for (const e of thread) if (e.key > last) last = e.key;
  return key <= last ? `${last}0` : key;
}

function entryValue(by: string | undefined, text: string): JsonObject {
  return by ? { by, text } : { text };
}

export interface NewComment {
  readonly at: QuoteRange;
  readonly text: string;
  readonly by?: string;
  readonly turn?: number;
}

export type CommentWrite =
  | { readonly ok: true; readonly version: number; readonly id: string; readonly key?: string }
  | Extract<EditResult, { ok: false }>
  | { readonly ok: false; readonly invalid: string };

const through = (r: EditResult, id: string, key?: string): CommentWrite => (r.ok ? { ok: true, version: r.version, id, ...(key === undefined ? {} : { key }) } : r);

export async function addComment(writer: BoundFormWriter, root: JsonObject, input: NewComment, env: CommentEnv = systemEnv): Promise<CommentWrite> {
  const text = input.text.trim();
  if (text === "") return { ok: false, invalid: "comment: nothing to say" };
  const existing = root[commentsKey];
  const taken = new Set(isObject(existing) ? Object.keys(existing) : []);
  const id = newCommentId(taken, env);
  const key = appendKey([], env);
  const record: Record<string, Json> = { at: formatQuote(input.at) };
  if (input.turn) record.turn = input.turn;
  record.thread = { [key]: entryValue(input.by, text) };
  return through(await writer.set(`${commentsKey}.${id}`, record), id, key);
}

export async function replyToComment(writer: BoundFormWriter, root: JsonObject, id: string, text: string, by?: string, env: CommentEnv = systemEnv): Promise<CommentWrite> {
  const c = foldComments(root).find((x) => x.id === id);
  if (!c) return { ok: false, invalid: `comment: no comment #${id} on this aria` };
  const body = text.trim();
  if (body === "") return { ok: false, invalid: `comment: nothing to say (:comment #${id} -- <text>)` };
  const key = appendKey(c.thread, env);
  return through(await writer.set(`${commentsKey}.${id}.thread.${key}`, entryValue(by, body)), id, key);
}

export async function deleteComment(writer: BoundFormWriter, root: JsonObject, id: string): Promise<CommentWrite> {
  if (!foldComments(root).some((x) => x.id === id)) return { ok: false, invalid: `comment: no comment #${id} on this aria` };
  return through(await writer.unset(`${commentsKey}.${id}`), id);
}
