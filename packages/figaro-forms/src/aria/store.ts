import type { Anchor, FormDelta, InquirySegment, Node, Page } from "./wire.js";

export const maxNode = Number.MAX_SAFE_INTEGER;
const maxTurn = Number.MAX_SAFE_INTEGER;

export const anchorZero = (a: Anchor): boolean => a.turn === 0 && a.node === 0;

export const anchorLess = (a: Anchor, b: Anchor): boolean => (a.turn !== b.turn ? a.turn < b.turn : a.node < b.node);

export function anchorNext(a: Anchor): Anchor {
  if (a.node === maxNode) {
    if (a.turn === maxTurn) return a;
    return { turn: a.turn + 1, node: 0 };
  }
  return { turn: a.turn, node: a.node + 1 };
}

export function anchorPrev(a: Anchor): Anchor {
  if (a.node > 0) return { turn: a.turn, node: a.node - 1 };
  if (a.turn === 0) return a;
  return { turn: a.turn - 1, node: maxNode };
}

const sameAnchor = (a: Anchor, b: Anchor): boolean => a.turn === b.turn && a.node === b.node;

export interface Message {
  readonly turn: number;
  readonly from: number;
  readonly inquiry?: string;
  readonly inquirySegments?: readonly InquirySegment[];
  readonly inquiryLT?: number;
  readonly formDeltas?: { readonly [key: string]: FormDelta };
  readonly forkedFrom?: string;
  readonly role: "input" | "output";
  readonly nodes: readonly Node[];
}

export interface Range {
  readonly from: Anchor;
  readonly to: Anchor;
  readonly msgs: readonly Message[];
}

export interface Gap {
  readonly from: Anchor;
  readonly to: Anchor;
}

export interface Segment {
  readonly msgs: readonly Message[];
  readonly gap?: Gap;
}

export interface Extent {
  readonly before: boolean;
  readonly after: boolean;
}

export type Fetcher = (before: Anchor, limit: number) => Promise<Page>;

export class StalledError extends Error {
  constructor() {
    super("aria: the hole stopped shrinking");
    this.name = "StalledError";
  }
}

export function spanEnd(m: Message): number {
  return m.nodes.length === 0 ? m.from : m.from + m.nodes.length - 1;
}

export function msgSpan(m: Message): [Anchor, Anchor] {
  return [
    { turn: m.turn, node: m.from },
    { turn: m.turn, node: spanEnd(m) },
  ];
}

function sliceNodes(m: Message, lo: number, hi: number): Message {
  if (m.nodes.length === 0 || (lo <= m.from && hi >= spanEnd(m))) return m;
  if (lo < m.from) lo = m.from;
  const e = spanEnd(m);
  if (hi > e) hi = e;
  const out: { -readonly [K in keyof Message]: Message[K] } = {
    turn: m.turn,
    from: lo,
    role: m.role,
    nodes: m.nodes.slice(lo - m.from, hi - m.from + 1),
  };
  if (out.from === 0) {
    if (m.inquiry !== undefined) out.inquiry = m.inquiry;
    if (m.inquirySegments !== undefined) out.inquirySegments = m.inquirySegments;
    if (m.inquiryLT !== undefined) out.inquiryLT = m.inquiryLT;
    if (m.forkedFrom !== undefined) out.forkedFrom = m.forkedFrom;
  }
  return out;
}

function sortSearch(n: number, pred: (i: number) => boolean): number {
  let lo = 0;
  let hi = n;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (!pred(mid)) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function firstMsgAtOrAfter(msgs: readonly Message[], a: Anchor): number {
  return sortSearch(msgs.length, (k) => !anchorLess(msgSpan(msgs[k] as Message)[1], a));
}

interface OpenTail {
  turn: number;
  base: number;
  held: boolean;
  from: number;
  v: number;
  nodes: Node[];
}

const emptyOpen = (): OpenTail => ({ turn: 0, base: 0, held: false, from: 0, v: 0, nodes: [] });

interface MutableRange {
  from: Anchor;
  to: Anchor;
  msgs: Message[];
}

export class Store {
  private ranges: MutableRange[] = [];
  private moreValue: Extent = { before: false, after: false };
  private open: OpenTail = emptyOpen();
  private readonly ends = new Map<number, number>();

  complete(turn: number): boolean {
    return (this.ends.get(turn) ?? 0) !== 0;
  }

  setTurnLen(turn: number, n: number): void {
    const cur = this.ends.get(turn);
    if (cur !== undefined && cur >= n) return;
    this.ends.set(turn, n);
    if (n === 0) {
      this.coalesce();
      return;
    }
    this.coalesceAround(turn);
  }

  turnLen(turn: number): number | undefined {
    return this.ends.get(turn);
  }

  private adjacent(a: Anchor, b: Anchor): boolean {
    if (!anchorLess(a, b)) return false;
    if (sameAnchor(b, anchorNext(a))) return true;
    if (b.node !== 0 || b.turn <= a.turn) return false;
    const n = this.ends.get(a.turn);
    if (n === undefined || a.node + 1 !== n) return false;
    for (let t = a.turn + 1; t < b.turn; t++) {
      const m = this.ends.get(t);
      if (m === undefined || m !== 0) return false;
    }
    return true;
  }

  private mergeAt(i: number): boolean {
    if (i < 0 || i + 1 >= this.ranges.length) return false;
    const left = this.ranges[i] as MutableRange;
    const right = this.ranges[i + 1] as MutableRange;
    const boundary = left.to;
    if (!this.adjacent(boundary, right.from)) return false;
    left.msgs = left.msgs.concat(right.msgs);
    left.to = right.to;
    this.ranges.splice(i + 1, 1);
    this.consume(boundary, left.to);
    return true;
  }

  private consume(boundary: Anchor, to: Anchor): void {
    if (boundary.turn < to.turn) this.ends.delete(boundary.turn);
  }

  private coalesce(): void {
    for (let i = 0; i + 1 < this.ranges.length; ) {
      if (!this.mergeAt(i)) i++;
    }
  }

  private coalesceAround(turn: number): void {
    let i = sortSearch(this.ranges.length, (k) => turn < (this.ranges[k] as MutableRange).from.turn) - 1;
    if (i < 0) i = 0;
    while (this.mergeAt(i));
    while (this.mergeAt(i - 1));
  }

  insert(...msgs: Message[]): Message[] {
    const out: Message[] = [];
    for (const m of msgs) {
      const n = this.ranges.length;
      if (n > 0) {
        const last = this.ranges[n - 1] as MutableRange;
        const [f, t] = msgSpan(m);
        if (anchorLess(last.to, f) && this.adjacent(last.to, f)) {
          const boundary = last.to;
          last.msgs.push(m);
          last.to = t;
          this.consume(boundary, t);
          out.push(m);
          continue;
        }
      }
      for (const piece of this.subtractHeld(m)) {
        const [from, to] = msgSpan(piece);
        this.insertRange({ from, to, msgs: [piece] });
        out.push(piece);
      }
    }
    return out;
  }

  private subtractHeld(m: Message): Message[] {
    const t = m.turn;
    let cur = m.from;
    const hi = spanEnd(m);
    const out: Message[] = [];
    for (let k = this.firstRangeAtOrAfter({ turn: t, node: cur }); k < this.ranges.length; k++) {
      const r = this.ranges[k] as MutableRange;
      if (r.to.turn < t) continue;
      if (r.from.turn > t) break;
      const lo = r.from.turn === t ? r.from.node : 0;
      const end = r.to.turn === t ? r.to.node : maxNode;
      if (end < cur) continue;
      if (lo > hi) break;
      if (cur < lo) out.push(sliceNodes(m, cur, lo - 1));
      if (end >= hi) return out;
      cur = end + 1;
    }
    if (cur <= hi) out.push(sliceNodes(m, cur, hi));
    return out;
  }

  private firstRangeAtOrAfter(a: Anchor): number {
    return sortSearch(this.ranges.length, (k) => !anchorLess((this.ranges[k] as MutableRange).to, a));
  }

  private insertRange(nr: MutableRange): void {
    const i = sortSearch(this.ranges.length, (k) => anchorLess(nr.from, (this.ranges[k] as MutableRange).from));
    this.ranges.splice(i, 0, nr);
    while (this.mergeAt(i));
    while (this.mergeAt(i - 1));
  }

  evict(from: Anchor, to: Anchor): void {
    if (anchorLess(to, from)) return;
    const out: MutableRange[] = [];
    for (const r of this.ranges) {
      if (anchorLess(r.to, from) || anchorLess(to, r.from)) {
        out.push(r);
        continue;
      }
      const head = this.keep(r, r.from, anchorPrev(from));
      const tail = this.keep(r, anchorNext(to), r.to);
      if (head) out.push(head);
      if (tail) out.push(tail);
    }
    this.ranges = out;
  }

  cloneBelow(turn: number): Store {
    const out = new Store();
    out.moreValue = { before: this.moreValue.before, after: this.moreValue.after };
    if (turn === 0) return out;
    const cut: Anchor = { turn, node: 0 };
    for (const r of this.ranges) {
      if (!anchorLess(r.from, cut)) {
        out.moreValue = { ...out.moreValue, after: true };
        continue;
      }
      let hi = r.to;
      let cutHere = false;
      if (!anchorLess(hi, cut)) {
        hi = anchorPrev(cut);
        cutHere = true;
      }
      const head = this.keep(r, r.from, hi);
      if (!head) continue;
      out.ranges.push({ from: head.from, to: head.to, msgs: head.msgs.slice() });
      if (cutHere) {
        out.moreValue = { ...out.moreValue, after: true };
        out.ends.set(head.to.turn, head.to.node + 1);
      }
    }
    for (const [t, n] of this.ends) if (t < turn) out.ends.set(t, n);
    return out;
  }

  private keep(r: MutableRange, lo: Anchor, hi: Anchor): MutableRange | undefined {
    if (anchorLess(hi, lo)) return undefined;
    const msgs: Message[] = [];
    for (let k = firstMsgAtOrAfter(r.msgs, lo); k < r.msgs.length; k++) {
      const m = r.msgs[k] as Message;
      const [mf, mt] = msgSpan(m);
      if (anchorLess(hi, mf)) break;
      if (anchorLess(mt, lo)) continue;
      let a = m.from;
      let b = spanEnd(m);
      if (lo.turn === mf.turn && lo.node > a) a = lo.node;
      if (hi.turn === mf.turn && hi.node < b) b = hi.node;
      if (a > b) continue;
      msgs.push(sliceNodes(m, a, b));
    }
    if (msgs.length === 0) return undefined;
    const [from] = msgSpan(msgs[0] as Message);
    const [, to] = msgSpan(msgs[msgs.length - 1] as Message);
    return { from, to, msgs };
  }

  trimOldestTo(limit: number): void {
    if (limit < 0) limit = 0;
    let drop = this.count() - limit;
    while (drop > 0 && this.ranges.length > 0) {
      const r = this.ranges[0] as MutableRange;
      if (r.msgs.length <= drop) {
        drop -= r.msgs.length;
        this.ranges.shift();
        continue;
      }
      r.msgs = r.msgs.slice(drop);
      r.from = msgSpan(r.msgs[0] as Message)[0];
      return;
    }
  }

  forEach(fn: (m: Message) => boolean): void {
    for (const r of this.ranges) for (const m of r.msgs) if (!fn(m)) return;
  }

  query(from: Anchor, to: Anchor): Segment[] {
    if (from.turn === 0) from = { turn: 1, node: 0 };
    if (to.turn === 0) return [];
    if (anchorLess(to, from)) return [];
    if (this.ranges.length === 0) {
      if (this.moreValue.before || this.moreValue.after) return [{ msgs: [], gap: { from, to } }];
      return [];
    }
    const lo0 = (this.ranges[0] as MutableRange).from;
    if (anchorLess(from, lo0) && !this.moreValue.before) from = lo0;
    const hi0 = (this.ranges[this.ranges.length - 1] as MutableRange).to;
    if (anchorLess(hi0, to) && !this.moreValue.after) to = hi0;
    if (anchorLess(to, from)) return [];

    const segs: { msgs: readonly Message[]; gap?: Gap }[] = [];
    let cur = from;
    for (let k = this.firstRangeAtOrAfter(from); k < this.ranges.length; k++) {
      const r = this.ranges[k] as MutableRange;
      if (anchorLess(r.to, from)) continue;
      if (anchorLess(to, r.from)) break;
      let lo = r.from;
      let hi = r.to;
      if (anchorLess(lo, cur)) lo = cur;
      if (anchorLess(to, hi)) hi = to;
      if (anchorLess(cur, lo)) segs.push({ msgs: [], gap: { from: cur, to: anchorPrev(lo) } });
      segs.push({ msgs: this.window(r, lo, hi) });
      cur = anchorNext(hi);
      if (anchorLess(to, cur)) break;
    }
    if (!anchorLess(to, cur)) {
      const g: Gap = { from: cur, to };
      const last = segs[segs.length - 1];
      if (last && last.gap === undefined) last.gap = g;
      else segs.push({ msgs: [], gap: g });
    }
    return fuseGaps(segs);
  }

  private window(r: MutableRange, lo: Anchor, hi: Anchor): readonly Message[] {
    if (sameAnchor(lo, r.from) && sameAnchor(hi, r.to)) return r.msgs;
    const i = firstMsgAtOrAfter(r.msgs, lo);
    if (i >= r.msgs.length) return [];
    const j = sortSearch(r.msgs.length, (k) => anchorLess(hi, msgSpan(r.msgs[k] as Message)[0])) - 1;
    if (j < i) return [];
    if (!anchorLess(msgSpan(r.msgs[i] as Message)[0], lo)) {
      if (!anchorLess(hi, msgSpan(r.msgs[j] as Message)[1])) return r.msgs.slice(i, j + 1);
    }
    return this.keep(r, lo, hi)?.msgs ?? [];
  }

  private bound(from: Anchor, to: Anchor): [Anchor, Anchor, boolean] {
    if (from.turn === 0) from = { turn: 1, node: 0 };
    if (to.turn === 0 || anchorLess(to, from)) return [from, to, false];
    if (this.ranges.length > 0) {
      const lo = (this.ranges[0] as MutableRange).from;
      if (anchorLess(from, lo) && !this.moreValue.before) from = lo;
      const hi = (this.ranges[this.ranges.length - 1] as MutableRange).to;
      if (anchorLess(hi, to) && !this.moreValue.after) to = hi;
    }
    if (anchorLess(to, from)) return [from, to, false];
    return [from, to, true];
  }

  firstGap(from: Anchor, to: Anchor): Gap | undefined {
    for (const seg of this.query(from, to)) if (seg.gap) return seg.gap;
    return undefined;
  }

  forEachIn(from: Anchor, to: Anchor, fn: (m: Message) => boolean): void {
    if (anchorLess(to, from)) return;
    for (let k = this.firstRangeAtOrAfter(from); k < this.ranges.length; k++) {
      const r = this.ranges[k] as MutableRange;
      if (anchorLess(to, r.from)) return;
      for (let i = firstMsgAtOrAfter(r.msgs, from); i < r.msgs.length; i++) {
        const m = r.msgs[i] as Message;
        if (anchorLess(to, msgSpan(m)[0])) return;
        if (!fn(m)) return;
      }
    }
  }

  forEachSegment(from: Anchor, to: Anchor, msg: (m: Message) => boolean, gap?: (g: Gap) => boolean): void {
    if (this.ranges.length === 0) return;
    const [lo, hi, ok] = this.bound(from, to);
    if (!ok) return;
    let cur = lo;
    for (let k = this.firstRangeAtOrAfter(lo); k < this.ranges.length; k++) {
      const r = this.ranges[k] as MutableRange;
      if (anchorLess(hi, r.from)) break;
      if (anchorLess(cur, r.from) && gap && !gap({ from: cur, to: anchorPrev(r.from) })) return;
      for (let i = firstMsgAtOrAfter(r.msgs, cur); i < r.msgs.length; i++) {
        const m = r.msgs[i] as Message;
        if (anchorLess(hi, msgSpan(m)[0])) return;
        if (!msg(m)) return;
      }
      cur = anchorNext(r.to);
      if (anchorLess(hi, cur)) return;
    }
    if (!anchorLess(hi, cur) && gap) gap({ from: cur, to: hi });
  }

  rangesHeld(): readonly Range[] {
    return this.ranges.map((r) => ({ from: r.from, to: r.to, msgs: r.msgs.slice() }));
  }

  top(): Anchor | undefined {
    const last = this.ranges[this.ranges.length - 1];
    return last?.to;
  }

  tailFrom(n: number): Anchor | undefined {
    if (n <= 0) return undefined;
    for (let i = this.ranges.length - 1; i >= 0; i--) {
      const msgs = (this.ranges[i] as MutableRange).msgs;
      if (n <= msgs.length) return msgSpan(msgs[msgs.length - n] as Message)[0];
      n -= msgs.length;
    }
    return undefined;
  }

  skip(a: Anchor, n: number): Anchor | undefined {
    if (n < 0) return undefined;
    for (let k = this.firstRangeAtOrAfter(a); k < this.ranges.length; k++) {
      const r = this.ranges[k] as MutableRange;
      const i = firstMsgAtOrAfter(r.msgs, a);
      const rest = r.msgs.length - i;
      if (n >= rest) {
        n -= rest;
        continue;
      }
      return msgSpan(r.msgs[i + n] as Message)[0];
    }
    return undefined;
  }

  before(a: Anchor, n: number): { readonly at: Anchor; readonly moved: number } {
    if (n <= 0) return { at: a, moved: 0 };
    let got = a;
    let moved = 0;
    for (let i = this.ranges.length - 1; i >= 0 && moved < n; i--) {
      const msgs = (this.ranges[i] as MutableRange).msgs;
      if (!anchorLess((this.ranges[i] as MutableRange).from, a)) continue;
      for (let k = firstMsgAtOrAfter(msgs, a) - 1; k >= 0 && moved < n; k--) {
        const from = msgSpan(msgs[k] as Message)[0];
        if (!anchorLess(from, a)) continue;
        got = from;
        moved++;
      }
    }
    return { at: got, moved };
  }

  count(): number {
    let n = 0;
    for (const r of this.ranges) n += r.msgs.length;
    return n;
  }

  first(): Message | undefined {
    return this.ranges[0]?.msgs[0];
  }

  all(): Message[] {
    const out: Message[] = [];
    for (const r of this.ranges) out.push(...r.msgs);
    return out;
  }

  setMore(m: Extent): void {
    this.moreValue = { before: m.before, after: m.after };
  }

  more(): Extent {
    return this.moreValue;
  }

  openTurn(): number {
    return this.open.turn;
  }

  openV(): number {
    return this.open.v;
  }

  setOpenV(v: number): void {
    this.open.v = v;
  }

  liveFrom(): number {
    return this.open.from;
  }

  setLiveFrom(n: number): void {
    this.open.from = n;
  }

  openLen(): number {
    return this.open.nodes.length;
  }

  claimOpen(turn: number): void {
    if (this.open.turn !== turn) {
      this.resetOpen();
      this.open.turn = turn;
    }
  }

  resetOpen(): void {
    this.open = emptyOpen();
  }

  openNodes(): Node[] {
    return this.open.nodes.slice();
  }

  absorb(from: number, nodes: readonly Node[]): void {
    const need = from + nodes.length;
    while (this.open.nodes.length < need) this.open.nodes.push({ type: "" });
    for (let i = 0; i < nodes.length; i++) this.open.nodes[from + i] = nodes[i] as Node;
    this.noteHeld(from, need);
  }

  foldAt(id: number, next: (n: Node) => Node): void {
    while (this.open.nodes.length <= id) this.open.nodes.push({ type: "" });
    this.open.nodes[id] = next(this.open.nodes[id] as Node);
    this.noteHeld(id, id + 1);
  }

  openHead(): number {
    return this.open.held ? this.open.base : 0;
  }

  private noteHeld(from: number, end: number): void {
    if (!this.open.held) {
      this.open.base = from;
      this.open.held = true;
      return;
    }
    if (from < this.open.base && end >= this.open.base) this.open.base = from;
  }

  openBase(emitted: number): number {
    let n = this.open.from;
    if (emitted > n) n = emitted;
    const h = this.openHead();
    if (h > n) n = h;
    if (n < 0 || n > this.open.nodes.length) n = 0;
    return n;
  }

  openSuffix(emitted: number): Node[] {
    return this.open.nodes.slice(this.openBase(emitted));
  }

  openSlice(emitted: number, n: number): Node[] {
    return this.open.nodes.slice(emitted, n);
  }

  openAnimating(): boolean {
    if (this.open.turn === 0) return false;
    return this.open.nodes.some((n) => n.type === "tool" && n.status === "running");
  }

  openNode(turn: number, id: number): Node | undefined {
    if (this.open.turn !== turn || id < this.openHead() || id >= this.open.nodes.length) return undefined;
    return this.open.nodes[id];
  }

  nodeAt(turn: number, id: number): Node | undefined {
    const live = this.openNode(turn, id);
    if (live) return live;
    const at: Anchor = { turn, node: id };
    const k = this.firstRangeAtOrAfter(at);
    const r = this.ranges[k];
    if (!r) return undefined;
    const i = firstMsgAtOrAfter(r.msgs, at);
    const m = r.msgs[i];
    if (!m || m.turn !== turn || id < m.from || id > spanEnd(m) || m.nodes.length === 0) return undefined;
    return m.nodes[id - m.from];
  }
}

function fuseGaps(input: { msgs: readonly Message[]; gap?: Gap }[]): Segment[] {
  const out: { msgs: readonly Message[]; gap?: Gap }[] = [];
  for (const seg of input) {
    const last = out[out.length - 1];
    if (seg.gap && seg.msgs.length === 0 && last && last.gap === undefined) {
      last.gap = seg.gap;
      continue;
    }
    out.push(seg);
  }
  return out;
}

export function fillAt(g: Gap): Anchor {
  return anchorNext(g.to);
}
