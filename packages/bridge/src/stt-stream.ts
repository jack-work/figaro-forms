import type { IncomingMessage } from "node:http";
import WebSocket from "ws";

export interface SttStreamLimits {
  readonly idleMs?: number;
  readonly maxStreamMs?: number;
  readonly maxStreamBytes?: number;
}

export const ariaParam = /^([a-z0-9-]{1,63})\/[0-9a-f]{32}$/;
const langParam = /^[a-z]{2,3}(-[A-Z]{2})?$/;
const maxFrameBytes = 6400;
const maxHeldBytes = 64000;

type Code = "bad-request" | "busy" | "idle" | "too-long" | "speech" | "unreachable";

export function attendSttStream(
  o: SttStreamLimits & { readonly socket: string; readonly store: string; readonly log?: (line: string) => void },
  ws: WebSocket,
  req: IncomingMessage,
  admit: () => (() => void) | undefined,
): void {
  const log = o.log ?? (() => {});
  const q = new URL(req.url ?? "/", "http://gateway").searchParams;
  const aria = ariaParam.exec(q.get("aria") ?? "");
  const lang = q.get("lang") ?? "en-US";
  const refuse = (code: Code, text: string, close: number): void => {
    ws.send(JSON.stringify({ type: "error", code, text }));
    ws.close(close);
  };
  if (!aria || aria[1] !== o.store) return refuse("bad-request", `aria must be ${o.store}/<32 hex>`, 1008);
  if (!langParam.test(lang)) return refuse("bad-request", "lang must look like en-US", 1008);
  const release = admit();
  if (!release) return refuse("busy", "too many clips in flight", 1011);

  const started = Date.now();
  const up = new WebSocket(`ws+unix://${o.socket}:/stt/stream?${new URLSearchParams({ lang })}`);
  let ready = false;
  let ended = false;
  let finished = false;
  let total = 0;
  let heldBytes = 0;
  const held: (Buffer | string)[] = [];
  let open = 2;
  const closedOne = (): void => {
    if (--open === 0) release();
  };

  const stopTimers = (): void => {
    clearTimeout(idle);
    clearTimeout(longest);
  };
  const drop = (): void => {
    stopTimers();
    up.removeAllListeners("message");
    up.terminate();
  };
  const fail = (code: Code, text: string, close = 1011): void => {
    if (finished) return;
    finished = true;
    log(`stt stream: ${code} after ${Date.now() - started} ms, ${total} bytes: ${text}`);
    drop();
    if (ws.readyState === ws.OPEN) refuse(code, text, close);
  };
  const toSpeech = (f: Buffer | string): void => {
    if (ready) up.send(f, { binary: Buffer.isBuffer(f) });
    else held.push(f);
  };

  let idle = setTimeout(() => fail("idle", "no audio"), o.idleMs ?? 10_000);
  const longest = setTimeout(() => fail("too-long", "session over its time limit"), o.maxStreamMs ?? 5 * 60_000);

  up.on("message", (data, binary) => {
    if (finished || binary) return;
    const text = data.toString();
    let type: unknown;
    try {
      type = (JSON.parse(text) as { type?: unknown }).type;
    } catch {
      return fail("speech", "speech sent a frame that is not JSON");
    }
    if (type === "ready" && !ready) {
      ready = true;
      ws.send(text);
      for (const f of held.splice(0)) up.send(f, { binary: Buffer.isBuffer(f) });
      heldBytes = 0;
      return;
    }
    if (type === "done" || type === "error") finished = true;
    if (type === "done") stopTimers();
    ws.send(text);
  });
  up.once("error", (e) => fail("unreachable", `speech unreachable: ${e.message}`));
  up.once("close", (code) => {
    closedOne();
    stopTimers();
    if (ws.readyState !== ws.OPEN) return;
    if (finished) {
      ws.close(code === 1000 ? 1000 : 1011);
      return;
    }
    fail("speech", "speech closed the stream before done");
  });

  ws.on("message", (data, binary) => {
    if (finished) return;
    const b = Buffer.isBuffer(data) ? data : Buffer.concat(data as Buffer[]);
    if (binary) {
      if (ended) return fail("bad-request", "audio after end", 1008);
      if (b.length === 0 || b.length % 2 !== 0 || b.length > maxFrameBytes) return fail("bad-request", `audio frames are 2 to ${maxFrameBytes} bytes of s16le`, 1008);
      total += b.length;
      if (total > (o.maxStreamBytes ?? 9_600_000)) return fail("too-long", "session over its byte limit");
      clearTimeout(idle);
      idle = setTimeout(() => fail("idle", "no audio"), o.idleMs ?? 10_000);
      if (!ready) {
        heldBytes += b.length;
        if (heldBytes > maxHeldBytes) return fail("unreachable", "speech not ready within 2 s of audio");
      }
      toSpeech(b);
      return;
    }
    let type: unknown;
    try {
      type = (JSON.parse(b.toString()) as { type?: unknown }).type;
    } catch {
      return fail("bad-request", "text frames are JSON", 1008);
    }
    if (type === "end" && !ended) {
      ended = true;
      clearTimeout(idle);
      toSpeech(JSON.stringify({ type: "end" }));
    } else if (type === "cancel") {
      finished = true;
      log(`stt stream: cancelled after ${Date.now() - started} ms, ${total} bytes`);
      stopTimers();
      if (ready) {
        up.send(JSON.stringify({ type: "cancel" }));
        up.close(1000);
      } else up.terminate();
      ws.close(1000);
    } else fail("bad-request", "text frames are {type:end} or {type:cancel}", 1008);
  });
  ws.once("close", () => {
    closedOne();
    if (finished) return;
    finished = true;
    log(`stt stream: client left after ${Date.now() - started} ms, ${total} bytes`);
    stopTimers();
    if (ready && up.readyState === up.OPEN) {
      up.send(JSON.stringify({ type: "cancel" }));
      up.close(1000);
    } else up.terminate();
  });
}
