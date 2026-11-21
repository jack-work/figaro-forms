import { request, type IncomingMessage, type ServerResponse } from "node:http";
import type { GatewayRoute, GatewaySocket } from "./gateway.js";
import { noSession, sessionHeader, sessionOf } from "./door.js";
import { parseTraceparent } from "./trace.js";
import type { Dictations } from "./dictation.js";
import { ariaParam, attendSttStream, type SttStreamLimits } from "./stt-stream.js";

export const maxClipBytes = 10 * 1024 * 1024;

export interface SttOptions extends SttStreamLimits {
  readonly socket: string;
  readonly store: string;
  readonly maxBytes?: number;
  readonly timeoutMs?: number;
  readonly maxConcurrent?: number;
  readonly log?: (line: string) => void;
  readonly gate?: () => Promise<string | undefined>;
  readonly dictations?: Dictations;
}

const clipTypes = new Set(["audio/webm", "audio/mp4"]);

const looksLike = (type: string, clip: Buffer): boolean =>
  type === "audio/webm" ? clip.length >= 4 && clip.readUInt32BE(0) === 0x1a45dfa3 : clip.length >= 8 && clip.toString("latin1", 4, 8) === "ftyp";

const mediaType = (header: string | undefined): string => (header ?? "").split(";")[0]?.trim().toLowerCase() ?? "";

function reply(req: IncomingMessage, res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(text),
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    ...(req.readableEnded ? {} : { Connection: "close" }),
  });
  res.end(text, () => {
    if (!req.readableEnded) req.destroy();
  });
}

function readClip(req: IncomingMessage, limit: number): Promise<Buffer | "too-large"> {
  return new Promise((ok, fail) => {
    const parts: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > limit) {
        req.pause();
        req.removeAllListeners("data");
        ok("too-large");
        return;
      }
      parts.push(c);
    });
    req.once("end", () => ok(Buffer.concat(parts)));
    req.once("error", fail);
    req.once("close", () => {
      if (!req.complete) fail(new Error("client went away"));
    });
  });
}

interface SpeechAnswer {
  readonly status: number;
  readonly json: Record<string, unknown> | undefined;
  readonly error?: string;
}

async function callSpeech(o: SttOptions, path: string, body: Buffer, contentType: string, session: string = noSession, traceparent?: string): Promise<SpeechAnswer> {
  const refused = o.gate ? await o.gate() : undefined;
  if (refused !== undefined) return { status: 0, json: undefined, error: refused };
  return new Promise((ok) => {
    const up = request(
      {
        socketPath: o.socket,
        path,
        method: "POST",
        headers: { "Content-Type": contentType, "Content-Length": body.length, ...(session !== noSession ? { [sessionHeader]: session } : {}), ...(traceparent ? { traceparent } : {}) },
        timeout: o.timeoutMs ?? 60_000,
      },
      (r) => {
        const parts: Buffer[] = [];
        r.on("data", (c: Buffer) => parts.push(c));
        r.once("end", () => {
          try {
            ok({ status: r.statusCode ?? 0, json: JSON.parse(Buffer.concat(parts).toString()) as Record<string, unknown> });
          } catch {
            ok({ status: r.statusCode ?? 0, json: undefined });
          }
        });
        r.once("error", (e) => ok({ status: 0, json: undefined, error: e.message }));
      },
    );
    up.once("timeout", () => up.destroy(new Error("speech timed out")));
    up.once("error", (e) => ok({ status: 0, json: undefined, error: `speech unreachable: ${e.message}` }));
    up.end(body);
  });
}

const traceparentOf = (req: IncomingMessage): string | undefined => {
  const tp = req.headers.traceparent;
  return typeof tp === "string" && parseTraceparent(tp) ? tp : undefined;
};

type Outcome = { status: number; body: Record<string, unknown> };

export async function keyStored(o: SttOptions, key: string, session: string = noSession): Promise<boolean> {
  const found = await callSpeech(o, "/audio/keys", Buffer.from(JSON.stringify({ keys: [key] })), "application/json", session);
  return speechFailure(found) === undefined && typeof found.json![key] === "string";
}

function speechFailure(a: SpeechAnswer): Outcome | undefined {
  if (a.error !== undefined) return { status: 502, body: { error: a.error } };
  if (a.json === undefined) return { status: 502, body: { error: "speech answered with something other than JSON" } };
  if (a.status !== 200) return { status: 502, body: { error: typeof a.json.error === "string" ? a.json.error : `speech answered ${a.status}` } };
  return undefined;
}

function transcription(j: Record<string, unknown>, audioId: unknown): Outcome {
  if (typeof j.text !== "string" || typeof j.duration_ms !== "number" || typeof audioId !== "string") {
    return { status: 502, body: { error: "speech answered without text, duration_ms and audio_id" } };
  }
  return { status: 200, body: { text: j.text, duration_ms: j.duration_ms, audio_id: audioId } };
}

async function transcribe(o: SttOptions, clip: Buffer, contentType: string, session: string, traceparent: string | undefined): Promise<Outcome> {
  const a = await callSpeech(o, "/stt", clip, contentType, session, traceparent);
  return speechFailure(a) ?? transcription(a.json!, a.json!.audio_id);
}

const clipKey = /^([a-z0-9-]{1,63})\/[0-9a-f]{32}:\d{1,20}\/in$/;
const audioId = /^[0-9]{6}-[0-9a-f]{16}$/;

async function retranscribe(o: SttOptions, key: string, session: string, traceparent: string | undefined): Promise<Outcome> {
  const found = await callSpeech(o, "/audio/keys", Buffer.from(JSON.stringify({ keys: [key] })), "application/json", session, traceparent);
  const lookupFailed = speechFailure(found);
  if (lookupFailed) return lookupFailed;
  const id = found.json![key];
  if (typeof id !== "string" || !audioId.test(id)) return { status: 404, body: { error: "no clip under that key" } };
  const a = await callSpeech(o, `/stt/${encodeURIComponent(id)}`, Buffer.alloc(0), "application/octet-stream", session, traceparent);
  if (a.error === undefined && a.status === 404) return { status: 404, body: { error: "no clip under that key" } };
  if (a.error === undefined && a.status === 409) return { status: 409, body: { error: "the key names a reply, not a clip" } };
  return speechFailure(a) ?? transcription(a.json!, id);
}

function keyRoute(o: SttOptions, req: IncomingMessage, res: ServerResponse, raw: string, admit: () => (() => void) | undefined): void {
  if (req.method !== "POST") {
    res.writeHead(405, { Allow: "POST" }).end();
    return;
  }
  let key: string;
  try {
    key = decodeURIComponent(raw);
  } catch {
    reply(req, res, 400, { error: "key is not URL-encoded text" });
    return;
  }
  const m = clipKey.exec(key);
  if (!m || m[1] !== o.store) {
    reply(req, res, 400, { error: `key must be ${o.store}/<32 hex>:<turn>/in` });
    return;
  }
  const done = admit();
  if (!done) {
    reply(req, res, 503, { error: "too many clips in flight" });
    return;
  }
  void retranscribe(o, key, sessionOf(req, false), traceparentOf(req))
    .then((r) => reply(req, res, r.status, r.body))
    .finally(done);
}

export function stt(o: SttOptions): { routes: GatewayRoute; sockets: GatewaySocket } {
  const limit = o.maxBytes ?? maxClipBytes;
  let running = 0;
  const max = o.maxConcurrent ?? 4;
  const admit = (): (() => void) | undefined => {
    if (running >= max) return undefined;
    running++;
    return () => void running--;
  };
  const sockets: GatewaySocket = (path) => (path === "/stt/stream" ? (ws, req) => attendSttStream(o, ws, req, admit) : undefined);
  const routes: GatewayRoute = (req, res, path) => {
    if (path.startsWith("/stt/key/")) {
      keyRoute(o, req, res, path.slice("/stt/key/".length), admit);
      return true;
    }
    if (path !== "/stt") return false;
    if (req.method !== "POST") {
      res.writeHead(405, { Allow: "POST" }).end();
      return true;
    }
    const aria = ariaParam.exec(new URL(req.url ?? "/", "http://gateway").searchParams.get("aria") ?? "");
    if (!aria || aria[1] !== o.store) {
      reply(req, res, 400, { error: `aria must be ${o.store}/<32 hex>` });
      return true;
    }
    const type = mediaType(req.headers["content-type"]);
    if (!clipTypes.has(type)) {
      reply(req, res, 415, { error: "clip must be audio/webm or audio/mp4" });
      return true;
    }
    const declared = Number(req.headers["content-length"] ?? 0);
    if (declared > limit) {
      reply(req, res, 413, { error: `clip over ${limit} bytes` });
      return true;
    }
    const done = admit();
    if (!done) {
      reply(req, res, 503, { error: "too many clips in flight" });
      return true;
    }
    void (async () => {
      let clip: Buffer | "too-large";
      try {
        clip = await readClip(req, limit);
      } catch {
        return;
      }
      if (clip === "too-large") {
        reply(req, res, 413, { error: `clip over ${limit} bytes` });
        return;
      }
      if (clip.length === 0) {
        reply(req, res, 400, { error: "empty clip" });
        return;
      }
      if (!looksLike(type, clip)) {
        reply(req, res, 415, { error: `the body is not ${type}` });
        return;
      }
      const r = await transcribe(o, clip, type, sessionOf(req, false), traceparentOf(req));
      reply(req, res, r.status, r.body);
    })().finally(done);
    return true;
  };
  return { routes, sockets };
}
