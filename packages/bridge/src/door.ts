import type { Dial, Socket } from "figaro-forms";
import type { Credential } from "figaro-forms/auth";
import type { WebSocket } from "ws";
import type { AudioHub } from "./audio.js";

export const gatewayMethods = [
  "angelus.hello",
  "figaro.follow",
  "figaro.unfollow",
  "figaro.form",
  "figaro.read",
  "figaro.qua",
  "figaro.interrupt",
  "figaro.fork",
  "figaro.list",
] as const;

const allowed: ReadonlySet<string> = new Set(gatewayMethods);

const permitted: Readonly<Record<string, ReadonlySet<string>>> = {
  "figaro.qua": new Set(["figaro_id", "text", "images"]),
  "figaro.fork": new Set(["figaro_id", "at_turn", "at_lt"]),
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

export function proxyDoor(ws: WebSocket, dial: Dial, hub: AudioHub | undefined, log: (line: string) => void = () => {}, session: string = noSession): void {
  const queue: string[] = [];
  let up: Socket | undefined;
  let gone = false;
  dial({
    message: (frame) => {
      if (!gone) ws.send(frame);
    },
    closed: (reason) => {
      gone = true;
      log(`door closed: ${redact(reason)} session=${session}`);
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
      ws.close(1011, "door unreachable");
    },
  );
  ws.on("close", () => {
    gone = true;
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
      refuse(ws, frame.id ?? null, `gateway: ${frame.method} may not carry ${field}; the gateway passes no form patch, outfit, seat, study or abdication`);
      return;
    }
    const aria = (frame.params as { figaro_id?: unknown } | null | undefined)?.figaro_id;
    log(`door: call method=${frame.method} aria=${typeof aria === "string" && loggedAria.test(aria) ? aria : noSession} session=${session}`);
    if (frame.method === "figaro.interrupt" && typeof aria === "string") hub?.cancel(aria, "interrupt");
    const text = JSON.stringify(frame);
    if (up) up.send(text);
    else queue.push(text);
  });
}
