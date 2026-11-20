import { request } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { startGateway, type Gateway } from "../src/gateway.js";
import { speechOverSocket } from "../src/speech.js";
import { sttRoute } from "../src/stt.js";
import { FakeAria } from "../../figaro-forms/test/aria/fake-aria.js";
import { startFakeSpeech, type FakeSpeech } from "./fake-speech.js";

const secret = "s".repeat(40);
const aria = "gluck/0123456789abcdef0123456789abcdef";
const headers = { "x-figaro-edge": secret, "remote-user": "gluck" };
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

async function rig(maxBytes?: number): Promise<{ speech: FakeSpeech; port: number }> {
  const speech = await startFakeSpeech();
  cleanups.push(() => speech.stop());
  const gw: Gateway = await startGateway({
    listen: { port: 0 },
    edge: { secret, admin: "gluck", peers: ["127.0.0.1"] },
    door: () => new FakeAria().dial,
    speech: speechOverSocket(speech.path),
    speechSocket: speech.path,
    store: "gluck",
    routes: sttRoute({ socket: speech.path, store: "gluck", ...(maxBytes ? { maxBytes } : {}) }),
  });
  cleanups.push(() => gw.close());
  const addr = gw.server.address();
  return { speech, port: typeof addr === "object" && addr ? addr.port : 0 };
}

interface Reply {
  status: number;
  body: Record<string, unknown>;
}

const json = (text: string): Record<string, unknown> => {
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return { text };
  }
};

function post(port: number, query: string, type: string | undefined, body: Buffer, extra: Record<string, string> = {}): Promise<Reply> {
  return new Promise((ok, fail) => {
    const req = request({ port, host: "127.0.0.1", method: "POST", path: `/stt${query}`, headers: { ...headers, ...(type ? { "content-type": type } : {}), ...extra } }, (res) => {
      const parts: Buffer[] = [];
      res.on("data", (c: Buffer) => parts.push(c));
      res.on("end", () => ok({ status: res.statusCode ?? 0, body: json(Buffer.concat(parts).toString()) }));
    });
    req.on("error", fail);
    req.end(body);
  });
}

describe("POST /stt", () => {
  it.each(["audio/webm;codecs=opus", "audio/mp4"])("passes a %s clip to speech and answers its text", async (type) => {
    const { speech, port } = await rig();
    const clip = Buffer.from("not really audio");
    const r = await post(port, `?aria=${encodeURIComponent(aria)}`, type, clip);
    expect(r).toEqual({ status: 200, body: { text: "hello figaro", duration_ms: 1200, audio_id: "clip-1" } });
    expect(speech.clips).toHaveLength(1);
    expect(speech.clips[0]?.contentType).toBe(type);
    expect(speech.clips[0]?.body.equals(clip)).toBe(true);
  });

  it("refuses any other type with 415 and never reaches speech", async () => {
    const { speech, port } = await rig();
    for (const type of ["audio/ogg", "audio/wav", "text/plain", undefined]) {
      const r = await post(port, `?aria=${aria}`, type, Buffer.from("x"));
      expect(r.status).toBe(415);
      expect(typeof r.body.error).toBe("string");
    }
    expect(speech.clips).toHaveLength(0);
  });

  it("refuses a malformed or foreign aria with 400", async () => {
    const { speech, port } = await rig();
    for (const q of ["", "?aria=nope", "?aria=other/0123456789abcdef0123456789abcdef"]) {
      expect((await post(port, q, "audio/webm", Buffer.from("x"))).status).toBe(400);
    }
    expect(speech.clips).toHaveLength(0);
  });

  it("answers 413 for a declared length over the limit", async () => {
    const { speech, port } = await rig(1024);
    const r = await post(port, `?aria=${aria}`, "audio/webm", Buffer.alloc(2048, 1));
    expect(r.status).toBe(413);
    expect(speech.clips).toHaveLength(0);
  });

  it("stops reading a chunked body at the limit and answers 413", async () => {
    const { speech, port } = await rig(1024);
    const r = await new Promise<Reply>((ok, fail) => {
      const req = request({ port, host: "127.0.0.1", method: "POST", path: `/stt?aria=${aria}`, headers: { ...headers, "content-type": "audio/mp4", "transfer-encoding": "chunked" } }, (res) => {
        const parts: Buffer[] = [];
        res.on("data", (c: Buffer) => parts.push(c));
        res.on("end", () => ok({ status: res.statusCode ?? 0, body: JSON.parse(Buffer.concat(parts).toString()) as Record<string, unknown> }));
      });
      req.on("error", (e) => (req.destroyed && (e as NodeJS.ErrnoException).code === "ECONNRESET" ? undefined : fail(e)));
      for (let i = 0; i < 8; i++) req.write(Buffer.alloc(512, 2));
      setTimeout(() => req.end(), 50);
    });
    expect(r.status).toBe(413);
    expect(speech.clips).toHaveLength(0);
  });

  it.each([
    ["speech errors", 502, { error: "transcription failed", audio_id: "x" }, "transcription failed"],
    ["speech is busy", 503, { error: "speech busy" }, "speech busy"],
    ["speech answers without text", 200, { nope: true }, "speech answered without text, duration_ms and audio_id"],
  ])("answers 502 with an error when %s", async (_name, status, reply, error) => {
    const { speech, port } = await rig();
    speech.sttStatus = status;
    speech.sttReply = reply;
    const r = await post(port, `?aria=${aria}`, "audio/webm", Buffer.from("x"));
    expect(r).toEqual({ status: 502, body: { error } });
  });

  it("answers 502 when the speech socket is gone", async () => {
    const { speech, port } = await rig();
    await speech.stop();
    const r = await post(port, `?aria=${aria}`, "audio/webm", Buffer.from("x"));
    expect(r.status).toBe(502);
    expect(String(r.body.error)).toContain("speech unreachable");
  });

  it("is behind the edge gate and takes POST only", async () => {
    const { port } = await rig();
    const r = await post(port, `?aria=${aria}`, "audio/webm", Buffer.from("x"), { "x-figaro-edge": "w".repeat(40) });
    expect(r.status).toBe(403);
    const get = await new Promise<number>((ok, fail) => request({ port, host: "127.0.0.1", path: "/stt", headers }, (res) => { res.resume(); ok(res.statusCode ?? 0); }).on("error", fail).end());
    expect(get).toBe(405);
  });
});
