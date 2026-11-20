import { request, type IncomingMessage, type ServerResponse } from "node:http";
import type { GatewayRoute } from "./gateway.js";

export const maxClipBytes = 10 * 1024 * 1024;

export interface SttOptions {
  readonly socket: string;
  readonly store: string;
  readonly maxBytes?: number;
  readonly timeoutMs?: number;
  readonly maxConcurrent?: number;
}

const clipTypes = new Set(["audio/webm", "audio/mp4"]);
const ariaParam = /^([a-z0-9-]{1,63})\/[0-9a-f]{32}$/;

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

function transcribe(o: SttOptions, clip: Buffer, contentType: string): Promise<{ status: number; body: Record<string, unknown> }> {
  return new Promise((ok) => {
    const bad = (error: string): void => ok({ status: 502, body: { error } });
    const up = request(
      {
        socketPath: o.socket,
        path: "/stt",
        method: "POST",
        headers: { "Content-Type": contentType, "Content-Length": clip.length },
        timeout: o.timeoutMs ?? 60_000,
      },
      (r) => {
        const parts: Buffer[] = [];
        r.on("data", (c: Buffer) => parts.push(c));
        r.once("end", () => {
          let j: Record<string, unknown> = {};
          try {
            j = JSON.parse(Buffer.concat(parts).toString()) as Record<string, unknown>;
          } catch {
            bad("speech answered with something other than JSON");
            return;
          }
          if (r.statusCode !== 200) {
            bad(typeof j.error === "string" ? j.error : `speech answered ${r.statusCode}`);
            return;
          }
          if (typeof j.text !== "string" || typeof j.duration_ms !== "number" || typeof j.audio_id !== "string") {
            bad("speech answered without text, duration_ms and audio_id");
            return;
          }
          ok({ status: 200, body: { text: j.text, duration_ms: j.duration_ms, audio_id: j.audio_id } });
        });
        r.once("error", (e) => bad(e.message));
      },
    );
    up.once("timeout", () => up.destroy(new Error("speech timed out")));
    up.once("error", (e) => bad(`speech unreachable: ${e.message}`));
    up.end(clip);
  });
}

export function sttRoute(o: SttOptions): GatewayRoute {
  const limit = o.maxBytes ?? maxClipBytes;
  let running = 0;
  return (req, res, path) => {
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
    if (running >= (o.maxConcurrent ?? 4)) {
      reply(req, res, 503, { error: "too many clips in flight" });
      return true;
    }
    running++;
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
      const r = await transcribe(o, clip, type);
      reply(req, res, r.status, r.body);
    })().finally(() => running--);
    return true;
  };
}
