import type { Json } from "../json.js";
import {
  anchorLess,
  anchorPrev,
  anchorZero,
  fillAt,
  Store,
  StalledError,
  type Extent,
  type Fetcher,
  type Gap,
  type Message,
  type Segment,
} from "./store.js";
import { spliceBytes, utf8Length } from "./utf8.js";
import { roleInput, roleOutput, type Anchor, type FormDelta, type InquirySegment, type Metrics, type Node, type NodeDelta, type Page, type Src, type TurnPart } from "./wire.js";

export interface Inquiry {
  readonly text: string;
  readonly segments?: readonly InquirySegment[];
  readonly formDeltas?: { readonly [key: string]: FormDelta };
  readonly lt?: number;
}

export interface View {
  readonly closed: readonly Message[];
  readonly open: Message | undefined;
}

export type Fold = "notify" | "quiet";

export interface Changed {
  readonly turn: number;
  readonly id: number;
  readonly node: Node;
  readonly delta?: NodeDelta;
}

export interface Applied {
  readonly sealed: readonly number[];
  readonly closed: readonly Message[];
  readonly open: Message | undefined;
  readonly desync: number | undefined;
  readonly metrics: Metrics | undefined;
}

export interface Hooks {
  onClosed?: (m: Message) => void;
  onLive?: (m: Message) => void;
  onDesync?: (sinceTurn: number) => void;
  onMetrics?: (m: Metrics) => void;
}

const ensureRounds = 64;
const fillLimit = 30;
const unitChars = 40000;

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

export class Transcript {
  private store = new Store();
  private closedLimit = 0;
  private closedRev = 0;
  private rev = 0;
  private heardValue = false;
  private lastCommitted = 0;
  private emitted = new Map<number, number>();
  private inquiry = new Map<number, Mutable<Inquiry>>();
  private fetch: Fetcher | undefined;
  private sealedSeen = new Set<number>();
  private sealedNow: number[] = [];
  private offeredCount = 0;
  hooks: Hooks = {};

  held(): Store {
    return this.store;
  }

  query(from: Anchor, to: Anchor): Segment[] {
    return this.store.query(from, to);
  }

  forEachIn(from: Anchor, to: Anchor, fn: (m: Message) => boolean): void {
    this.store.forEachIn(from, to, fn);
  }

  setFetcher(f: Fetcher | undefined): void {
    this.fetch = f;
  }

  async ensure(from: Anchor, to: Anchor, signal?: AbortSignal): Promise<void> {
    for (let round = 0; round < ensureRounds; round++) {
      signal?.throwIfAborted();
      const gap = this.store.firstGap(from, to);
      const fetch = this.fetch;
      const before = this.store.count();
      if (!gap) return;
      if (!fetch) throw new Error("aria: range store has no fetcher");
      const got = await fetch(fillAt(gap), fillLimit);
      this.foldPage(got);
      this.store.setMore({ before: got.more.before ?? false, after: this.store.more().after });
      if (this.store.count() === before) throw new StalledError();
    }
    throw new StalledError();
  }

  forEachSegment(from: Anchor, to: Anchor, msg: (m: Message) => boolean, gap?: (g: Gap) => boolean): void {
    this.store.forEachSegment(from, to, msg, gap);
  }

  count(): number {
    return this.store.count();
  }

  tailFrom(n: number): Anchor | undefined {
    return this.store.tailFrom(n);
  }

  skip(a: Anchor, n: number): Anchor | undefined {
    return this.store.skip(a, n);
  }

  before(a: Anchor, n: number): { readonly at: Anchor; readonly moved: number } {
    return this.store.before(a, n);
  }

  evictBefore(a: Anchor): void {
    if (anchorZero(a) || this.store.count() === 0) return;
    const before = this.store.count();
    this.store.evict({ turn: 0, node: 0 }, anchorPrev(a));
    if (this.store.count() !== before) {
      this.closedRev++;
      this.rev++;
    }
    for (const id of [...this.inquiry.keys()]) if (id < a.turn) this.inquiry.delete(id);
  }

  cloneBelow(base: number): Transcript {
    const out = new Transcript();
    out.closedLimit = this.closedLimit;
    if (base <= 0) return out;
    out.store = this.store.cloneBelow(base);
    for (const [id, inq] of this.inquiry) if (id < base) out.inquiry.set(id, { ...inq });
    for (const [id, n] of this.emitted) if (id < base) out.emitted.set(id, n);
    for (const id of this.sealedSeen) if (id < base) out.sealedSeen.add(id);
    out.lastCommitted = Math.min(this.lastCommitted, base - 1);
    return out;
  }

  detach(): void {
    this.hooks = {};
    this.fetch = undefined;
  }

  inquiryOf(turn: number): Inquiry | undefined {
    return this.inquiry.get(turn);
  }

  setMoreBefore(more: boolean): void {
    this.store.setMore({ before: more, after: this.store.more().after });
  }

  setMoreAfter(more: boolean): void {
    this.store.setMore({ before: this.store.more().before, after: more });
  }

  moreBefore(): boolean {
    return this.store.more().before;
  }

  moreAfter(): boolean {
    return this.store.more().after;
  }

  extent(): Extent {
    return this.store.more();
  }

  firstMissing(): number | undefined {
    const top = this.store.top();
    if (!top) return undefined;
    return this.store.complete(top.turn) ? top.turn + 1 : top.turn;
  }

  setClosedLimit(limit: number): void {
    this.closedLimit = limit;
    this.trimClosed();
  }

  offered(): number {
    return this.offeredCount;
  }

  cursor(): number {
    return this.lastCommitted;
  }

  openAnimating(): boolean {
    return this.store.openAnimating();
  }

  apply(p: Page, mode: Fold = "notify"): Applied {
    this.sealedNow = [];
    const { finalized, desync } = this.foldPage(p);
    const sealed = this.sealedNow;
    this.rev++;
    this.heardValue = true;
    const haveLive = this.store.openTurn() !== 0;
    const open = haveLive ? this.openMessage() : undefined;
    const applied: Applied = { sealed, closed: finalized, open, desync: desync >= 0 ? desync : undefined, metrics: p.metrics };
    if (mode === "quiet") return applied;
    const h = this.hooks;
    if (p.metrics && h.onMetrics) h.onMetrics(p.metrics);
    for (const m of finalized) h.onClosed?.(m);
    if (open && h.onLive) h.onLive(open);
    if (desync >= 0) h.onDesync?.(desync);
    return applied;
  }

  closedRevision(): number {
    return this.closedRev + 1;
  }

  revision(): number {
    return this.rev + 1;
  }

  heard(): boolean {
    return this.heardValue;
  }

  openKey(): { readonly turn: number; readonly from: number } | undefined {
    const turn = this.store.openTurn();
    if (turn === 0) return undefined;
    return { turn, from: this.store.openBase(this.openStart(turn)) };
  }

  open(): Message | undefined {
    return this.store.openTurn() === 0 ? undefined : this.openMessage();
  }

  view(): View {
    return { closed: this.store.all(), open: this.store.openTurn() === 0 ? undefined : this.openMessage() };
  }

  contiguous(a: Anchor): boolean {
    if (this.store.count() === 0) return false;
    const top = this.store.tailFrom(1);
    if (!top) return false;
    return this.store.firstGap(a, top) === undefined;
  }

  node(turn: number, id: number): Node | undefined {
    return this.store.nodeAt(turn, id);
  }

  oldestHeld(): Anchor | undefined {
    const first = this.store.first();
    if (first) return { turn: first.turn, node: first.from };
    const open = this.openKey();
    return open ? { turn: open.turn, node: open.from } : undefined;
  }

  touched(frame: Page): readonly Changed[] {
    const out: Changed[] = [];
    const seen = new Set<string>();
    for (const part of frame.parts) {
      const ids: { id: number; delta?: NodeDelta }[] = [];
      (part.nodes ?? []).forEach((_, i) => ids.push({ id: part.from + i }));
      for (const d of part.live?.nodes ?? []) ids.push({ id: d.id, delta: d });
      for (const { id, delta } of ids) {
        const node = this.store.nodeAt(part.turn, id);
        if (!node) continue;
        const key = `${part.turn}.${id}`;
        if (delta === undefined && seen.has(key)) continue;
        seen.add(key);
        out.push(delta ? { turn: part.turn, id, node, delta } : { turn: part.turn, id, node });
      }
    }
    return out;
  }

  private foldPage(p: Page): { finalized: Message[]; desync: number } {
    let finalized: Message[] = [];
    let desync = -1;

    for (const part of p.parts) {
      const id = part.turn;
      const staged = this.claimsOpen(part);

      if ((part.inquiry ?? "") !== "" || Object.keys(part.formDeltas ?? {}).length > 0) {
        const q: Mutable<Inquiry> = { ...(this.inquiry.get(id) ?? { text: "" }) };
        if ((part.inquiry ?? "") !== "") {
          q.text = part.inquiry as string;
          if (part.inquiry_segments && part.inquiry_segments.length > 0) q.segments = part.inquiry_segments;
          else delete q.segments;
        }
        if (part.formDeltas && Object.keys(part.formDeltas).length > 0) q.formDeltas = part.formDeltas;
        if (part.lts && part.lts.length > 0) q.lt = part.lts[0] as number;
        this.inquiry.set(id, q);
        if (staged && !part.clipped_head) this.store.claimOpen(id);
      }

      let reclaimed = -1;
      const nodes = part.nodes ?? [];
      if (nodes.length > 0 && staged) {
        this.store.claimOpen(id);
        const head = this.store.openHead();
        this.store.absorb(part.from, nodes);
        if (this.store.openHead() < head) reclaimed = head;
      }

      if (part.live && staged) {
        this.store.claimOpen(id);
        this.store.setLiveFrom(part.live.from);
        for (const nd of part.live.nodes ?? []) this.store.foldAt(nd.id, (n) => foldDelta(n, nd));
        const lo = this.openStart(id);
        const n = this.store.liveFrom();
        if (n > lo && n <= this.store.openLen()) {
          finalized = this.appendUnits(finalized, id, lo, this.store.openSlice(lo, n));
          this.emitted.set(id, n);
        }
        if ((part.live.nodes ?? []).length > 0) this.store.setOpenV(part.live.v);
        else if (this.store.openV() !== part.live.v && nodes.length === 0) desync = this.lastCommitted;
      }

      if (reclaimed >= 0 && staged) {
        const lo = this.store.openHead();
        const hi = Math.min(reclaimed, this.store.liveFrom());
        if (hi > lo) {
          finalized = this.appendUnits(finalized, id, lo, this.store.openSlice(lo, hi));
          if (hi > (this.emitted.get(id) ?? 0)) this.emitted.set(id, hi);
        }
      }

      if (!part.sealed) continue;
      if (!this.sealedSeen.has(id)) {
        this.sealedSeen.add(id);
        this.sealedNow.push(id);
      }
      if (staged) {
        let all: readonly Node[] = nodes;
        if (this.store.openLen() >= all.length) all = this.store.openNodes();
        const s = this.openStart(id);
        if (s < all.length) {
          finalized = this.appendUnits(finalized, id, s, all.slice(s));
          this.store.setTurnLen(id, all.length);
        } else if (s === 0 && (this.inquiry.get(id)?.text ?? "") !== "") {
          finalized.push(this.message(id, 0, []));
          this.store.setTurnLen(id, 1);
        } else if (all.length > 0) {
          this.store.setTurnLen(id, all.length);
        }
      } else if (nodes.length > 0) {
        finalized = this.appendUnits(finalized, id, part.from, nodes.slice());
        if (!part.clipped_tail) this.store.setTurnLen(id, part.from + nodes.length);
      } else if ((this.inquiry.get(id)?.text ?? "") !== "") {
        finalized.push(this.message(id, 0, []));
        if (!part.clipped_tail) this.store.setTurnLen(id, 1);
      }
      this.emitted.delete(id);
      this.advanceCommitted(id);
      if (this.store.openTurn() === id) this.store.resetOpen();
    }

    if (finalized.length > 0) {
      finalized = this.store.insert(...finalized);
      this.closedRev++;
      this.rev++;
    }
    this.adoptMoreAfter(p);
    this.trimClosed();
    return { finalized, desync };
  }

  private adoptMoreAfter(p: Page): void {
    if (p.parts.length === 0) return;
    const top = spanTop(p);
    let covered = this.store.top();
    const id = this.store.openTurn();
    if (id !== 0 && this.store.openLen() > this.store.openHead()) {
      const liveTop: Anchor = { turn: id, node: this.store.openLen() - 1 };
      if (!covered || anchorLess(covered, liveTop)) covered = liveTop;
    }
    if (!covered || !anchorLess(top, covered)) {
      this.store.setMore({ before: this.store.more().before, after: p.more.after ?? false });
    }
  }

  private appendUnits(dst: Message[], turn: number, from: number, nodes: readonly Node[]): Message[] {
    this.offeredCount += nodes.length;
    const size = (n: Node): number => utf8Length(n.markdown ?? "") + utf8Length(n.output ?? "") + utf8Length(n.summary ?? "");
    let total = 0;
    for (const n of nodes) total += size(n);
    if (total < unitChars || nodes.length < 2) {
      dst.push(this.message(turn, from, nodes));
      return dst;
    }
    let start = 0;
    let budget = 0;
    for (let i = 0; i < nodes.length; i++) {
      budget += size(nodes[i] as Node);
      if (budget < unitChars && i < nodes.length - 1) continue;
      dst.push(this.message(turn, from + start, nodes.slice(start, i + 1)));
      start = i + 1;
      budget = 0;
    }
    return dst;
  }

  private claimsOpen(part: TurnPart): boolean {
    const id = part.turn;
    const open = this.store.openTurn();
    if (open === id) return true;
    if (open !== 0 && id < open) return false;
    if (part.live) return true;
    if (part.sealed) return false;
    if (this.store.complete(id)) return false;
    return true;
  }

  private message(turn: number, from: number, nodes: readonly Node[]): Message {
    const m: Mutable<Message> = { turn, from, role: nodes.length === 0 ? roleInput : roleOutput, nodes };
    if (from === 0) {
      const q = this.inquiry.get(turn);
      if (q) {
        if (q.text !== "") m.inquiry = q.text;
        if (q.segments && q.segments.length > 0) m.inquirySegments = q.segments;
        if (q.lt) m.inquiryLT = q.lt;
        if (q.formDeltas && Object.keys(q.formDeltas).length > 0) m.formDeltas = q.formDeltas;
      }
    }
    return m;
  }

  private openStart(turn: number): number {
    const e = this.emitted.get(turn) ?? 0;
    if (this.store.openTurn() !== turn) return e;
    const h = this.store.openHead();
    return h > e ? h : e;
  }

  private openMessage(): Message {
    const turn = this.store.openTurn();
    const e = this.openStart(turn);
    return this.message(turn, this.store.openBase(e), this.store.openSuffix(e));
  }

  private trimClosed(): void {
    if (this.closedLimit <= 0 || this.store.count() <= this.closedLimit) return;
    this.closedRev++;
    this.rev++;
    this.store.trimOldestTo(this.closedLimit);
    const first = this.store.first();
    if (!first) return;
    for (const id of [...this.inquiry.keys()]) if (id < first.turn) this.inquiry.delete(id);
  }

  private advanceCommitted(turn: number): void {
    if (turn > this.lastCommitted) this.lastCommitted = turn;
  }
}

function spanTop(p: Page): Anchor {
  let to: Anchor = { turn: 0, node: 0 };
  let first = true;
  for (const part of p.parts) {
    const n = part.nodes?.length ?? 0;
    const hi: Anchor = { turn: part.turn, node: n > 0 ? part.from + n - 1 : part.from };
    if (first || anchorLess(to, hi)) to = hi;
    first = false;
  }
  return to;
}

export function foldDelta(n: Node, d: NodeDelta): Node {
  const out: Record<string, unknown> = { ...n };
  if (d.set) for (const [k, v] of Object.entries(d.set)) setField(out, k, v);
  if (d.unset) for (const f of d.unset) setField(out, f, null);
  if (d.patch) {
    for (const [f, dl] of Object.entries(d.patch)) {
      if (f === "markdown" || f === "output" || f === "input") {
        const prev = typeof out[f] === "string" ? (out[f] as string) : "";
        keep(out, f, spliceBytes(prev, dl.at, dl.del, dl.ins));
      }
    }
  }
  return out as unknown as Node;
}

function keep(n: Record<string, unknown>, field: string, v: unknown): void {
  if (v === "" || v === 0 || v === undefined || v === null || (Array.isArray(v) && v.length === 0)) delete n[field];
  else n[field] = v;
}

const stringFields = new Set(["name", "summary", "sender", "sender_name", "status", "markdown", "role", "tool_call_id", "output", "input", "id"]);
const intFields = new Set(["at", "opened_at", "started_at", "finished_at", "output_base"]);

function setField(n: Record<string, unknown>, field: string, v: unknown): void {
  if (field === "type") {
    n.type = asStr(v);
  } else if (stringFields.has(field)) {
    keep(n, field, asStr(v));
  } else if (intFields.has(field)) {
    keep(n, field, asInt(v));
  } else if (field === "lts") {
    keep(n, field, asUints(v));
  } else if (field === "src") {
    keep(n, field, asSrcs(v));
  } else if (field === "args") {
    if (v === null || v === undefined) delete n.args;
    else if (typeof v === "object" && !Array.isArray(v)) keep(n, "args", Object.keys(v).length === 0 ? undefined : (v as { [k: string]: Json }));
  } else if (field === "formDeltas") {
    keep(n, field, asFormDeltas(v));
  }
}

function asStr(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function asInt(v: unknown): number {
  return typeof v === "number" ? Math.trunc(v) : 0;
}

function asUints(v: unknown): readonly number[] | undefined {
  if (!Array.isArray(v)) return undefined;
  return v.map((e) => asInt(e));
}

function asSrcs(v: unknown): readonly Src[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out: Src[] = [];
  for (const e of v) {
    if (typeof e !== "object" || e === null || Array.isArray(e)) continue;
    const m = e as Record<string, unknown>;
    out.push({ lt: asInt(m.lt), block: asInt(m.block) });
  }
  return out;
}

function asFormDeltas(v: unknown): { readonly [key: string]: FormDelta } | undefined {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return undefined;
  return Object.keys(v).length === 0 ? undefined : (v as { [key: string]: FormDelta });
}
