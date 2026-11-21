import { chmod, rm } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import type { Dial, Socket, SocketEvents } from "figaro-forms";
import type { WebSocket } from "ws";
import type { SpeechDial, SpeechSession } from "./speech.js";

export interface Scope {
  readonly session?: string;
  readonly audio?: boolean;
}

export interface Who {
  readonly session: string;
  readonly audio: boolean;
}

export interface FrameMatch {
  readonly method?: string;
  readonly reply?: "page" | "gateway" | number;
  readonly leg?: "first" | "later";
  readonly notify?: boolean;
}

type Rule =
  | { kind: "door.drop" | "page.drop"; scope: Scope; match: FrameMatch; count: number }
  | { kind: "door.delay" | "page.delay"; scope: Scope; match: FrameMatch; count: number; ms: number }
  | { kind: "door.stall"; scope: Scope; count: number; ms: number }
  | { kind: "speech.stall"; count: number; ms: number }
  | { kind: "speech.fail"; count: number };

interface LiveLeg {
  readonly who: Who;
  readonly n: number;
  cut(notice: boolean): void;
}

interface LivePage {
  readonly who: Who;
  readonly ws: WebSocket;
}

const forever = Number.MAX_SAFE_INTEGER;
const inScope = (s: Scope, w: Who): boolean => (s.session === undefined || s.session === w.session) && (s.audio === undefined || s.audio === w.audio);

function frameOf(frame: string): { method?: string; type?: string; id?: unknown } {
  try {
    const j = JSON.parse(frame) as unknown;
    return typeof j === "object" && j !== null ? (j as { method?: string; type?: string; id?: unknown }) : {};
  } catch {
    return {};
  }
}

function matches(m: FrameMatch, frame: string, leg?: number): boolean {
  const f = frameOf(frame);
  if (m.leg !== undefined && leg !== undefined && (m.leg === "first") !== (leg === 1)) return false;
  if (m.method !== undefined && f.method !== m.method && f.type !== m.method) return false;
  if (m.notify === true && f.method === undefined) return false;
  if (m.reply !== undefined) {
    if (f.method !== undefined || f.id === undefined || f.id === null) return false;
    if (m.reply === "gateway" && !(typeof f.id === "number" && f.id < 0)) return false;
    if (m.reply === "page" && typeof f.id === "number" && f.id < 0) return false;
    if (typeof m.reply === "number" && f.id !== m.reply) return false;
  }
  return true;
}

export const lapseReason = "the bearer expired: reconnect with a fresh token";

export class Faults {
  private rules: Rule[] = [];
  private bearerMs: { ms: number; notice: boolean } | undefined;
  private readonly legs = new Set<LiveLeg>();
  private readonly pages = new Set<LivePage>();
  private dials = 0;
  private cuts = 0;

  constructor(
    private readonly log: (line: string) => void = () => {},
    private readonly onDial?: (n: number, who: Who) => void,
  ) {}

  get legsOpened(): number {
    return this.dials;
  }

  get legsCut(): number {
    return this.cuts;
  }

  private take(kind: Rule["kind"], test: (r: Rule) => boolean): Rule | undefined {
    const r = this.rules.find((x) => x.kind === kind && test(x));
    if (!r) return undefined;
    r.count--;
    if (r.count <= 0) this.rules = this.rules.filter((x) => x !== r);
    return r;
  }

  door(dial: Dial, who: Who): Dial {
    return async (outer: SocketEvents) => {
      const n = ++this.dials;
      this.onDial?.(n, who);
      const stall = this.take("door.stall", (r) => inScope((r as { scope: Scope }).scope, who));
      if (stall && stall.kind === "door.stall") await new Promise((ok) => setTimeout(ok, stall.ms));
      let dead = false;
      let lapse: ReturnType<typeof setTimeout> | undefined;
      let inner: Socket | undefined;
      let leg: LiveLeg | undefined;
      const end = (reason: string): void => {
        if (dead) return;
        dead = true;
        if (lapse) clearTimeout(lapse);
        if (leg) this.legs.delete(leg);
        try {
          inner?.close();
        } catch {}
        outer.closed(reason);
      };
      const deliver = (frame: string): void => {
        if (dead) return;
        const drop = this.take("door.drop", (r) => r.kind === "door.drop" && inScope(r.scope, who) && matches(r.match, frame, n));
        if (drop) return;
        const delay = this.take("door.delay", (r) => r.kind === "door.delay" && inScope(r.scope, who) && matches(r.match, frame, n));
        if (delay && delay.kind === "door.delay") {
          setTimeout(() => !dead && outer.message(frame), delay.ms);
          return;
        }
        outer.message(frame);
      };
      const opened = await dial({ message: deliver, closed: (r) => end(r) });
      inner = opened;
      const live: LiveLeg = {
        who,
        n,
        cut: (notice) => {
          if (dead) return;
          this.cuts++;
          if (!notice) return end(lapseReason);
          outer.message(JSON.stringify({ jsonrpc: "2.0", method: "door.lapsed", params: { reason: lapseReason, after_ms: 0 } }));
          setTimeout(() => end(lapseReason), 50);
        },
      };
      leg = live;
      this.legs.add(live);
      const bearer = this.bearerMs;
      if (bearer) {
        lapse = setTimeout(() => live.cut(bearer.notice), bearer.ms);
        lapse.unref?.();
      }
      const socket: Socket = {
        send: (f) => {
          if (dead) throw new Error("socket closed");
          opened.send(f);
        },
        close: () => {
          if (dead) return;
          dead = true;
          if (lapse) clearTimeout(lapse);
          this.legs.delete(live);
          opened.close();
        },
      };
      return socket;
    };
  }

  renew(real: ((until: number) => Promise<number | undefined>) | undefined): (until: number) => Promise<number | undefined> {
    return async (until) => {
      const b = this.bearerMs;
      if (b) return Date.now() + b.ms;
      return real ? real(until) : undefined;
    };
  }

  page(ws: WebSocket, who: Who): void {
    const p: LivePage = { who, ws };
    this.pages.add(p);
    ws.once("close", () => this.pages.delete(p));
    const send = ws.send.bind(ws) as (data: unknown, ...rest: unknown[]) => void;
    (ws as unknown as { send: (data: unknown, ...rest: unknown[]) => void }).send = (data, ...rest) => {
      if (typeof data === "string") {
        if (this.take("page.drop", (r) => r.kind === "page.drop" && inScope(r.scope, who) && matches(r.match, data))) return;
        const delay = this.take("page.delay", (r) => r.kind === "page.delay" && inScope(r.scope, who) && matches(r.match, data));
        if (delay && delay.kind === "page.delay") {
          setTimeout(() => ws.readyState === ws.OPEN && send(data, ...rest), delay.ms);
          return;
        }
      }
      send(data, ...rest);
    };
  }

  speech(dial: SpeechDial): SpeechDial {
    return (req, on) => {
      if (this.take("speech.fail", () => true)) {
        setTimeout(() => on.error("fault: speech failed"), 0);
        return { write: () => {}, end: () => {}, cancel: () => {} };
      }
      const stall = this.take("speech.stall", () => true);
      if (!stall || stall.kind !== "speech.stall") return dial(req, on);
      let inner: SpeechSession | undefined;
      let cancelled = false;
      let ended = false;
      const held: string[] = [];
      setTimeout(() => {
        if (cancelled) return;
        inner = dial(req, on);
        for (const t of held.splice(0)) inner.write(t);
        if (ended) inner.end();
      }, stall.ms);
      return {
        write: (t) => (inner ? inner.write(t) : void held.push(t)),
        end: () => (inner ? inner.end() : void (ended = true)),
        cancel: () => {
          cancelled = true;
          inner?.cancel();
        },
      };
    };
  }

  async speechGate(): Promise<string | undefined> {
    if (this.take("speech.fail", () => true)) return "fault: speech failed";
    const stall = this.take("speech.stall", () => true);
    if (stall && stall.kind === "speech.stall") await new Promise((ok) => setTimeout(ok, stall.ms));
    return undefined;
  }

  apply(op: Record<string, unknown>): Record<string, unknown> {
    const scope: Scope = {
      ...(typeof op.session === "string" ? { session: op.session } : {}),
      ...(typeof op.audio === "boolean" ? { audio: op.audio } : {}),
    };
    const count = typeof op.count === "number" && op.count > 0 ? op.count : forever;
    const ms = typeof op.ms === "number" && op.ms >= 0 ? op.ms : undefined;
    const match: FrameMatch = {
      ...(typeof op.method === "string" ? { method: op.method } : {}),
      ...(op.reply === "page" || op.reply === "gateway" || typeof op.reply === "number" ? { reply: op.reply as "page" | "gateway" | number } : {}),
      ...(op.leg === "first" || op.leg === "later" ? { leg: op.leg } : {}),
      ...(op.notify === true ? { notify: true } : {}),
    };
    const need = (v: number | undefined, what: string): number => {
      if (v === undefined) throw new Error(`${op.op} needs ${what}`);
      return v;
    };
    switch (op.op) {
      case "door.lapse": {
        const notice = op.notice !== false;
        const leg = typeof op.leg === "number" ? op.leg : undefined;
        const after = ms ?? 0;
        const pick = (): LiveLeg[] => [...this.legs].filter((l) => inScope(scope, l.who) && (leg === undefined || l.n === leg));
        if (after === 0) {
          const cut = pick();
          for (const l of cut) l.cut(notice);
          this.log(`faults: door.lapse ${cut.length} legs${notice ? "" : " without notice"}`);
          return { ok: true, legs: cut.length };
        }
        setTimeout(() => {
          const cut = pick();
          for (const l of cut) l.cut(notice);
          this.log(`faults: door.lapse ${cut.length} legs${notice ? "" : " without notice"} after ${after} ms`);
        }, after);
        return { ok: true };
      }
      case "door.bearer":
        this.bearerMs = op.ms === null ? undefined : { ms: need(ms, "ms"), notice: op.notice !== false };
        break;
      case "door.drop":
      case "page.drop":
        this.rules.push({ kind: op.op, scope, match, count });
        break;
      case "door.delay":
      case "page.delay":
        this.rules.push({ kind: op.op, scope, match, count, ms: need(ms, "ms") });
        break;
      case "door.stall":
        this.rules.push({ kind: "door.stall", scope, count, ms: need(ms, "ms") });
        break;
      case "page.close": {
        const code = typeof op.code === "number" ? op.code : 1011;
        const hit = [...this.pages].filter((p) => inScope(scope, p.who));
        for (const p of hit) code === 1006 ? p.ws.terminate() : p.ws.close(code, "fault");
        this.log(`faults: page.close ${hit.length} sockets code=${code}`);
        return { ok: true, sockets: hit.length };
      }
      case "speech.stall":
        this.rules.push({ kind: "speech.stall", count, ms: need(ms, "ms") });
        break;
      case "speech.fail":
        this.rules.push({ kind: "speech.fail", count });
        break;
      case "clear":
        this.rules = [];
        this.bearerMs = undefined;
        break;
      case "state":
        return { ok: true, rules: this.rules, bearer: this.bearerMs ?? null, legs: this.legs.size, pages: this.pages.size };
      default:
        throw new Error(`unknown op ${String(op.op)}`);
    }
    this.log(`faults: ${JSON.stringify(op)}`);
    return { ok: true };
  }
}

export async function faultSocket(path: string, faults: Faults, log: (line: string) => void): Promise<Server> {
  await rm(path, { force: true });
  const server = createServer((c) => {
    let buf = "";
    c.setEncoding("utf8");
    c.on("data", (d: string) => {
      buf += d;
      for (let i = buf.indexOf("\n"); i >= 0; i = buf.indexOf("\n")) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (line === "") continue;
        let answer: Record<string, unknown>;
        try {
          answer = faults.apply(JSON.parse(line) as Record<string, unknown>);
        } catch (e) {
          answer = { ok: false, error: e instanceof Error ? e.message : String(e) };
        }
        c.write(`${JSON.stringify(answer)}\n`);
      }
    });
    c.on("error", () => {});
  });
  await new Promise<void>((ok, fail) => {
    server.once("error", fail);
    server.listen(path, ok);
  });
  await chmod(path, 0o600);
  log(`faults armed on ${path}: this gateway is in test mode`);
  return server;
}

export function faultsRefusal(listen: { path: string } | { port: number; host?: string }, peers: readonly string[] | undefined): string | undefined {
  const loop = (h: string): boolean => h === "127.0.0.1" || h === "::1" || h === "localhost";
  if ("path" in listen) return "--fault-socket needs a loopback --port gateway: a unix-socket gateway is the production shape";
  if (listen.host !== undefined && !loop(listen.host)) return `--fault-socket refuses a gateway listening on ${listen.host}`;
  const far = (peers ?? []).find((p) => !loop(p));
  if (far !== undefined) return `--fault-socket refuses a gateway that admits the peer ${far}`;
  return undefined;
}
