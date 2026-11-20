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

export function proxyDoor(ws: WebSocket, dial: Dial, hub: AudioHub | undefined, log: (line: string) => void = () => {}): void {
  const queue: string[] = [];
  let up: Socket | undefined;
  let gone = false;
  dial({
    message: (frame) => {
      if (!gone) ws.send(frame);
    },
    closed: (reason) => {
      gone = true;
      log(`door closed: ${redact(reason)}`);
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
      log(`door unreachable: ${redact(e instanceof Error ? e.message : String(e))}`);
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
    if (frame.method === "figaro.interrupt") {
      const aria = (frame.params as { figaro_id?: unknown } | null | undefined)?.figaro_id;
      if (typeof aria === "string") hub?.cancel(aria, "interrupt");
    }
    const text = JSON.stringify(frame);
    if (up) up.send(text);
    else queue.push(text);
  });
}
