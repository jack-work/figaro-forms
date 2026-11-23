import { isObject, type Json, type JsonObject } from "../json.js";

const commentPrefix = "comment_";
const threadPrefix = "thread_";

export interface ReviewComment {
  readonly id: string;
  readonly thread: string;
  readonly kind: string;
  readonly by: string;
  readonly at: string;
  readonly body: string;
  readonly repo: string;
  readonly file: string;
  readonly line: number;
  readonly quote: string;
}

export interface ReviewThread {
  readonly id: string;
  readonly repo: string;
  readonly file: string;
  readonly line: number;
  readonly quote: string;
  readonly by: string;
  readonly last: string;
  readonly n: number;
  readonly resolved: boolean;
  readonly unread: number;
  readonly comments: readonly ReviewComment[];
}

export interface Review {
  readonly repo: string | undefined;
  readonly cursor: string | undefined;
  readonly open: number;
  readonly unread: number;
  readonly threads: readonly ReviewThread[];
}

const str = (v: Json | undefined): string => (typeof v === "string" ? v : "");
const count = (v: Json | undefined): number | undefined => {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && /^\d+$/.test(v)) return Number(v);
  return undefined;
};

function commentOf(id: string, v: JsonObject): ReviewComment {
  return {
    id,
    thread: str(v.thread),
    kind: str(v.kind),
    by: str(v.by),
    at: str(v.at),
    body: str(v.body),
    repo: str(v.repo),
    file: str(v.file),
    line: count(v.line) ?? 0,
    quote: str(v.quote),
  };
}

const byAt = (a: ReviewComment, b: ReviewComment): number => (a.at < b.at ? -1 : a.at > b.at ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

const byPlace = (a: ReviewThread, b: ReviewThread): number =>
  a.file < b.file ? -1 : a.file > b.file ? 1 : a.line !== b.line ? a.line - b.line : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;

export function foldReview(root: JsonObject): Review {
  const comments = new Map<string, ReviewComment[]>();
  const entries = new Map<string, JsonObject>();
  for (const [key, v] of Object.entries(root)) {
    if (!isObject(v)) continue;
    if (key.startsWith(commentPrefix) && key.length > commentPrefix.length) {
      const c = commentOf(key.slice(commentPrefix.length), v);
      if (c.thread === "") continue;
      const list = comments.get(c.thread);
      if (list) list.push(c);
      else comments.set(c.thread, [c]);
    } else if (key.startsWith(threadPrefix) && key.length > threadPrefix.length) {
      entries.set(key.slice(threadPrefix.length), v);
    }
  }
  const threads: ReviewThread[] = [];
  for (const [id, v] of entries) {
    const list = (comments.get(id) ?? []).sort(byAt);
    threads.push({
      id,
      repo: str(v.repo),
      file: str(v.file),
      line: count(v.line) ?? 0,
      quote: str(v.quote),
      by: str(v.by),
      last: str(v.last),
      n: count(v.n) ?? list.length,
      resolved: v.resolved === true,
      unread: count(v.unread) ?? 0,
      comments: list,
    });
  }
  for (const [id, list] of comments) {
    if (entries.has(id)) continue;
    list.sort(byAt);
    const head = list[0] as ReviewComment;
    const tail = list[list.length - 1] as ReviewComment;
    threads.push({ id, repo: head.repo, file: head.file, line: head.line, quote: head.quote, by: tail.by, last: tail.at, n: list.length, resolved: false, unread: 0, comments: list });
  }
  threads.sort(byPlace);
  const open = threads.filter((t) => !t.resolved).length;
  const unread = threads.reduce((sum, t) => sum + t.unread, 0);
  return {
    repo: str(root.repo) || undefined,
    cursor: str(root.cursor) || undefined,
    open: count(root.threads_open) ?? open,
    unread: count(root.unread) ?? unread,
    threads,
  };
}
