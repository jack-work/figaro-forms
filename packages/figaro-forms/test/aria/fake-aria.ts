import type { Json } from "../../src/json.js";
import type { Dial, Socket, SocketEvents } from "../../src/rpc.js";
import type { Anchor, NodeDelta, Page, TurnPart, Node } from "../../src/aria/wire.js";

interface Frame {
  id: number;
  method: string;
  params: Record<string, Json> & { figaro_id?: string };
}

export interface Conn {
  readonly events: SocketEvents;
  readonly follows: Set<string>;
  readonly channels: Map<string, unknown>;
  open: boolean;
  readonly received: Frame[];
}

interface FakeTurn {
  id: number;
  inquiry: string;
  segments?: { sender?: string; name?: string; text: string }[];
  nodes: Record<string, unknown>[];
  sealed: boolean;
  open: { from: number; ver: number } | undefined;
}

const enc = new TextEncoder();
const dec = new TextDecoder();

function splice(s: string, at: number, del: number, ins: string): string {
  const b = enc.encode(s);
  return dec.decode(b.slice(0, at)) + ins + dec.decode(b.slice(at + del));
}

export class FakeAria {
  readonly turns = new Map<string, FakeTurn[]>();
  readonly conns: Conn[] = [];
  readonly reads: Record<string, unknown>[] = [];
  readonly calls: { method: string; params: Record<string, Json> }[] = [];
  capabilities: string[] = ["follow.channels", "unfollow"];
  pageNodes = 1000;
  dials = 0;
  refuseFollow = new Map<string, { code: number; message: string }>();
  refuseRead = new Map<string, { code: number; message: string }>();
  rows: Record<string, Json>[] = [];
  listRefused = 0;
  answers = new Map<string, Json>();
  holdReads = false;
  private held: (() => void)[] = [];

  release(): void {
    this.holdReads = false;
    for (const fn of this.held.splice(0)) fn();
  }

  addAria(id: string): void {
    this.turns.set(id, []);
  }

  dial: Dial = async (events) => {
    this.dials++;
    const conn: Conn = { events, follows: new Set(), channels: new Map(), open: true, received: [] };
    this.conns.push(conn);
    const socket: Socket = {
      send: (frame) => {
        if (!conn.open) throw new Error("socket closed");
        const f = JSON.parse(frame) as Frame;
        conn.received.push(f);
        queueMicrotask(() => this.handle(conn, f));
      },
      close: () => {
        if (!conn.open) return;
        conn.open = false;
        queueMicrotask(() => events.closed("closed by client"));
      },
    };
    return socket;
  };

  drop(reason = "dropped"): void {
    for (const c of this.conns) {
      if (!c.open) continue;
      c.open = false;
      c.events.closed(reason);
    }
  }

  openTurn(id: string, turn: number, inquiry: string, segments?: FakeTurn["segments"]): void {
    this.turns.get(id)?.push({ id: turn, inquiry, ...(segments ? { segments } : {}), nodes: [], sealed: false, open: undefined });
    this.push(id, { parts: [this.part(this.turn(id, turn), { inquiry: true, nodes: false })], more: {} });
  }

  update(id: string, turn: number, deltas: NodeDelta[], opts: { drop?: boolean } = {}): void {
    const t = this.turn(id, turn);
    if (!t.open) t.open = { from: t.nodes.length, ver: 0 };
    const v = t.open.ver++;
    for (const d of deltas) {
      while (t.nodes.length <= d.id) t.nodes.push({});
      const n = t.nodes[d.id] as Record<string, unknown>;
      for (const [k, val] of Object.entries(d.set ?? {})) n[k] = val;
      for (const k of d.unset ?? []) delete n[k];
      for (const [f, dl] of Object.entries(d.patch ?? {})) n[f] = splice((n[f] as string | undefined) ?? "", dl.at, dl.del, dl.ins);
    }
    if (opts.drop) return;
    const part: TurnPart = { turn, from: t.open.from, sealed: false, ...(v === 0 ? { inquiry: t.inquiry } : {}), live: { from: t.open.from, v, nodes: deltas } };
    this.push(id, { parts: [part], more: {} });
  }

  closeRound(id: string, turn: number): void {
    const t = this.turn(id, turn);
    if (!t.open) return;
    const part: TurnPart = { turn, from: t.open.from, sealed: false, inquiry: t.inquiry, live: { from: t.open.from, v: Math.max(0, t.open.ver - 1) } };
    t.open = undefined;
    this.push(id, { parts: [part], more: {} });
  }

  seal(id: string, turn: number): void {
    const t = this.turn(id, turn);
    t.sealed = true;
    t.open = undefined;
    this.push(id, { parts: [this.part(t, { inquiry: true, nodes: true })], more: {} });
  }

  done(id: string, reason = "stop", idle = true): void {
    this.pushRaw(id, "turn.done", { reason, idle });
  }

  closed(id: string): void {
    this.pushRaw(id, "figaro.closed", {});
  }

  finishedTurn(id: string, turn: number, inquiry: string, nodes: Node[]): void {
    this.turns.get(id)?.push({ id: turn, inquiry, nodes: nodes.map((n) => ({ ...n })), sealed: true, open: undefined });
  }

  private turn(id: string, turn: number): FakeTurn {
    const t = this.turns.get(id)?.find((x) => x.id === turn);
    if (!t) throw new Error(`no turn ${turn} on ${id}`);
    return t;
  }

  private part(t: FakeTurn, o: { inquiry: boolean; nodes: boolean; from?: number; to?: number }): TurnPart {
    const from = o.from ?? 0;
    const to = o.to ?? t.nodes.length;
    const nodes = o.nodes ? (t.nodes.slice(from, to) as unknown as Node[]) : undefined;
    return {
      turn: t.id,
      from: o.nodes ? from : 0,
      sealed: t.sealed,
      ...(o.inquiry && t.inquiry ? { inquiry: t.inquiry } : {}),
      ...(o.inquiry && t.segments ? { inquiry_segments: t.segments } : {}),
      ...(nodes && nodes.length > 0 ? { nodes } : {}),
      ...(from > 0 ? { clipped_head: true } : {}),
      ...(to < t.nodes.length ? { clipped_tail: true } : {}),
      ...(t.open && !t.sealed ? { live: { from: t.open.from, v: Math.max(0, t.open.ver - 1) } } : {}),
    };
  }

  private units(t: FakeTurn): number {
    return t.nodes.length > 0 ? t.nodes.length : t.inquiry ? 1 : 0;
  }

  private page(id: string, at: Anchor | undefined, backward: boolean): Page {
    const turns = this.turns.get(id) ?? [];
    const flat: { t: FakeTurn; n: number }[] = [];
    for (const t of turns) for (let n = 0; n < this.units(t); n++) flat.push({ t, n });
    if (flat.length === 0) return { parts: [], more: {} };
    let lo: number;
    let hi: number;
    if (backward) {
      const end = at && !(at.turn === 0 && at.node === 0) ? flat.findIndex((u) => u.t.id > at.turn || (u.t.id === at.turn && u.n >= at.node)) : flat.length;
      const stop = end < 0 ? flat.length : end;
      hi = stop - 1;
      lo = Math.max(0, hi - this.pageNodes + 1);
    } else {
      const start = at && !(at.turn === 0 && at.node === 0) ? flat.findIndex((u) => u.t.id > at.turn || (u.t.id === at.turn && u.n >= at.node)) : 0;
      if (start < 0) {
        const last = flat[flat.length - 1] as { t: FakeTurn; n: number };
        const same = at && last.t.id === at.turn;
        if (!same) return { parts: [], more: {} };
        lo = flat.length - 1;
      } else lo = start;
      hi = Math.min(flat.length - 1, lo + this.pageNodes - 1);
    }
    if (hi < lo) return { parts: [], more: { before: lo > 0 } };
    const groups: { t: FakeTurn; first: number; last: number }[] = [];
    for (let i = lo; i <= hi; i++) {
      const { t, n } = flat[i] as { t: FakeTurn; n: number };
      const g = groups[groups.length - 1];
      if (g && g.t === t) g.last = n;
      else groups.push({ t, first: n, last: n });
    }
    const parts = groups.map((g) => this.part(g.t, { inquiry: true, nodes: g.t.nodes.length > 0, from: g.first, to: g.last + 1 }));
    const next = hi + 1 < flat.length ? (flat[hi + 1] as { t: FakeTurn; n: number }) : undefined;
    return { parts, more: { before: lo > 0, after: next !== undefined }, ...(next ? { next: { turn: next.t.id, node: next.n } } : {}), metrics: { context_tokens: 1, context_exact: false, tokens_in: 0, tokens_out: 0, cache_read_tokens: 0, cache_write_tokens: 0 } };
  }

  private push(id: string, page: Page): void {
    this.pushRaw(id, "figaro.aria", page as unknown as Record<string, Json>);
  }

  private pushRaw(id: string, method: string, params: Record<string, unknown>): void {
    for (const c of this.conns) if (c.open && c.follows.has(id)) c.events.message(JSON.stringify({ jsonrpc: "2.0", method, params: { figaro_id: id, ...params } }));
  }

  private reply(c: Conn, id: number, body: { result?: unknown; error?: { code: number; message: string } }): void {
    if (c.open) c.events.message(JSON.stringify({ jsonrpc: "2.0", id, ...body }));
  }

  private handle(c: Conn, f: Frame): void {
    if (!c.open) return;
    const id = f.params?.figaro_id ?? "";
    const err = (message: string, code = -32000): void => this.reply(c, f.id, { error: { code, message } });
    this.calls.push({ method: f.method, params: f.params });
    switch (f.method) {
      case "angelus.hello":
        this.reply(c, f.id, { result: { version: 1, capabilities: this.capabilities, node: "n1", principal: { kind: "user", id: "gluck" } } });
        return;
      case "figaro.follow": {
        const refused = this.refuseFollow.get(id);
        if (refused) return err(refused.message, refused.code);
        if (!this.turns.has(id)) return err(`figaro.follow: aria ${id} not found`);
        c.follows.add(id);
        c.channels.set(id, f.params.channels);
        this.reply(c, f.id, { result: { ok: true, figaro_id: id } });
        return;
      }
      case "figaro.unfollow":
        this.reply(c, f.id, { result: { released: c.follows.delete(id) } });
        return;
      case "figaro.read": {
        this.reads.push(f.params);
        const refused = this.refuseRead.get(id);
        if (refused) return err(refused.message, refused.code);
        if (!this.turns.has(id)) return err(`figaro.read: aria ${id} not found`);
        const result = this.page(id, f.params.at as Anchor | undefined, f.params.backward === true);
        if (this.holdReads) this.held.push(() => this.reply(c, f.id, { result }));
        else this.reply(c, f.id, { result });
        return;
      }
      case "figaro.list":
        this.reply(c, f.id, { result: { figaros: this.rows, ...(this.listRefused ? { refused: this.listRefused, refused_why: "policy" } : {}) } });
        return;
      default: {
        const canned = this.answers.get(f.method);
        if (canned !== undefined) return this.reply(c, f.id, { result: canned });
      }
    }
    err(`method not found: ${f.method}`, -32601);
  }
}

export const tick = (ms = 0): Promise<void> => new Promise((r) => setTimeout(r, ms));

export async function settle(rounds = 20): Promise<void> {
  for (let i = 0; i < rounds; i++) await tick();
}
