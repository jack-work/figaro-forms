import { ConnectionLost } from "../rpc.js";
import type { AriaClient } from "./client.js";
import { ariaRefusal, AriaUnavailable, type AriaRefusal } from "./errors.js";
import { Transcript, type Changed, type View } from "./fold.js";
import type { Fetcher, Message } from "./store.js";
import {
  ariaMethod,
  type Anchor,
  type AriaFrame,
  type DoneEntry,
  type ForkResponse,
  type InterruptResponse,
  type Metrics,
  type Page,
  type TurnPart,
  type QuaImage,
  type QuaResponse,
  type QueueDisposition,
  type TurnDone,
} from "./wire.js";

export type Phase = "connecting" | "catching-up" | "live" | "offline" | "refused" | "gone" | "closed" | "detached";

export interface AttachOptions {
  readonly from?: "tail" | "start";
  readonly cursor?: number;
  readonly pageBytes?: number;
}

export interface TurnEnd {
  readonly turn: number;
  readonly replayed: boolean;
  readonly done?: DoneEntry;
}

export interface AriaSnapshot {
  readonly aria: string;
  readonly view: View;
  readonly metrics: Metrics | undefined;
  readonly done: DoneEntry | undefined;
  readonly ends: readonly TurnEnd[];
  readonly phase: Phase;
  readonly refusal: AriaRefusal | undefined;
  readonly error: string | undefined;
  readonly cursor: number;
  readonly olderAvailable: boolean | undefined;
}

export interface AppliedFrame {
  readonly aria: string;
  readonly source: "read" | "push";
  readonly frame: Page;
  readonly closed: readonly Message[];
  readonly open: Message | undefined;
  readonly nodes: readonly Changed[];
  readonly sealed: readonly number[];
  readonly desync: number | undefined;
  readonly metrics: Metrics | undefined;
}

type Queued = { readonly k: "frame"; readonly frame: AriaFrame } | { readonly k: "done"; readonly done: TurnDone };

const retryAfterMs = 2000;
const maxPages = 10_000;
const wireBytesPerMessage = 4096;

const wireBudget = (messages: number): number => (messages <= 0 ? 0 : messages * wireBytesPerMessage);

export class AriaStream {
  readonly aria: string;
  readonly transcript = new Transcript();
  private readonly host: AriaClient;
  private readonly opts: AttachOptions;
  private readonly frameSubs = new Set<(a: AppliedFrame) => void>();
  private readonly doneSubs = new Set<(d: DoneEntry) => void>();
  private readonly endSubs = new Set<(e: TurnEnd) => void>();
  private readonly endLog = new Map<number, TurnEnd>();
  private sealedByPush: number | undefined;
  private readonly versions = new Map<number, number>();
  private readonly changed = new Set<() => void>();
  private readonly ended = new Set<() => void>();
  private readonly waiters: { resolve(): void; reject(e: unknown): void }[] = [];
  private generation = -1;
  private phase: Phase = "connecting";
  private refusal: AriaRefusal | undefined;
  private error: string | undefined;
  private lastMetrics: Metrics | undefined;
  private lastDone: DoneEntry | undefined;
  private buffering = false;
  private buffer: Queued[] = [];
  private catching = false;
  private again = false;
  private snap: AriaSnapshot | undefined;
  private older: boolean | undefined;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private closed = false;
  private resumeFrom: number;

  constructor(host: AriaClient, aria: string, opts: AttachOptions = {}) {
    this.host = host;
    this.aria = aria;
    this.opts = opts;
    this.resumeFrom = opts.cursor ?? 0;
    this.transcript.setFetcher(this.history());
  }

  get cursor(): number {
    return this.transcript.cursor();
  }

  get state(): Phase {
    return this.phase;
  }

  snapshot(): AriaSnapshot {
    if (!this.snap) {
      this.snap = {
        aria: this.aria,
        view: this.transcript.view(),
        metrics: this.lastMetrics,
        done: this.lastDone,
        ends: [...this.endLog.values()].sort((a, b) => a.turn - b.turn),
        phase: this.phase,
        refusal: this.refusal,
        error: this.error,
        cursor: this.transcript.cursor(),
        olderAvailable: this.older,
      };
    }
    return this.snap;
  }

  onFrame(fn: (a: AppliedFrame) => void): () => void {
    this.frameSubs.add(fn);
    return () => this.frameSubs.delete(fn);
  }

  onDone(fn: (d: DoneEntry) => void): () => void {
    this.doneSubs.add(fn);
    return () => this.doneSubs.delete(fn);
  }

  onTurnEnd(fn: (e: TurnEnd) => void): () => void {
    this.endSubs.add(fn);
    return () => this.endSubs.delete(fn);
  }

  onChange(fn: () => void): () => void {
    this.changed.add(fn);
    return () => this.changed.delete(fn);
  }

  frames(): AsyncIterableIterator<AppliedFrame> {
    const queue: AppliedFrame[] = [];
    let wake: (() => void) | undefined;
    let over = this.closed;
    const off = this.onFrame((a) => {
      queue.push(a);
      wake?.();
    });
    const offEnd = this.onEnd(() => {
      over = true;
      wake?.();
    });
    const stop = (): void => {
      off();
      offEnd();
      over = true;
    };
    const it: AsyncIterableIterator<AppliedFrame> = {
      next: async () => {
        for (;;) {
          const a = queue.shift();
          if (a) return { value: a, done: false };
          if (over) {
            stop();
            return { value: undefined, done: true };
          }
          await new Promise<void>((r) => (wake = r));
          wake = undefined;
        }
      },
      return: async () => {
        stop();
        return { value: undefined, done: true };
      },
      [Symbol.asyncIterator]: () => it,
    };
    return it;
  }

  ready(): Promise<void> {
    if (this.phase === "live") return Promise.resolve();
    if (this.closed) return Promise.reject(new Error(`${this.aria}: stream closed`));
    if (this.refusal) return Promise.reject(new AriaUnavailable(this.aria, this.refusal));
    return new Promise((resolve, reject) => this.waiters.push({ resolve, reject }));
  }

  qua(text: string, o?: { readonly images?: readonly QuaImage[] }): Promise<QuaResponse> {
    return this.host.qua(this.aria, text, o);
  }

  interrupt(o?: { readonly queue?: QueueDisposition }): Promise<InterruptResponse> {
    return this.host.interrupt(this.aria, o);
  }

  fork(o?: { readonly atTurn?: number; readonly atLT?: number; readonly outfits?: readonly string[] }): Promise<ForkResponse> {
    return this.host.fork(this.aria, o);
  }

  async loadOlder(messages = 0): Promise<boolean> {
    const at = this.transcript.oldestHeld();
    if (!at || this.older === false) return false;
    const page = await this.host.read(this.aria, { at, backward: true, limit: wireBudget(messages) || this.opts.pageBytes || 0 });
    this.transcript.apply(page, "quiet");
    this.transcript.setMoreBefore(page.more.before ?? false);
    this.older = page.more.before ?? false;
    this.touch();
    return page.parts.length > 0;
  }

  async ensure(from: Anchor, to: Anchor): Promise<void> {
    try {
      await this.transcript.ensure(from, to);
    } finally {
      this.older = this.transcript.moreBefore();
      this.touch();
    }
  }

  retry(): void {
    if (this.closed || !this.host.connection.live) return;
    this.connected(this.host.connection.epoch);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.generation = -1;
    this.setPhase("detached");
    for (const w of this.waiters.splice(0)) w.reject(new Error(`${this.aria}: stream closed`));
    for (const fn of [...this.ended]) fn();
    this.frameSubs.clear();
    this.doneSubs.clear();
    this.endSubs.clear();
    this.transcript.detach();
    this.host.detach(this);
  }

  connected(generation: number): void {
    if (this.closed) return;
    this.generation = generation;
    void this.start(generation);
  }

  disconnected(reason: string): void {
    if (this.closed) return;
    this.generation = -1;
    this.buffering = false;
    this.buffer = [];
    this.versions.clear();
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.setPhase("offline", undefined, reason);
  }

  push(frame: AriaFrame, generation: number): void {
    if (this.closed || generation !== this.generation) return;
    if (this.buffering) {
      this.buffer.push({ k: "frame", frame });
      return;
    }
    if (this.applyFrame(frame, "push")) void this.resync(generation);
  }

  turnDone(done: TurnDone, generation: number): void {
    if (this.closed || generation !== this.generation) return;
    if (this.buffering) {
      this.buffer.push({ k: "done", done });
      return;
    }
    this.applyDone(done);
  }

  ariaClosed(): void {
    if (this.closed) return;
    this.setPhase("closed");
  }

  private history(): Fetcher {
    return (before, limit) => this.host.read(this.aria, { at: before, backward: true, limit: wireBudget(limit) });
  }

  private onEnd(fn: () => void): () => void {
    this.ended.add(fn);
    return () => this.ended.delete(fn);
  }

  private stale(generation: number): boolean {
    return this.closed || generation !== this.generation;
  }

  private async start(generation: number): Promise<void> {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.versions.clear();
    this.sealedByPush = undefined;
    this.refusal = undefined;
    this.setPhase("connecting");
    this.buffering = true;
    this.buffer = [];
    try {
      await this.host.follow(this.aria);
      if (this.stale(generation)) return;
      await this.catchUp(generation);
    } catch (e) {
      if (this.stale(generation)) return;
      this.buffering = false;
      this.buffer = [];
      if (e instanceof ConnectionLost) return;
      const refusal = ariaRefusal(e);
      if (refusal) {
        this.setPhase(refusal.kind === "not_found" ? "gone" : "refused", refusal);
        for (const w of this.waiters.splice(0)) w.reject(new AriaUnavailable(this.aria, refusal));
        return;
      }
      this.setPhase("offline", undefined, e instanceof Error ? e.message : String(e));
      this.retryTimer = setTimeout(() => {
        if (!this.stale(generation)) void this.start(generation);
      }, retryAfterMs);
    }
  }

  private async catchUp(generation: number): Promise<void> {
    this.catching = true;
    try {
      do {
        this.again = false;
        this.setPhase("catching-up");
        await this.readForward(generation);
        if (this.stale(generation)) return;
      } while (this.again);
    } finally {
      if (!this.stale(generation)) this.catching = false;
    }
    this.buffering = false;
    const queued = this.buffer;
    this.buffer = [];
    let resync = false;
    for (const q of queued) {
      if (q.k === "frame") resync = this.applyFrame(q.frame, "push") || resync;
      else this.applyDone(q.done);
    }
    this.setPhase("live");
    for (const w of this.waiters.splice(0)) w.resolve();
    if (resync) void this.resync(generation);
  }

  private async resync(generation: number): Promise<void> {
    if (this.catching) {
      this.again = true;
      return;
    }
    this.buffering = true;
    this.buffer = [];
    try {
      await this.catchUp(generation);
    } catch (e) {
      if (this.stale(generation) || e instanceof ConnectionLost) return;
      this.buffering = false;
      this.buffer = [];
      this.setPhase("offline", undefined, e instanceof Error ? e.message : String(e));
      this.retryTimer = setTimeout(() => {
        if (!this.stale(generation)) void this.start(generation);
      }, retryAfterMs);
    }
  }

  private async readForward(generation: number): Promise<void> {
    const fresh = !this.transcript.heard() && this.resumeFrom === 0;
    const tail = fresh && this.opts.from !== "start";
    const wasHeard = this.transcript.heard();
    const resume = Math.max(this.transcript.cursor(), this.resumeFrom);
    let at: Anchor | undefined = tail || resume === 0 ? undefined : { turn: resume, node: 0 };
    if (!wasHeard && resume > 0 && this.older === undefined) {
      this.transcript.setMoreBefore(true);
      this.older = true;
    }
    for (let i = 0; i < maxPages; i++) {
      const page = await this.host.read(this.aria, {
        ...(at ? { at } : {}),
        ...(tail ? { backward: true } : {}),
        ...(this.opts.pageBytes ? { limit: this.opts.pageBytes } : {}),
      });
      if (this.stale(generation)) return;
      this.deliver(page, "read");
      if (tail) {
        this.transcript.setMoreBefore(page.more.before ?? false);
        this.older = page.more.before ?? false;
        this.touch();
        return;
      }
      const next = page.more.after ? page.next : undefined;
      if (!next || (at && next.turn === at.turn && next.node === at.node)) return;
      at = next;
    }
  }

  private repeated(part: TurnPart): boolean {
    const live = part.live;
    if (!live || (live.nodes ?? []).length === 0 || live.v === 0) return false;
    const seen = this.versions.get(part.turn);
    return seen !== undefined && live.v <= seen;
  }

  private noteVersions(page: Page): void {
    for (const part of page.parts) {
      if (part.sealed) {
        this.versions.delete(part.turn);
        continue;
      }
      const live = part.live;
      if (live && ((live.nodes ?? []).length > 0 || (part.nodes ?? []).length > 0)) this.versions.set(part.turn, live.v);
    }
  }

  private deliver(page: Page, source: "read" | "push"): AppliedFrame | undefined {
    if (source === "push" && page.parts.some((p) => this.repeated(p))) {
      const parts = page.parts.filter((p) => !this.repeated(p));
      if (parts.length === 0 && !page.metrics) return undefined;
      page = { ...page, parts };
    }
    this.noteVersions(page);
    const applied = this.transcript.apply(page, "quiet");
    if (applied.metrics) this.lastMetrics = applied.metrics;
    const out: AppliedFrame = {
      aria: this.aria,
      source,
      frame: page,
      closed: applied.closed,
      open: applied.open,
      nodes: this.transcript.touched(page),
      sealed: applied.sealed,
      desync: applied.desync,
      metrics: applied.metrics,
    };
    if (source === "read") {
      for (const turn of applied.sealed) if (!this.endLog.has(turn)) this.recordEnd({ turn, replayed: true });
    } else if (applied.sealed.length > 0) {
      const sealed = Math.max(...applied.sealed);
      if (!this.endLog.has(sealed)) this.sealedByPush = sealed;
    }
    this.touch();
    for (const fn of [...this.frameSubs]) this.tell(() => fn(out));
    return out;
  }

  private applyFrame(frame: AriaFrame, source: "read" | "push"): boolean {
    return this.deliver(frame, source)?.desync !== undefined;
  }

  private applyDone(done: DoneEntry): void {
    const entry: DoneEntry = { reason: done.reason, ...(done.idle !== undefined ? { idle: done.idle } : {}) };
    this.lastDone = entry;
    const open = this.transcript.open()?.turn;
    const turn = open !== undefined && (this.sealedByPush === undefined || open > this.sealedByPush) ? open : (this.sealedByPush ?? this.transcript.cursor());
    this.sealedByPush = undefined;
    this.recordEnd({ turn, replayed: false, done: entry });
    for (const fn of [...this.doneSubs]) this.tell(() => fn(entry));
  }

  private recordEnd(e: TurnEnd): void {
    this.endLog.set(e.turn, e);
    this.touch();
    for (const fn of [...this.endSubs]) this.tell(() => fn(e));
  }

  private tell(fn: () => void): void {
    try {
      fn();
    } catch (err) {
      setTimeout(() => {
        throw err;
      }, 0);
    }
  }

  private setPhase(phase: Phase, refusal?: AriaRefusal, error?: string): void {
    this.phase = phase;
    this.refusal = refusal;
    this.error = error;
    this.touch();
  }

  private touch(): void {
    this.snap = undefined;
    for (const fn of [...this.changed]) fn();
  }
}
