import type { Json, JsonObject } from "../../src/json.js";
import { setAt, deleteAt, applyRoot } from "../../src/patch.js";
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
  readonly forms = new Map<string, { value: JsonObject; version: number; incarnation: number }>();
  refuseForm = new Map<string, { code: number; message: string }>();
  refuseSet = new Map<string, { code: number; message: string }>();
  refuseFork = new Map<string, { code: number; message: string }>();
  refuseQua = new Map<string, { code: number; message: string }>();
  forkCount = 0;
  private held: (() => void)[] = [];

  release(): void {
    this.holdReads = false;
    for (const fn of this.held.splice(0)) fn();
  }

  addAria(id: string): void {
    this.turns.set(id, []);
  }

  addForm(id: string, value: JsonObject = {}): void {
    this.forms.set(id, { value, version: 1, incarnation: 1 });
  }

  formSet(id: string, path: readonly string[], value: Json): void {
    const f = this.mustForm(id);
    this.formWrite(id, setAt(f.value, path, value));
  }

  formDelete(id: string, path: readonly string[]): void {
    const f = this.mustForm(id);
    this.formWrite(id, deleteAt(f.value, path));
  }

  formReincarnate(id: string, value: JsonObject, schema = 2): void {
    const f = this.mustForm(id);
    f.value = value;
    f.version = 1;
    f.incarnation++;
    this.pushRaw(id, "form.delta", { schema, aria_id: id, version: 1, incarnation: f.incarnation, patch: {}, at: Date.now() }, true);
  }

  formCalls(id: string): number {
    return this.calls.filter((c) => c.method === "figaro.form" && c.params.figaro_id === id).length;
  }

  private formWrite(id: string, patch: ReturnType<typeof setAt>): void {
    const f = this.mustForm(id);
    f.value = applyRoot(patch, f.value);
    f.version++;
    this.pushRaw(id, "form.delta", { schema: 2, aria_id: id, version: f.version, incarnation: f.incarnation, patch: patch as unknown as Json, at: Date.now() }, true);
  }

  private mustForm(id: string): { value: JsonObject; version: number; incarnation: number } {
    const f = this.forms.get(id);
    if (!f) throw new Error(`no form ${id}`);
    return f;
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

  private pushRaw(id: string, method: string, params: Record<string, unknown>, bare = false): void {
    for (const c of this.conns) if (c.open && c.follows.has(id)) c.events.message(JSON.stringify({ jsonrpc: "2.0", method, params: bare ? params : { figaro_id: id, ...params } }));
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
        if (!this.turns.has(id) && !this.forms.has(id)) return err(`figaro.follow: aria ${id} not found`);
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
        const read = (): Page => this.page(id, f.params.at as Anchor | undefined, f.params.backward === true);
        if (this.holdReads) this.held.push(() => this.reply(c, f.id, { result: read() }));
        else this.reply(c, f.id, { result: read() });
        return;
      }
      case "figaro.form": {
        const refused = this.refuseForm.get(id);
        if (refused) return err(refused.message, refused.code);
        const form = this.forms.get(id);
        if (!form) return err(`figaro.form: ${id} not found`);
        this.reply(c, f.id, { result: { snapshot: form.value, version: form.version, incarnation: form.incarnation } });
        return;
      }
      case "figaro.set": {
        const refused = this.refuseSet.get(id);
        if (refused) return err(refused.message, refused.code);
        const form = this.forms.get(id);
        if (!form) return err(`figaro.set: ${id} not found`);
        this.formWrite(id, f.params.patch as unknown as ReturnType<typeof setAt>);
        this.reply(c, f.id, { result: { ok: true, outcome: "applied", version: form.version } });
        return;
      }
      case "figaro.fork": {
        if (this.answers.has(f.method)) return this.reply(c, f.id, { result: this.answers.get(f.method) });
        const refused = this.refuseFork.get(id);
        if (refused) return err(refused.message, refused.code);
        if (!this.turns.has(id)) return err(`figaro.fork: aria ${id} not found`);
        const alternative = `${id}-f${++this.forkCount}`;
        this.turns.set(alternative, []);
        this.reply(c, f.id, { result: { parent: id, continuation: `${id}-c${this.forkCount}`, alternative } });
        return;
      }
      case "figaro.qua": {
        if (this.answers.has(f.method)) return this.reply(c, f.id, { result: this.answers.get(f.method) });
        const refused = this.refuseQua.get(id);
        if (refused) return err(refused.message, refused.code);
        if (!this.turns.has(id)) return err(`figaro.qua: aria ${id} not found`);
        this.reply(c, f.id, { result: { ok: true, cursor: 1 } });
        return;
      }
      case "figaro.list": {
        const limit = typeof f.params.limit === "number" ? f.params.limit : undefined;
        const from = typeof f.params.before === "string" ? this.rows.findIndex((r) => r.id === f.params.before) + 1 : 0;
        const page = limit === undefined ? this.rows : this.rows.slice(from, from + limit);
        const more = limit !== undefined && from + limit < this.rows.length;
        this.reply(c, f.id, {
          result: {
            figaros: page,
            ...(more ? { next_before: String(page[page.length - 1]?.id) } : {}),
            ...(this.listRefused ? { refused: this.listRefused, refused_why: "policy" } : {}),
          },
        });
        return;
      }
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
