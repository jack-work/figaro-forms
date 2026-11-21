import { createHash } from "node:crypto";
import type { Dial, Socket, SocketEvents } from "figaro-forms";

export interface HandoverOptions {
  readonly renew: (after: number) => Promise<number | undefined>;
  readonly now?: () => number;
  readonly log?: (line: string) => void;
  readonly quietMs?: number;
  readonly followTimeoutMs?: number;
  readonly retireMs?: number;
}

const internalPrefix = "\u0000gw-handover-";
const lapsed = "door.lapsed";

interface Leg {
  readonly socket: Socket;
  readonly expires: number | undefined;
  readonly dialled: number;
  readonly pending: Set<string>;
  timers: ReturnType<typeof setTimeout>[];
  gone: boolean;
  overdue?: boolean;
}

type Frame = { id?: unknown; method?: unknown; params?: unknown; result?: unknown; error?: unknown };

const hash = (frame: string): string => createHash("sha1").update(frame).digest("base64");
const idKey = (id: unknown): string => JSON.stringify(id);

export function leadFor(lifeMs: number): { open: number; force: number } {
  return { open: Math.min(60_000, Math.max(2_000, lifeMs * 0.25)), force: Math.min(10_000, Math.max(1_000, lifeMs * 0.08)) };
}

export function handoverDial(dial: Dial, o: HandoverOptions): Dial {
  return async (events) => {
    const h = new Handover(dial, events, o);
    await h.start();
    return { send: (f) => h.send(f), close: () => h.close() };
  };
}

class Handover {
  private current!: Leg;
  private next: Leg | undefined;
  private retired: Leg | undefined;
  private readonly follows = new Map<string, string>();
  private readonly asked = new Map<string, { method: string; params: string }>();
  private readonly open = new Map<string, number>();
  private lastFrame = 0;
  private closing = false;
  private moving = false;
  private lost: string | undefined;
  private movedFollows = new Set<string>();
  private recorded: string[] | undefined;
  private buffered: { frame: string; h: string }[] = [];
  private align: { list: string[]; at: number } | undefined;
  private seq = 0;
  private readonly now: () => number;
  private readonly log: (line: string) => void;

  constructor(
    private readonly dial: Dial,
    private readonly events: SocketEvents,
    private readonly o: HandoverOptions,
  ) {
    this.now = o.now ?? Date.now;
    this.log = o.log ?? (() => {});
  }

  async start(): Promise<void> {
    this.current = await this.leg();
    this.schedule(this.current);
  }

  send(frame: string): void {
    let f: Frame | undefined;
    try {
      f = JSON.parse(frame) as Frame;
    } catch {
      f = undefined;
    }
    if (f && typeof f.method === "string" && f.id !== undefined && f.id !== null) {
      const key = idKey(f.id);
      this.current.pending.add(key);
      if (f.method === "figaro.follow" || f.method === "figaro.unfollow" || f.method === "figaro.qua") this.asked.set(key, { method: f.method, params: JSON.stringify(f.params ?? {}) });
    }
    this.current.socket.send(frame);
  }

  close(): void {
    this.closing = true;
    for (const l of [this.current, this.next, this.retired]) if (l) this.drop(l);
  }

  private async leg(): Promise<Leg> {
    const expires = await this.o.renew(this.now());
    const holder: { leg?: Leg; early: string[] } = { early: [] };
    const socket = await this.dial({
      message: (frame) => (holder.leg ? this.onMessage(holder.leg, frame) : holder.early.push(frame)),
      closed: (reason) => holder.leg && this.onClosed(holder.leg, reason),
    });
    const leg: Leg = { socket, expires, dialled: this.now(), pending: new Set(), timers: [], gone: false };
    holder.leg = leg;
    for (const f of holder.early) this.onMessage(leg, f);
    return leg;
  }

  private drop(l: Leg): void {
    for (const t of l.timers) clearTimeout(t);
    l.timers = [];
    if (l.gone) return;
    l.gone = true;
    try {
      l.socket.close();
    } catch {}
  }

  private schedule(l: Leg): void {
    if (l.expires === undefined) return;
    const { open, force } = leadFor(l.expires - l.dialled);
    const at = (ms: number, fn: () => void): void => {
      const t = setTimeout(fn, Math.max(0, ms - this.now()));
      t.unref?.();
      l.timers.push(t);
    };
    at(l.expires - open, () => this.whenQuiet(l, l.expires! - force));
    at(l.expires - force, () => void this.move(l, "deadline"));
  }

  private quiet(): boolean {
    const now = this.now();
    for (const [k, seen] of this.open) if (now - seen > 60_000) this.open.delete(k);
    return this.open.size === 0 && this.current.pending.size === 0 && now - this.lastFrame >= (this.o.quietMs ?? 500);
  }

  private whenQuiet(l: Leg, deadline: number): void {
    if (l !== this.current || this.closing) return;
    if (this.quiet()) {
      void this.move(l, "between turns");
      return;
    }
    if (this.now() >= deadline) return;
    const t = setTimeout(() => this.whenQuiet(l, deadline), 100);
    t.unref?.();
    l.timers.push(t);
  }

  private async move(from: Leg, why: string): Promise<void> {
    if (this.moving || from !== this.current || this.closing) return;
    this.moving = true;
    try {
      const expires = await this.o.renew((from.expires ?? this.now()) + 1_000);
      if (from.expires !== undefined && (expires === undefined || expires <= from.expires)) {
        this.log(`door handover skipped: no bearer outlasting the current one`);
        return;
      }
      const started = this.now();
      this.recorded = [];
      const next = await this.leg();
      this.next = next;
      const follows = [...this.follows.values()];
      this.movedFollows = new Set(this.follows.keys());
      const answered = await Promise.all(follows.map((p) => this.internal(next, "figaro.follow", p)));
      if (this.closing || from !== this.current) {
        this.drop(next);
        this.next = undefined;
        return;
      }
      if (answered.some((ok) => !ok)) {
        this.log(`door handover abandoned: a follow failed on the new leg (${why})`);
        this.next = undefined;
        this.recorded = undefined;
        this.buffered = [];
        this.drop(next);
        return;
      }
      this.switchTo(next);
      this.log(`door handover done (${why}): ${follows.length} follows moved in ${this.now() - started} ms`);
    } catch (e) {
      this.log(`door handover failed (${why}): ${e instanceof Error ? e.message : String(e)}`);
      if (this.next) this.drop(this.next);
      this.next = undefined;
      this.recorded = undefined;
      this.buffered = [];
    } finally {
      this.moving = false;
      if (this.lost !== undefined && this.current.gone && !this.closing) {
        this.closing = true;
        this.events.closed(this.lost);
      }
    }
  }

  private internal(leg: Leg, method: string, params: string): Promise<boolean> {
    const id = `${internalPrefix}${++this.seq}`;
    return new Promise((ok) => {
      const key = idKey(id);
      const t = setTimeout(() => {
        leg.pending.delete(key);
        this.waiting.delete(key);
        ok(false);
      }, this.o.followTimeoutMs ?? 10_000);
      t.unref?.();
      this.waiting.set(key, (good) => {
        clearTimeout(t);
        ok(good);
      });
      leg.socket.send(`{"jsonrpc":"2.0","id":${JSON.stringify(id)},"method":${JSON.stringify(method)},"params":${params}}`);
    });
  }

  private readonly waiting = new Map<string, (ok: boolean) => void>();

  private switchTo(next: Leg): void {
    const old = this.current;
    this.current = next;
    this.next = undefined;
    this.align = this.recorded && this.recorded.length > 0 ? { list: this.recorded, at: -1 } : undefined;
    this.recorded = undefined;
    this.lost = undefined;
    for (const [aria, params] of this.follows) if (!this.movedFollows.has(aria)) void this.internal(next, "figaro.follow", params);
    for (const b of this.buffered.splice(0)) this.deliverNew(b.frame, b.h);
    this.schedule(next);
    for (const t of old.timers) clearTimeout(t);
    old.timers = [];
    this.retired = old;
    const t = setTimeout(() => {
      old.overdue = true;
      this.retire(old, true);
    }, this.o.retireMs ?? 2_000);
    t.unref?.();
    old.timers.push(t);
    this.retire(old, false);
  }

  private retire(old: Leg, timedOut: boolean): void {
    if (old !== this.retired || old.gone) return;
    if (old.pending.size > 0) return;
    if (!timedOut && this.align !== undefined) return;
    this.drop(old);
    this.retired = undefined;
  }

  private deliverNew(frame: string, h: string): void {
    const a = this.align;
    if (a) {
      if (a.at < 0) {
        const k = a.list.indexOf(h);
        if (k >= 0) {
          a.at = k + 1;
          if (a.at >= a.list.length) this.aligned();
          return;
        }
        this.aligned();
      } else if (a.at < a.list.length && a.list[a.at] === h) {
        a.at++;
        if (a.at >= a.list.length) this.aligned();
        return;
      } else this.aligned();
    }
    this.forward(frame);
  }

  private aligned(): void {
    this.align = undefined;
    if (this.retired) this.retire(this.retired, false);
  }

  private forward(frame: string): void {
    this.note(frame);
    this.events.message(frame);
  }

  private note(frame: string): void {
    let f: Frame;
    try {
      f = JSON.parse(frame) as Frame;
    } catch {
      return;
    }
    if (f.method !== "figaro.aria") return;
    this.lastFrame = this.now();
    const p = f.params as { figaro_id?: string; parts?: { turn?: number; sealed?: boolean }[] } | undefined;
    for (const part of p?.parts ?? []) {
      const k = `${p?.figaro_id ?? ""}:${part.turn ?? ""}`;
      if (part.sealed) this.open.delete(k);
      else this.open.set(k, this.now());
    }
  }

  private onMessage(leg: Leg, frame: string): void {
    if (leg.gone) return;
    let f: Frame;
    try {
      f = JSON.parse(frame) as Frame;
    } catch {
      if (leg === this.current) this.events.message(frame);
      return;
    }
    if (f.method === undefined && f.id !== undefined) {
      const key = idKey(f.id);
      const wait = this.waiting.get(key);
      if (wait) {
        this.waiting.delete(key);
        wait(f.error === undefined);
        return;
      }
      leg.pending.delete(key);
      const asked = this.asked.get(key);
      if (asked) {
        this.asked.delete(key);
        if (f.error === undefined) this.remember(asked.method, asked.params);
      }
      this.events.message(frame);
      if (leg === this.retired) this.retire(leg, leg.overdue === true);
      return;
    }
    if (f.method === lapsed) {
      if (leg === this.current) void this.move(leg, "lapse notice");
      return;
    }
    if (leg === this.current && this.next === undefined) {
      if (this.recorded) this.recorded.push(hash(frame));
      this.forward(frame);
      return;
    }
    if (leg === this.current && this.next) {
      this.recorded?.push(hash(frame));
      this.forward(frame);
      return;
    }
    if (leg === this.next) {
      this.buffered.push({ frame, h: hash(frame) });
      return;
    }
  }

  private remember(method: string, params: string): void {
    let p: { figaro_id?: unknown };
    try {
      p = JSON.parse(params) as typeof p;
    } catch {
      return;
    }
    if (typeof p.figaro_id !== "string") return;
    if (method === "figaro.unfollow") this.follows.delete(p.figaro_id);
    else if (method === "figaro.follow") this.follows.set(p.figaro_id, params);
    else if (!this.follows.has(p.figaro_id)) this.follows.set(p.figaro_id, JSON.stringify({ figaro_id: p.figaro_id }));
  }

  private onClosed(leg: Leg, reason: string): void {
    if (leg.gone || this.closing) return;
    leg.gone = true;
    for (const t of leg.timers) clearTimeout(t);
    if (leg === this.retired) {
      this.retired = undefined;
      return;
    }
    if (leg === this.next) {
      this.next = undefined;
      this.recorded = undefined;
      this.buffered = [];
      return;
    }
    if (leg === this.current) {
      if (this.moving) {
        this.log(`door leg closed before the handover finished (${reason}); waiting for the new leg`);
        this.lost = reason;
        return;
      }
      this.closing = true;
      this.events.closed(reason);
    }
  }
}
