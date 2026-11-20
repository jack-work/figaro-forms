import { ConnectionLost } from "../rpc.js";
import type { AriaClient } from "./client.js";
import { ariaRefusal, AriaUnavailable, type AriaRefusal } from "./errors.js";
import { matches, type AriaEvent, type EventFilter, type EventOf, type Kind, type TurnView } from "./events.js";
import type { Cursor } from "./cursor.js";
import { Transcript } from "./transcript.js";
import {
  ariaMethod,
  type Anchor,
  type AriaFrame,
  type ForkResponse,
  type InterruptResponse,
  type Metrics,
  type Page,
  type QuaResponse,
  type QueueDisposition,
  type TurnDone,
} from "./wire.js";

export type Phase = "connecting" | "catching-up" | "live" | "offline" | "refused" | "gone" | "closed" | "detached";

export interface AttachOptions {
  readonly cursor?: Cursor;
  readonly from?: "tail" | "start";
  readonly pageBytes?: number;
}

export interface AriaSnapshot {
  readonly aria: string;
  readonly turns: readonly TurnView[];
  readonly metrics: Metrics | undefined;
  readonly phase: Phase;
  readonly refusal: AriaRefusal | undefined;
  readonly error: string | undefined;
  readonly cursor: Cursor;
  readonly olderAvailable: boolean | undefined;
}

type Listener = (e: AriaEvent) => void;

interface Sub {
  readonly fn: Listener;
  readonly filter: EventFilter | undefined;
}

type Queued = { readonly k: "frame"; readonly frame: AriaFrame } | { readonly k: "done"; readonly done: TurnDone };

const retryAfterMs = 2000;
const maxPages = 10_000;

export class AriaStream {
  readonly aria: string;
  private readonly host: AriaClient;
  private readonly opts: AttachOptions;
  private readonly transcript: Transcript;
  private readonly subs = new Set<Sub>();
  private readonly changed = new Set<() => void>();
  private readonly ended = new Set<() => void>();
  private readonly waiters: { resolve(): void; reject(e: unknown): void }[] = [];
  private generation = -1;
  private phase: Phase = "connecting";
  private refusal: AriaRefusal | undefined;
  private error: string | undefined;
  private buffering = false;
  private buffer: Queued[] = [];
  private catching = false;
  private again = false;
  private snap: AriaSnapshot | undefined;
  private older: boolean | undefined;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private closed = false;

  constructor(host: AriaClient, aria: string, opts: AttachOptions = {}) {
    this.host = host;
    this.aria = aria;
    this.opts = opts;
    this.transcript = new Transcript({ aria, ...(opts.cursor !== undefined ? { from: opts.cursor } : {}), emit: (e) => this.deliver(e) });
  }

  get cursor(): Cursor {
    return this.transcript.resume();
  }

  get state(): Phase {
    return this.phase;
  }

  snapshot(): AriaSnapshot {
    if (!this.snap) {
      this.snap = {
        aria: this.aria,
        turns: this.transcript.view(),
        metrics: this.transcript.latestMetrics,
        phase: this.phase,
        refusal: this.refusal,
        error: this.error,
        cursor: this.transcript.resume(),
        olderAvailable: this.older,
      };
    }
    return this.snap;
  }

  subscribe(fn: Listener, filter?: EventFilter): () => void {
    const sub: Sub = { fn, filter };
    this.subs.add(sub);
    return () => this.subs.delete(sub);
  }

  on<K extends Kind>(kind: K, fn: (e: EventOf<K>) => void): () => void {
    return this.subscribe(fn as Listener, kind);
  }

  onChange(fn: () => void): () => void {
    this.changed.add(fn);
    return () => this.changed.delete(fn);
  }

  events(filter?: EventFilter): AsyncIterableIterator<AriaEvent> {
    const queue: AriaEvent[] = [];
    let wake: (() => void) | undefined;
    let over = this.closed;
    const off = this.subscribe((e) => {
      queue.push(e);
      wake?.();
    }, filter);
    const offEnd = this.onEnd(() => {
      over = true;
      wake?.();
    });
    const stop = (): void => {
      off();
      offEnd();
      over = true;
    };
    const it: AsyncIterableIterator<AriaEvent> = {
      next: async () => {
        for (;;) {
          const e = queue.shift();
          if (e) return { value: e, done: false };
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

  prompt(text: string, o?: { readonly images?: readonly { readonly mime_type?: string; readonly data: string }[] }): Promise<QuaResponse> {
    return this.host.prompt(this.aria, text, o);
  }

  interrupt(o?: { readonly queue?: QueueDisposition }): Promise<InterruptResponse> {
    return this.host.interrupt(this.aria, o);
  }

  fork(o?: { readonly atTurn?: number; readonly atLT?: number; readonly outfits?: readonly string[] }): Promise<ForkResponse> {
    return this.host.fork(this.aria, o);
  }

  async loadOlder(): Promise<boolean> {
    const at = this.transcript.oldestHeld();
    if (!at || this.older === false) return false;
    const page = await this.host.connection.call<Page>(ariaMethod.read, {
      figaro_id: this.aria,
      at,
      backward: true,
      ...(this.opts.pageBytes ? { limit: this.opts.pageBytes } : {}),
    });
    this.transcript.quietly(() => {
      this.transcript.fold(page, "read");
      this.transcript.flush();
    });
    this.older = page.more.before ?? false;
    this.touch();
    return page.parts.length > 0;
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
    this.subs.clear();
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
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.setPhase("offline", undefined, reason);
  }

  push(frame: AriaFrame, generation: number): void {
    if (this.closed || generation !== this.generation) return;
    if (this.buffering) {
      this.buffer.push({ k: "frame", frame });
      return;
    }
    if (this.applyFrame(frame)) void this.resync(generation);
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

  private onEnd(fn: () => void): () => void {
    this.ended.add(fn);
    return () => this.ended.delete(fn);
  }

  private stale(generation: number): boolean {
    return this.closed || generation !== this.generation;
  }

  private async start(generation: number): Promise<void> {
    if (this.retryTimer) clearTimeout(this.retryTimer);
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
      this.catching = false;
    }
    this.buffering = false;
    const queued = this.buffer;
    this.buffer = [];
    let resync = false;
    for (const q of queued) {
      if (q.k === "frame") resync = this.applyFrame(q.frame) || resync;
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
    const fresh = this.transcript.newestTurn === 0 && this.opts.cursor === undefined;
    const tail = fresh && this.opts.from !== "start";
    let at: Anchor | undefined = tail || fresh ? undefined : this.transcript.resumeAnchor();
    if (!tail && at && at.turn === 0 && at.node === 0) at = undefined;
    for (let i = 0; i < maxPages; i++) {
      const page = await this.host.connection.call<Page>(ariaMethod.read, {
        figaro_id: this.aria,
        ...(at ? { at } : {}),
        ...(tail ? { backward: true } : {}),
        ...(this.opts.pageBytes ? { limit: this.opts.pageBytes } : {}),
      });
      if (this.stale(generation)) return;
      this.transcript.fold(page, "read");
      this.transcript.flush();
      this.touch();
      if (tail) {
        this.older = page.more.before ?? false;
        return;
      }
      const next = page.more.after ? page.next : undefined;
      if (!next || (at && next.turn === at.turn && next.node === at.node)) return;
      at = next;
    }
  }

  private applyFrame(frame: AriaFrame): boolean {
    const r = this.transcript.fold(frame, "push");
    this.transcript.flush();
    this.touch();
    return r.resync;
  }

  private applyDone(done: TurnDone): void {
    this.transcript.done(done.reason, done.idle);
    this.transcript.flush();
    this.touch();
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

  private deliver(e: AriaEvent): void {
    for (const sub of [...this.subs]) {
      if (!matches(sub.filter, e)) continue;
      try {
        sub.fn(e);
      } catch (err) {
        setTimeout(() => {
          throw err;
        }, 0);
      }
    }
  }
}
