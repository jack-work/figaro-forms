import { mkdtempSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocketServer, type WebSocket } from "ws";

export interface SpeechCall {
  readonly url: string;
  readonly frames: Record<string, unknown>[];
  readonly socket: WebSocket;
  readonly session: string | undefined;
  readonly traceparent?: string | undefined;
  closed: boolean;
}

export interface PaceOptions {
  readonly seed?: number;
  readonly sliceMs?: number;
  readonly jitterMs?: number;
  readonly stallProbability?: number;
  readonly stallMs?: readonly [number, number];
  readonly slowStartMs?: number;
}

export interface PacedSend {
  readonly at: number;
  readonly bytes: number;
  readonly offset: number;
}

export interface PacedStall {
  readonly at: number;
  readonly ms: number;
  readonly offset: number;
}

export interface PacedLog {
  readonly sends: PacedSend[];
  readonly stalls: PacedStall[];
  readonly starves: PacedStall[];
  startedAt: number;
}

export const fakePcmFormat = { rate: 24000, bits: 16, channels: 1 } as const;

export const pcmBytesPerMs = (fakePcmFormat.rate * fakePcmFormat.channels * (fakePcmFormat.bits / 8)) / 1000;

export const seeded = (seed: number): (() => number) => {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

export interface FakeSpeech {
  readonly path: string;
  readonly calls: SpeechCall[];
  pcmPerText: number;
  pace: PaceOptions | undefined;
  readonly paced: PacedLog[];
  audioId: string;
  rejectVoice: boolean;
  holdUrl: string | undefined;
  readonly replays: { url: string; range: string | undefined; session?: string | undefined }[];
  readonly clips: { url: string; contentType: string | undefined; body: Buffer; session?: string | undefined; traceparent?: string | undefined }[];
  readonly lookups: (string | undefined)[];
  streamAudioId: string;
  readonly attached: { audioId: string; key: string }[];
  sttStatus: number;
  readonly keyed: Record<string, string>;
  sttReply: unknown;
  readonly streams: SttStreamCall[];
  streamReady: boolean;
  streamFailAfter: number | undefined;
  stop(): Promise<void>;
}

export interface SttStreamCall {
  readonly url: string;
  readonly audio: Buffer[];
  readonly frames: Record<string, unknown>[];
  readonly socket: WebSocket;
  readonly session: string | undefined;
  closed: boolean;
}

export const streamWords = ["hello", "figaro", "how", "are", "you"];

export const fakePcm = (bytes: number, fill = 1): Buffer => Buffer.alloc(bytes, fill);

export async function startFakeSpeech(): Promise<FakeSpeech> {
  const path = join(mkdtempSync(join(tmpdir(), "ffs-")), "speech.sock");
  const calls: SpeechCall[] = [];
  const server = createServer();
  const ws = new WebSocketServer({ noServer: true });
  const fake: FakeSpeech = { path, calls, pcmPerText: 480, pace: undefined, paced: [], audioId: "a-1", rejectVoice: false, holdUrl: undefined, replays: [], clips: [], lookups: [], streamAudioId: "clip-2", attached: [], sttStatus: 200, keyed: {}, sttReply: { text: "hello figaro", duration_ms: 1200, audio_id: "clip-1" }, streams: [], streamReady: true, streamFailAfter: undefined, stop: () => new Promise((ok) => { for (const c of [...calls, ...fake.streams]) c.socket.terminate(); server.close(() => ok()); server.closeAllConnections(); }) };
  server.on("request", (req, res) => {
    const session = typeof req.headers["x-figchat-session"] === "string" ? req.headers["x-figchat-session"] : undefined;
    const attach = req.method === "POST" ? /^\/audio\/([^/?]+)\/key\?key=(.+)$/.exec(req.url ?? "") : null;
    if (attach) {
      fake.attached.push({ audioId: decodeURIComponent(attach[1]!), key: decodeURIComponent(attach[2]!) });
      fake.keyed[decodeURIComponent(attach[2]!)] = decodeURIComponent(attach[1]!);
      res.writeHead(200, { "Content-Type": "application/json" }).end("{}");
      return;
    }
    if (req.method === "POST" && req.url === "/audio/keys") {
      fake.lookups.push(session);
      const parts: Buffer[] = [];
      req.on("data", (c: Buffer) => parts.push(c));
      req.on("end", () => {
        const { keys } = JSON.parse(Buffer.concat(parts).toString()) as { keys: string[] };
        const out = Object.fromEntries(keys.filter((k) => fake.keyed[k] !== undefined).map((k) => [k, fake.keyed[k]]));
        res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(out));
      });
      return;
    }
    if (req.method === "POST" && req.url?.startsWith("/stt")) {
      const parts: Buffer[] = [];
      req.on("data", (c: Buffer) => parts.push(c));
      req.on("end", () => {
        fake.clips.push({ url: req.url ?? "", contentType: req.headers["content-type"], body: Buffer.concat(parts), ...(session !== undefined ? { session } : {}), ...(typeof req.headers.traceparent === "string" ? { traceparent: req.headers.traceparent } : {}) });
        res.writeHead(fake.sttStatus, { "Content-Type": "application/json" }).end(JSON.stringify(fake.sttReply));
      });
      return;
    }
    fake.replays.push({ url: req.url ?? "", range: req.headers.range, ...(session !== undefined ? { session } : {}) });
    if (req.url?.startsWith("/audio/key/") && !req.url.includes("missing")) res.writeHead(200, { "Content-Type": "audio/mpeg", "Content-Length": 7 }).end("MP3DATA");
    else res.writeHead(404).end();
  });
  server.on("upgrade", (req, sock, head) => {
    const url = req.url ?? "";
    if (fake.rejectVoice && url.includes("voice=")) {
      sock.end("HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
      return;
    }
    if (url.startsWith("/stt/stream")) {
      ws.handleUpgrade(req, sock, head, (socket) => answerStream(fake, url, socket, typeof req.headers["x-figchat-session"] === "string" ? req.headers["x-figchat-session"] : undefined));
      return;
    }
    ws.handleUpgrade(req, sock, head, (socket) => {
      const header = req.headers["x-figchat-session"];
      const call: SpeechCall = { url, frames: [], socket, session: typeof header === "string" ? header : undefined, traceparent: typeof req.headers.traceparent === "string" ? req.headers.traceparent : undefined, closed: false };
      calls.push(call);
      socket.on("close", () => (call.closed = true));
      const pacer = fake.pace ? startPacer(fake, socket, fake.pace) : undefined;
      socket.on("message", (data) => {
        const f = JSON.parse(data.toString()) as Record<string, unknown>;
        call.frames.push(f);
        const holding = f.end === true && fake.holdUrl && url.includes(fake.holdUrl);
        if (pacer) {
          if (typeof f.text === "string" && fake.pcmPerText > 0) pacer.push(fakePcm(fake.pcmPerText));
          if (f.end === true && !holding) pacer.finish(() => { socket.send(JSON.stringify({ audio_id: fake.audioId })); socket.close(); });
          return;
        }
        if (typeof f.text === "string" && fake.pcmPerText > 0) socket.send(fakePcm(fake.pcmPerText));
        if (f.end === true && !holding) {
          socket.send(JSON.stringify({ audio_id: fake.audioId }));
          socket.close();
        }
      });
    });
  });
  await new Promise<void>((ok) => server.listen(path, ok));
  return fake;
}

function answerStream(fake: FakeSpeech, url: string, socket: WebSocket, session: string | undefined): void {
  const call: SttStreamCall = { url, audio: [], frames: [], socket, session, closed: false };
  fake.streams.push(call);
  socket.on("close", () => (call.closed = true));
  if (fake.streamReady) socket.send(JSON.stringify({ type: "ready" }));
  const send = (f: Record<string, unknown>): void => socket.send(JSON.stringify(f));
  socket.on("message", (data, binary) => {
    if (binary) {
      call.audio.push(data as Buffer);
      const n = call.audio.length;
      if (fake.streamFailAfter !== undefined && n >= fake.streamFailAfter) {
        send({ type: "error", code: "speech", text: "recognition failed" });
        socket.close(1011);
        return;
      }
      send({ type: "partial", text: streamWords.slice(0, Math.min(n, streamWords.length)).join(" "), offset_ms: 0 });
      return;
    }
    const f = JSON.parse(data.toString()) as Record<string, unknown>;
    call.frames.push(f);
    if (f.type === "cancel") socket.close(1000);
    if (f.type === "end") {
      const text = streamWords.slice(0, Math.min(call.audio.length, streamWords.length)).join(" ");
      const bytes = call.audio.reduce((a, b) => a + b.length, 0);
      send({ type: "final", text, offset_ms: 0, duration_ms: bytes / 32 });
      send({ type: "done", audio_id: fake.streamAudioId, duration_ms: bytes / 32, text });
      socket.close(1000);
    }
  });
}

function startPacer(fake: FakeSpeech, socket: WebSocket, opts: PaceOptions): { push(pcm: Buffer): void; finish(done: () => void): void } {
  const rand = seeded(opts.seed ?? 1);
  const sliceBytes = Math.round((opts.sliceMs ?? 20) * pcmBytesPerMs);
  const log: PacedLog = { sends: [], stalls: [], starves: [], startedAt: Date.now() };
  fake.paced.push(log);
  let queue = Buffer.alloc(0);
  let offset = 0;
  let idealMs = 0;
  let first = true;
  let running = false;
  let finishing: (() => void) | undefined;
  const between = (lo: number, hi: number): number => lo + rand() * (hi - lo);
  const pump = (): void => {
    if (socket.readyState !== socket.OPEN) return;
    if (queue.length === 0) {
      running = false;
      if (finishing) { const done = finishing; finishing = undefined; done(); }
      return;
    }
    const slice = queue.subarray(0, sliceBytes);
    queue = queue.subarray(slice.length);
    let stall = 0;
    if (opts.stallProbability && rand() < opts.stallProbability) {
      const [lo, hi] = opts.stallMs ?? [300, 1500];
      stall = Math.round(between(lo, hi));
      log.stalls.push({ at: Date.now() - log.startedAt, ms: stall, offset });
    }
    idealMs += stall;
    const jitter = opts.jitterMs ? Math.round(between(0, opts.jitterMs)) : 0;
    const wait = Math.max(0, log.startedAt + idealMs + jitter - Date.now());
    setTimeout(() => {
      if (socket.readyState !== socket.OPEN) return;
      log.sends.push({ at: Date.now() - log.startedAt, bytes: slice.length, offset });
      offset += slice.length;
      socket.send(Buffer.from(slice));
      idealMs += slice.length / pcmBytesPerMs;
      pump();
    }, wait);
  };
  return {
    push(pcm) {
      if (queue.length === 0 && !running) {
        const now = Date.now() - log.startedAt;
        if (!first && now > idealMs) log.starves.push({ at: now, ms: now - idealMs, offset });
        idealMs = Math.max(idealMs, now);
      }
      if (first) { first = false; idealMs += opts.slowStartMs ?? 0; }
      queue = Buffer.concat([queue, pcm]);
      if (!running) { running = true; pump(); }
    },
    finish(done) {
      if (!running) done();
      else finishing = done;
    },
  };
}
