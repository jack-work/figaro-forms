import { mkdtempSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocketServer, type WebSocket } from "ws";

export interface SpeechCall {
  readonly url: string;
  readonly frames: Record<string, unknown>[];
  readonly socket: WebSocket;
  closed: boolean;
}

export interface FakeSpeech {
  readonly path: string;
  readonly calls: SpeechCall[];
  pcmPerText: number;
  audioId: string;
  rejectVoice: boolean;
  readonly replays: { url: string; range: string | undefined }[];
  readonly clips: { url: string; contentType: string | undefined; body: Buffer }[];
  sttStatus: number;
  sttReply: unknown;
  stop(): Promise<void>;
}

export const fakePcm = (bytes: number, fill = 1): Buffer => Buffer.alloc(bytes, fill);

export async function startFakeSpeech(): Promise<FakeSpeech> {
  const path = join(mkdtempSync(join(tmpdir(), "ffs-")), "speech.sock");
  const calls: SpeechCall[] = [];
  const server = createServer();
  const ws = new WebSocketServer({ noServer: true });
  const fake: FakeSpeech = { path, calls, pcmPerText: 480, audioId: "a-1", rejectVoice: false, replays: [], clips: [], sttStatus: 200, sttReply: { text: "hello figaro", duration_ms: 1200, audio_id: "clip-1" }, stop: () => new Promise((ok) => { for (const c of calls) c.socket.terminate(); server.close(() => ok()); server.closeAllConnections(); }) };
  server.on("request", (req, res) => {
    if (req.method === "POST" && req.url?.startsWith("/stt")) {
      const parts: Buffer[] = [];
      req.on("data", (c: Buffer) => parts.push(c));
      req.on("end", () => {
        fake.clips.push({ url: req.url ?? "", contentType: req.headers["content-type"], body: Buffer.concat(parts) });
        res.writeHead(fake.sttStatus, { "Content-Type": "application/json" }).end(JSON.stringify(fake.sttReply));
      });
      return;
    }
    fake.replays.push({ url: req.url ?? "", range: req.headers.range });
    if (req.url?.startsWith("/audio/key/") && !req.url.includes("missing")) res.writeHead(200, { "Content-Type": "audio/mpeg", "Content-Length": 7 }).end("MP3DATA");
    else res.writeHead(404).end();
  });
  server.on("upgrade", (req, sock, head) => {
    const url = req.url ?? "";
    if (fake.rejectVoice && url.includes("voice=")) {
      sock.end("HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
      return;
    }
    ws.handleUpgrade(req, sock, head, (socket) => {
      const call: SpeechCall = { url, frames: [], socket, closed: false };
      calls.push(call);
      socket.on("close", () => (call.closed = true));
      socket.on("message", (data) => {
        const f = JSON.parse(data.toString()) as Record<string, unknown>;
        call.frames.push(f);
        if (typeof f.text === "string" && fake.pcmPerText > 0) socket.send(fakePcm(fake.pcmPerText));
        if (f.end === true) {
          socket.send(JSON.stringify({ audio_id: fake.audioId }));
          socket.close();
        }
      });
    });
  });
  await new Promise<void>((ok) => server.listen(path, ok));
  return fake;
}
