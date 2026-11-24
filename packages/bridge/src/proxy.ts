import type { Dial, Socket } from "figaro-forms";
import type { WebSocket } from "ws";
import type { AudioHub } from "./audio.js";
import { noTracer, parseTraceparent, type Span, type Tracer } from "./trace.js";
import { fold, type AttachStore } from "./attach.js";
import { audioIdPattern } from "./dictation.js";
import { allowed, forbiddenField, queueDispositions } from "./methods.js";
import { noSession } from "./session.js";

const loggedAria = /^@?[A-Za-z0-9_-]{1,64}$/;
const maxPending = 1024;

function refuse(ws: WebSocket, id: unknown, message: string): void {
  ws.send(JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32020, message } }));
}

export function redact(text: string): string {
  return text.replace(/(\w+:\/\/)[^@/\s]*@/g, "$1").replace(/\?[^\s"')]*/g, "");
}

export function proxyUpstream(ws: WebSocket, dial: Dial, hub: AudioHub | undefined, log: (line: string) => void = () => {}, session: string = noSession, tracer: Tracer = noTracer, attachments?: AttachStore, maxFrame: number = 1 << 20): void {
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
      try {
        for (const f of queue.splice(0)) socket.send(f);
      } catch (e) {
        log(`door send failed: ${redact(e instanceof Error ? e.message : String(e))} session=${session}`);
        gone = true;
        ws.close(1011, "door closed");
      }
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
    const size = Buffer.isBuffer(data) ? data.length : Array.isArray(data) ? data.reduce((n, b) => n + b.length, 0) : data.byteLength;
    if (size > maxFrame) {
      const head = (Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer)).subarray(0, 256).toString();
      const at = /"id"\s*:\s*(-?\d{1,15}|"[^"\\]{0,64}")/.exec(head)?.[1];
      log(`door: frame of ${size} bytes refused, over ${maxFrame} session=${session}`);
      refuse(ws, at === undefined ? null : JSON.parse(at), `gateway: a message over ${maxFrame} bytes is refused (this one is ${size} bytes); send it in smaller parts`);
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
    const params = frame.params as { figaro_id?: unknown; traceparent?: unknown; queue?: unknown } | null | undefined;
    if (frame.method === "figaro.interrupt" && !queueDispositions.has(params?.queue)) {
      refuse(ws, frame.id ?? null, `gateway: figaro.interrupt queue must be "keep" or "clear"`);
      return;
    }
    if (params && "dictation" in params) {
      const d = (params as { dictation?: unknown }).dictation;
      if (typeof d !== "string" || !audioIdPattern.test(d)) {
        refuse(ws, frame.id ?? null, "gateway: dictation is the audio_id a /stt/stream done gave");
        return;
      }
      delete (params as { dictation?: unknown }).dictation;
    }
    const asked = params?.traceparent;
    if (asked !== undefined && (typeof asked !== "string" || !parseTraceparent(asked))) {
      refuse(ws, frame.id ?? null, `gateway: ${frame.method} traceparent must be a W3C traceparent, 00-<32 hex>-<16 hex>-<2 hex>`);
      return;
    }
    let attached = 0;
    const named = (params as { attachments?: unknown } | null | undefined)?.attachments;
    if (named !== undefined && params) {
      const q = params as { attachments?: unknown; text?: unknown; images?: unknown };
      if (!attachments) {
        refuse(ws, frame.id ?? null, "gateway: this gateway takes no attachments");
        return;
      }
      if (!Array.isArray(named) || named.length === 0 || named.length > 8 || !named.every((n) => typeof n === "string")) {
        refuse(ws, frame.id ?? null, "gateway: attachments is a list of 1 to 8 ids from POST /attach");
        return;
      }
      if (typeof q.text !== "string" || q.text.trim() === "") {
        refuse(ws, frame.id ?? null, "gateway: an attachment is sent with a prompt: give text too");
        return;
      }
      const inline = Array.isArray(q.images) ? q.images.length : 0;
      const held = attachments.take(named as string[], inline);
      if (typeof held === "string") {
        refuse(ws, frame.id ?? null, `gateway: ${held}`);
        return;
      }
      const f = fold(q.text, held);
      q.text = f.text;
      if (f.images.length > 0) q.images = [...(Array.isArray(q.images) ? q.images : []), ...f.images];
      delete q.attachments;
      attached = held.length;
    }
    const aria = params?.figaro_id;
    const shownAria = typeof aria === "string" && loggedAria.test(aria) ? aria : noSession;
    log(`door: call method=${frame.method} aria=${shownAria}${attached > 0 ? ` attachments=${attached}` : ""} session=${session}`);
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
    if (!up) {
      queue.push(text);
      return;
    }
    try {
      up.send(text);
    } catch (e) {
      log(`door send failed: ${redact(e instanceof Error ? e.message : String(e))} session=${session}`);
      gone = true;
      ws.close(1011, "door closed");
    }
  });
}
