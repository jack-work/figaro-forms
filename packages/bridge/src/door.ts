import type { Dial, Socket } from "figaro-forms";
import type { Credential } from "figaro-forms/auth";
import type { WebSocket } from "ws";
import type { AudioHub } from "./audio.js";
import { noTracer, parseTraceparent, type Span, type Tracer } from "./trace.js";

export const gatewayMethods = [
  "angelus.hello",
  "angelus.outfits",
  "figaro.follow",
  "figaro.unfollow",
  "figaro.form",
  "figaro.read",
  "figaro.qua",
  "figaro.interrupt",
  "figaro.fork",
  "figaro.list",
  "figaro.create",
  "figaro.set",
] as const;

const allowed: ReadonlySet<string> = new Set(gatewayMethods);

const permitted: Readonly<Record<string, ReadonlySet<string>>> = {
  "figaro.qua": new Set(["figaro_id", "text", "images", "traceparent"]),
  "figaro.fork": new Set(["figaro_id", "at_turn", "at_lt"]),
  "figaro.create": new Set(["outfits"]),
  "angelus.outfits": new Set(["spec"]),
  "figaro.set": new Set(["figaro_id", "patch", "client", "seq"]),
};

function forbiddenField(method: string, params: unknown): string | undefined {
  const keys = permitted[method];
  if (!keys) return undefined;
  if (typeof params !== "object" || params === null || Array.isArray(params)) return undefined;
  for (const k of Object.keys(params)) if (!keys.has(k)) return k;
  return undefined;
}

function refuse(ws: WebSocket, id: unknown, message: string): void {
  ws.send(JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32020, message } }));
}

export const onBehalfHeader = "X-Figaro-On-Behalf-Of";

export const sessionHeader = "X-Figchat-Session";
export const noSession = "-";
const sessionPattern = /^[A-Za-z0-9_-]{8,64}$/;
const loggedAria = /^@?[A-Za-z0-9_-]{1,64}$/;
const maxSessions = 8;
const maxPending = 1024;

export function sessionOf(req: { readonly headers: { readonly [name: string]: string | string[] | undefined }; readonly url?: string | undefined }, upgrade: boolean): string {
  const header = req.headers[sessionHeader.toLowerCase()];
  let v = typeof header === "string" ? header : undefined;
  if (v === undefined && upgrade) {
    try {
      v = new URL(req.url ?? "/", "http://gateway").searchParams.get("session") ?? undefined;
    } catch {
      v = undefined;
    }
  }
  return v !== undefined && sessionPattern.test(v) ? v : noSession;
}

export function sessionList(ids: Iterable<string | undefined>): string[] {
  const out: string[] = [];
  for (const id of ids) {
    if (id === undefined || id === noSession || out.includes(id)) continue;
    out.push(id);
    if (out.length === maxSessions) break;
  }
  return out;
}

export const sessionField = (ids: readonly string[]): string => (ids.length > 0 ? ids.join(",") : noSession);

export function withSession(base: Credential | undefined, session: string): Credential | undefined {
  if (session === noSession) return base;
  return {
    name: base ? `${base.name}+session` : "session",
    upgrade: async () => {
      const up = base ? await base.upgrade() : {};
      return { ...up, headers: { ...(up.headers ?? {}), [sessionHeader]: session } };
    },
  };
}

export function onBehalfOf(base: Credential, user: string): Credential {
  return {
    name: `${base.name}+on-behalf-of`,
    upgrade: async () => {
      const up = await base.upgrade();
      return { ...up, headers: { ...(up.headers ?? {}), [onBehalfHeader]: user } };
    },
  };
}

export function redact(text: string): string {
  return text.replace(/(\w+:\/\/)[^@/\s]*@/g, "$1").replace(/\?[^\s"')]*/g, "");
}

export function proxyDoor(ws: WebSocket, dial: Dial, hub: AudioHub | undefined, log: (line: string) => void = () => {}, session: string = noSession, tracer: Tracer = noTracer): void {
  const queue: string[] = [];
  const pending = new Map<string, Span>();
  let up: Socket | undefined;
  let gone = false;
  const answered = (frame: string): void => {
    if (pending.size === 0) return;
    let f: { id?: unknown; method?: unknown; error?: { message?: unknown } };
    try {
      f = JSON.parse(frame) as typeof f;
    } catch {
      return;
    }
    if (f.method !== undefined || f.id === undefined) return;
    const key = JSON.stringify(f.id);
    const sp = pending.get(key);
    if (!sp) return;
    pending.delete(key);
    if (f.error) sp.fail(typeof f.error.message === "string" ? redact(f.error.message).slice(0, 200) : "error");
    sp.end();
  };
  const abandon = (why: string): void => {
    for (const sp of pending.values()) {
      sp.fail(why);
      sp.end();
    }
    pending.clear();
  };
  dial({
    message: (frame) => {
      answered(frame);
      if (!gone) ws.send(frame);
    },
    closed: (reason) => {
      gone = true;
      log(`door closed: ${redact(reason)} session=${session}`);
      abandon("door closed");
      ws.close(1011, "door closed");
    },
  }).then(
    (socket) => {
      if (gone) {
        socket.close();
        return;
      }
      up = socket;
      for (const f of queue.splice(0)) socket.send(f);
    },
    (e: unknown) => {
      gone = true;
      log(`door unreachable: ${redact(e instanceof Error ? e.message : String(e))} session=${session}`);
      abandon("door unreachable");
      ws.close(1011, "door unreachable");
    },
  );
  ws.on("close", () => {
    gone = true;
    abandon("client left");
    up?.close();
  });
  ws.on("message", (data, binary) => {
    if (binary) {
      ws.close(1003, "text frames only");
      return;
    }
    let frame: { id?: unknown; method?: unknown; params?: unknown };
    try {
      frame = JSON.parse(data.toString()) as typeof frame;
    } catch {
      ws.close(1007, "not JSON");
      return;
    }
    if (typeof frame !== "object" || frame === null || Array.isArray(frame)) {
      ws.close(1007, "not a JSON-RPC object");
      return;
    }
    if (typeof frame.method !== "string" || !allowed.has(frame.method)) {
      const name = typeof frame.method === "string" ? frame.method : "a frame without a method";
      refuse(ws, frame.id ?? null, `gateway: ${name} is not allowed`);
      return;
    }
    const field = forbiddenField(frame.method, frame.params);
    if (field !== undefined) {
      refuse(ws, frame.id ?? null, `gateway: ${frame.method} may not carry ${field}; the gateway passes only the fields a plain call needs (no form patch on qua or fork, no outfit, seat, study or abdication)`);
      return;
    }
    const params = frame.params as { figaro_id?: unknown; traceparent?: unknown } | null | undefined;
    const asked = params?.traceparent;
    if (asked !== undefined && (typeof asked !== "string" || !parseTraceparent(asked))) {
      refuse(ws, frame.id ?? null, `gateway: ${frame.method} traceparent must be a W3C traceparent, 00-<32 hex>-<16 hex>-<2 hex>`);
      return;
    }
    const aria = params?.figaro_id;
    const shownAria = typeof aria === "string" && loggedAria.test(aria) ? aria : noSession;
    log(`door: call method=${frame.method} aria=${shownAria} session=${session}`);
    if (frame.method === "figaro.interrupt" && typeof aria === "string") hub?.cancel(aria, "interrupt");
    if (frame.id !== undefined && tracer.recording) {
      const sp = tracer.start(`door ${frame.method}`, typeof asked === "string" ? asked : undefined, { "rpc.method": frame.method, "figaro.aria": shownAria, "figchat.session": session });
      const key = JSON.stringify(frame.id);
      pending.get(key)?.end();
      pending.delete(key);
      if (pending.size >= maxPending) {
        const [oldest, stale] = pending.entries().next().value as [string, Span];
        stale.fail("no answer before the pending cap");
        stale.end();
        pending.delete(oldest);
      }
      pending.set(key, sp);
      if (params && (frame.method === "figaro.qua" || asked !== undefined)) params.traceparent = sp.traceparent;
      if (frame.method === "figaro.qua" && typeof aria === "string") hub?.noteTrace(aria, sp.context);
    }
    const text = JSON.stringify(frame);
    if (up) up.send(text);
    else queue.push(text);
  });
}
