import type { Dial, Socket } from "figaro-forms";
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

function refuse(ws: WebSocket, id: unknown, message: string): void {
  ws.send(JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32020, message } }));
}

export function proxyDoor(ws: WebSocket, dial: Dial, hub: AudioHub | undefined): void {
  const queue: string[] = [];
  let up: Socket | undefined;
  let gone = false;
  dial({
    message: (frame) => {
      if (!gone) ws.send(frame);
    },
    closed: (reason) => {
      gone = true;
      ws.close(1011, `door: ${reason}`.slice(0, 120));
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
      ws.close(1011, `door unreachable: ${e instanceof Error ? e.message : String(e)}`.slice(0, 120));
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
    if (frame.method === "figaro.interrupt") {
      const aria = (frame.params as { figaro_id?: unknown } | null | undefined)?.figaro_id;
      if (typeof aria === "string") hub?.cancel(aria, "interrupt");
    }
    const text = JSON.stringify(frame);
    if (up) up.send(text);
    else queue.push(text);
  });
}
